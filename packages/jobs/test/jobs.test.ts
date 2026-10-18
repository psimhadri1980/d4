import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseModelDocument, toImportInput } from '@d4/codecs';
import { planImport } from '@d4/core';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { createDb, JobStore, LOCAL_TENANT, MetamodelStore, runMigrations, seedLocal, type DbHandle } from '@d4/db';
import { GraphQueries, Neo4jModelRepository, type SessionProvider } from '@d4/graph';
import { Client } from 'pg';
import {
  inputKey,
  JobQueue,
  MemoryArtifactStore,
  processJob,
  S3ArtifactStore,
  startJobWorker,
  type JobDeps,
  type TabularJobInput,
} from '../src';

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
  });

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
