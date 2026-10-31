import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseModelDocument, toImportInput } from '@d4/codecs';
import { planImport } from '@d4/core';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { createDb, JobStore, LOCAL_TENANT, MetamodelStore, runMigrations, schema, ScheduleStore, seedLocal, UserStore, type DbHandle } from '@d4/db';
import { GraphQueries, Neo4jModelRepository, type SessionProvider } from '@d4/graph';
import { Client } from 'pg';
import { inputKey, JOB_HANDLERS, processJob, pruneArtifacts, runDueSchedules, type JobDeps, type TabularJobInput } from '../src';
import { JobQueue, MemoryArtifactStore, MemoryMailer, S3ArtifactStore, startJobWorker } from '@d4/infra';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;
const REDIS = process.env.D4_TEST_REDIS_URL;
const S3 = process.env.D4_TEST_S3_ENDPOINT;
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');

describe.skipIf(!PG || !NEO)('job processing (Postgres + Neo4j)', () => {
  const dbName = `d4_jobs_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  let driver: Driver;
  let sessions: SessionProvider;
  let ws: string;
  let deps: JobDeps & { artifacts: MemoryArtifactStore };
  let store: JobStore;

  beforeAll(async () => {
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    handle = createDb(url.toString(), 4);
    await runMigrations(handle.db);
    ({ workspaceId: ws } = await seedLocal(handle.db));

    driver = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev'), { disableLosslessIntegers: true });
    sessions = async (mode) => driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
    const reg = await new MetamodelStore(handle.db).registryForWorkspace(LOCAL_TENANT, ws);
    const s = await sessions('WRITE');
    await applySchema(s, reg);
    await awaitSchemaOnline(s);
    await s.close();
    // The seeded workspace id is new for this database, so its graph starts empty.
    const plan = planImport(reg, { workspaceId: ws, actor: 'tester' }, toImportInput(parseModelDocument(readFileSync(SAMPLE, 'utf8'))), { elements: [], relationships: [] });
    await new Neo4jModelRepository(reg, sessions, { withEvents: async (_e, w) => w() }).apply(ws, plan.change!);

    deps = { db: handle.db, graphs: { sessions: () => sessions }, artifacts: new MemoryArtifactStore() };
    store = new JobStore(handle.db);
    // Database, schema and sample import: slower than a unit test, especially on a busy machine.
  }, 60_000);

  afterAll(async () => {
    if (driver) {
      await driver.executeQuery('MATCH (n:Element) WHERE n.workspaceId = $ws DETACH DELETE n', { ws });
      await driver.close();
    }
    if (handle) await handle.close();
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  });

  it('runs an export job and stores the file', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid', asOf: '2027-08-01' }, createdBy: 'u1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    const done = await store.get(LOCAL_TENANT, job.id);
    expect(done).toMatchObject({ status: 'succeeded', progress: 100, artifactName: 'default-2027-08-01.mmd', artifactType: 'text/plain; charset=utf-8' });
    expect(done!.result).toMatchObject({ format: 'mermaid' });
    const text = new TextDecoder().decode(await deps.artifacts.get(done!.artifactKey!));
    expect(text).toContain('flowchart LR');
    expect(text).toContain('Client Master');
  });

  it('runs only the kinds a process is given (the renderer: render)', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid' }, createdBy: 'u1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps, { made: 0, max: 3 }, { render: JOB_HANDLERS.render });
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'failed', error: 'This process does not run export jobs', attempts: 1 });
  });

  it('fails at once on a validation problem, without retrying', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid', scenario: 'nope' }, createdBy: 'u1' });
    await expect(processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps, { made: 0, max: 3 })).resolves.toBeUndefined();
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'failed', error: "Scenario 'nope' not found", attempts: 1 });
  });

  it('retries transient failures and fails on the last attempt', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'yaml' }, createdBy: 'u1' });
    const broken: JobDeps = { ...deps, graphs: { sessions: () => async () => Promise.reject(new Error('Neo4j unavailable')) } };
    await expect(processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, broken, { made: 0, max: 2 })).rejects.toThrow('Neo4j unavailable');
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'running', error: 'Neo4j unavailable' });
    await expect(processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, broken, { made: 1, max: 2 })).resolves.toBeUndefined();
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'failed', attempts: 2 });
    // Delivered again after finishing: nothing happens.
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    expect((await store.get(LOCAL_TENANT, job.id))!.status).toBe('failed');
  });

  it('runs a spreadsheet import job as the user who created it', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'import-tabular', params: { dryRun: false }, createdBy: 'importer-7' });
    const input: TabularJobInput = {
      files: [{ name: 'Platforms.csv', content: Buffer.from('Name,platformType\nJob Kafka,streaming\n').toString('base64') }],
      mappings: [],
    };
    await deps.artifacts.put(inputKey(job.id), JSON.stringify(input), 'application/json');
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    const done = await store.get(LOCAL_TENANT, job.id);
    expect(done).toMatchObject({ status: 'succeeded', result: { ok: true, applied: true, elements: { created: 1 } } });
    const reg = await new MetamodelStore(handle.db).registryForWorkspace(LOCAL_TENANT, ws);
    const [kafka] = (await new GraphQueries(reg, sessions).listElements(ws, { search: 'job kafka' })).items;
    expect(kafka).toMatchObject({ type: 'Platform', createdBy: 'importer-7', attrs: { name: 'Job Kafka', platformType: 'streaming' } });
  });

  it('renders a roadmap as SVG, and PNG/PDF through the rasterizer', async () => {
    const reg = await new MetamodelStore(handle.db).registryForWorkspace(LOCAL_TENANT, ws);
    const [init] = (await new GraphQueries(reg, sessions).listElements(ws, { types: ['Initiative'] })).items;
    const svgJob = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'render', params: { target: 'roadmap', format: 'svg', scope: [init!.id] }, createdBy: 'u1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: svgJob.id }, deps);
    const svg = await store.get(LOCAL_TENANT, svgJob.id);
    expect(svg).toMatchObject({ status: 'succeeded', artifactName: 'roadmap-client-data-consolidation.svg', artifactType: 'image/svg+xml' });
    expect(new TextDecoder().decode(await deps.artifacts.get(svg!.artifactKey!))).toMatch(/^<\?xml[\s\S]*<svg[\s\S]*Migrate client master/);

    const pages: { html: string; format: string; width: number }[] = [];
    const withChrome: JobDeps = { ...deps, rasterize: async (html, o) => (pages.push({ html, format: o.format, width: o.width }), new Uint8Array([0x25, 0x50, 0x44, 0x46])) };
    const [client] = (await new GraphQueries(reg, sessions).listElements(ws, { search: 'client master', types: ['DataProduct'] })).items;
    const pdfJob = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'render', params: { target: 'graph', format: 'pdf', root: client!.id, asOf: '2027-08-01' }, createdBy: 'u1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: pdfJob.id }, withChrome);
    expect(await store.get(LOCAL_TENANT, pdfJob.id)).toMatchObject({ status: 'succeeded', artifactName: 'client-master-2027-08-01.pdf', artifactType: 'application/pdf', artifactBytes: 4 });
    expect(pages).toEqual([expect.objectContaining({ format: 'pdf', width: 1123 })]);
    expect(pages[0]!.html).toContain('<svg');

    // Sent to a worker without Chromium: fails at once instead of retrying.
    const misrouted = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'render', params: { target: 'graph', format: 'png', root: client!.id }, createdBy: 'u1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: misrouted.id }, deps, { made: 0, max: 3 });
    expect(await store.get(LOCAL_TENANT, misrouted.id)).toMatchObject({ status: 'failed', error: 'PNG and PDF renders need the renderer service' });
  });

  it('a scheduler tick starts due reports as their owner, on the right queue', async () => {
    const schedules = new ScheduleStore(handle.db);
    const due = await schedules.create(LOCAL_TENANT, {
      workspaceId: ws,
      name: 'Weekly picture',
      kind: 'render',
      params: { target: 'graph', format: 'svg', root: 'x' },
      useRunDate: true,
      cadence: { frequency: 'weekly', hour: 6, weekday: 1 },
      nextRunAt: new Date('2027-01-11T06:00:00Z'),
      createdBy: 'owner-5',
    });
    const sent: { queue: string; jobId: string }[] = [];
    const queues = {
      jobs: { enqueue: async (m: { jobId: string }) => void sent.push({ queue: 'jobs', jobId: m.jobId }) },
      render: { enqueue: async (m: { jobId: string }) => void sent.push({ queue: 'render', jobId: m.jobId }) },
    };
    const now = new Date('2027-01-11T06:00:20Z');
    const started = await runDueSchedules(handle.db, queues, now);
    expect(started).toHaveLength(1);
    expect(sent).toEqual([{ queue: 'render', jobId: started[0] }]);
    expect(await store.get(LOCAL_TENANT, started[0]!)).toMatchObject({
      kind: 'render',
      createdBy: 'owner-5',
      scheduleId: due.id,
      params: { target: 'graph', format: 'svg', root: 'x', asOf: '2027-01-11' },
    });
    expect(await schedules.get(LOCAL_TENANT, due.id)).toMatchObject({ lastJobId: started[0], nextRunAt: new Date('2027-01-18T06:00:00Z') });
    expect(await runDueSchedules(handle.db, queues, now)).toEqual([]);
    await schedules.remove(LOCAL_TENANT, due.id);
  });

  it('scheduled runs: delivered by email as their owner, paused when the owner lost access', async () => {
    const owner = await new UserStore(handle.db).upsertFromToken(LOCAL_TENANT, { subject: 'mail-owner', email: 'o@example.test', roles: ['viewer'] });
    const nobody = await new UserStore(handle.db).upsertFromToken(LOCAL_TENANT, { subject: 'mail-gone', roles: [] });
    const schedules = new ScheduleStore(handle.db);
    const make = (createdBy: string) =>
      schedules.create(LOCAL_TENANT, {
        workspaceId: ws,
        name: 'Daily model',
        kind: 'export',
        params: { format: 'mermaid' },
        useRunDate: false,
        cadence: { frequency: 'daily', hour: 6 },
        nextRunAt: new Date('2030-01-01T06:00:00Z'),
        createdBy,
        recipients: ['a@example.test', 'b@example.test'],
      });
    const mailer = new MemoryMailer();
    const withMail: JobDeps = { ...deps, mailer, appUrl: 'https://d4.example.test/' };

    const ok = await make(owner.id);
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid' }, createdBy: owner.id, scheduleId: ok.id });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, withMail);
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'succeeded', result: { delivery: { status: 'sent', recipients: 2, attached: true } } });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({ to: ['a@example.test', 'b@example.test'], subject: expect.stringMatching(/^Daily model \(\d{4}-\d{2}-\d{2}\)$/) });
    expect(mailer.sent[0]!.text).toContain(`https://d4.example.test/w/${ws}/reports`);
    expect(new TextDecoder().decode(mailer.sent[0]!.attachments![0]!.content)).toContain('flowchart LR');

    // Without a mailer the run still succeeds and says why nothing was sent.
    const quiet = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid' }, createdBy: owner.id, scheduleId: ok.id });
    await processJob({ tenantId: LOCAL_TENANT, jobId: quiet.id }, deps);
    expect((await store.get(LOCAL_TENANT, quiet.id))!.result).toMatchObject({ delivery: { status: 'skipped' } });

    const lost = await make(nobody.id);
    const denied = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid' }, createdBy: nobody.id, scheduleId: lost.id });
    await processJob({ tenantId: LOCAL_TENANT, jobId: denied.id }, withMail, { made: 0, max: 3 });
    expect(await store.get(LOCAL_TENANT, denied.id)).toMatchObject({ status: 'failed', error: 'Not run: the owner no longer has access to the workspace' });
    expect(await schedules.get(LOCAL_TENANT, lost.id)).toMatchObject({ enabled: false, pausedReason: 'Paused: the owner no longer has access to the workspace' });
    expect(mailer.sent).toHaveLength(1);
    await schedules.remove(LOCAL_TENANT, ok.id);
    await schedules.remove(LOCAL_TENANT, lost.id);
  });

  it('deletes import uploads when the import ends, and prunes old files', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'import-tabular', params: { dryRun: true }, createdBy: 'u1' });
    const input: TabularJobInput = { files: [{ name: 'p.csv', content: Buffer.from('Name,platformType\nUpload Gone,x\n').toString('base64') }], mappings: [] };
    await deps.artifacts.put(inputKey(job.id), JSON.stringify(input), 'application/json');
    await store.setArtifact(LOCAL_TENANT, job.id, { key: inputKey(job.id), name: 'input.json', type: 'application/json', bytes: 1 });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    expect(deps.artifacts.objects.has(inputKey(job.id))).toBe(false);
    expect((await store.get(LOCAL_TENANT, job.id))!.artifactKey).toBeNull();

    const withFiles = async () => (await handle.db.select().from(schema.jobs)).filter((j) => j.artifactKey);
    const files = await withFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(await pruneArtifacts(handle.db, deps.artifacts, new Date('2000-01-01'))).toBe(0);
    const removed = await pruneArtifacts(handle.db, deps.artifacts, new Date(Date.now() + 60_000));
    expect(removed).toBe(files.length);
    expect(await withFiles()).toEqual([]);
    for (const j of files) expect(deps.artifacts.objects.has(j.artifactKey!)).toBe(false);
    const anyExport = (await store.list(LOCAL_TENANT, ws, { createdBy: 'u1' })).find((j) => j.kind === 'export' && j.status === 'succeeded')!;
    expect(anyExport).toMatchObject({ artifactKey: null, result: expect.objectContaining({ artifactExpired: true }) });
  });

  it.skipIf(!REDIS)('goes through the Redis queue to a worker', async () => {
    const name = `d4-jobs-test-${Date.now()}`;
    const queue = new JobQueue(REDIS!, name);
    const worker = startJobWorker(REDIS!, (msg, attempt) => processJob(msg, deps, attempt), { queue: name });
    try {
      const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'elements-csv' }, createdBy: 'u1' });
      await queue.enqueue({ tenantId: LOCAL_TENANT, jobId: job.id });
      await queue.enqueue({ tenantId: LOCAL_TENANT, jobId: job.id }); // same id: no second run
      for (let i = 0; i < 100 && (await store.get(LOCAL_TENANT, job.id))!.status !== 'succeeded'; i++) await new Promise((r) => setTimeout(r, 100));
      expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'succeeded', attempts: 1, artifactName: 'default.elements.csv' });
    } finally {
      await worker.close();
      await queue.obliterate();
      await queue.close();
    }
  });
});

describe.skipIf(!S3)('S3 artefact store', () => {
  it('puts and gets objects, creating the bucket when missing', async () => {
    const store = new S3ArtifactStore({ endpoint: S3!, accessKey: 'd4', secretKey: 'd4-local-dev', bucket: 'd4-test-artifacts' });
    const key = `test/${Date.now()}.txt`;
    expect(await store.put(key, 'héllo', 'text/plain')).toBe(6);
    expect(new TextDecoder().decode(await store.get(key))).toBe('héllo');
    await expect(store.get('test/missing')).rejects.toThrow();
    store.close();
  });
});
