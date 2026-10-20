import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { ConnectorStore, createDb, JobStore, LOCAL_TENANT, MetamodelStore, runMigrations, seedLocal, WorkspaceStore, type DbHandle } from '@d4/db';
import type { SessionProvider } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import { Client } from 'pg';
import { MemoryArtifactStore, modelHandles, processJob, type JobDeps } from '../src';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;

/** A CMDB-like source whose contents the test changes between syncs. */
let source: unknown[] = [];
const fakeFetch = (async () => new Response(JSON.stringify({ result: source }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe.skipIf(!PG || !NEO)('connector sync (Postgres + Neo4j)', () => {
  const dbName = `d4_sync_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  let driver: Driver;
  let sessions: SessionProvider;
  let reg: MetamodelRegistry;
  let ws: string;
  let deps: JobDeps;
  let connectorId: string;

  const sync = async (dryRun = false) => {
    const job = await new JobStore(handle.db).create(LOCAL_TENANT, { workspaceId: ws, kind: 'sync', params: { connectorId, dryRun }, createdBy: 'admin-1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    const done = (await new JobStore(handle.db).get(LOCAL_TENANT, job.id))!;
    if (done.status !== 'succeeded') throw new Error(`sync failed: ${done.error}`);
    return done.result as Record<string, any>;
  };
  const byKey = async (key: string) => (await modelHandles(handle.db, reg, sessions, LOCAL_TENANT).queries.snapshot(ws)).elements.find((e) => e.attrs['externalKey'] === key);

  beforeAll(async () => {
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    handle = createDb(url.toString(), 4);
    await runMigrations(handle.db);
    const seeded = await seedLocal(handle.db);
    const metamodelId = (await new WorkspaceStore(handle.db).get(LOCAL_TENANT, seeded.workspaceId))!.metamodelId;
    ws = (await new WorkspaceStore(handle.db).create(LOCAL_TENANT, { slug: `sync-${Date.now()}`, name: 'Sync test', metamodelId })).id;
    reg = await new MetamodelStore(handle.db).registryForWorkspace(LOCAL_TENANT, ws);
    driver = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev'), { disableLosslessIntegers: true });
    sessions = async (mode) => driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
    const s = await sessions('WRITE');
    await applySchema(s, reg);
    await awaitSchemaOnline(s);
    await s.close();
    deps = { db: handle.db, graphs: { sessions: () => sessions }, artifacts: new MemoryArtifactStore(), fetch: fakeFetch, allowPrivateUrls: true };
    connectorId = (
      await new ConnectorStore(handle.db).create(LOCAL_TENANT, {
        workspaceId: ws,
        key: 'cmdb',
        name: 'CMDB',
        kind: 'http-json',
        config: { url: 'https://cmdb.example.com/api/now/table/cmdb_ci' },
        mapping: {
          itemsPath: 'result',
          entities: [
            { when: { path: 'class', equals: 'app' }, type: { value: 'Application' }, id: 'sys_id', name: 'name', attrs: { description: { path: 'desc' } }, relationships: [{ type: 'RUNS_ON', to: 'host' }] },
            { when: { path: 'class', equals: 'platform' }, type: { value: 'Platform' }, id: 'sys_id', name: 'name' },
          ],
        },
        conflictPolicy: 'skip',
        createdBy: 'admin-1',
      })
    ).id;
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

  it('dry run plans without writing; the first sync creates elements and relationships', async () => {
    source = [
      { sys_id: 'a1', class: 'app', name: 'CRM', desc: 'Sales', host: 'p1' },
      { sys_id: 'a2', class: 'app', name: 'Ledger', desc: 'Finance', host: 'p1' },
      { sys_id: 'p1', class: 'platform', name: 'Kubernetes' },
    ];
    const dry = await sync(true);
    expect(dry).toMatchObject({ dryRun: true, applied: false, ok: true, records: 3, elements: { created: 3 }, relationships: { created: 2 } });
    expect(await byKey('cmdb:a1')).toBeUndefined();

    const first = await sync();
    expect(first).toMatchObject({ applied: true, elements: { created: 3 }, relationships: { created: 2 } });
    expect(await byKey('cmdb:a1')).toMatchObject({ type: 'Application', attrs: { name: 'CRM', description: 'Sales' } });
    // Nothing changed: nothing written.
    expect(await sync()).toMatchObject({ applied: false, unchanged: 3, elements: { created: 0, updated: 0 } });
  });

  it('updates from the source, protects D4 edits as conflicts, respects deletions and reports what vanished', async () => {
    const { service } = modelHandles(handle.db, reg, sessions, LOCAL_TENANT);
    const crm = (await byKey('cmdb:a1'))!;
    const ledger = (await byKey('cmdb:a2'))!;
    // A person edits CRM in D4 and deletes Ledger.
    await service.updateElement({ workspaceId: ws, actor: 'architect-1' }, { id: crm.id, expectedVersion: crm.version, set: { description: 'Edited in D4' } });
    await service.deleteElement({ workspaceId: ws, actor: 'architect-1' }, { id: ledger.id, expectedVersion: ledger.version });

    source = [
      { sys_id: 'a1', class: 'app', name: 'CRM', desc: 'Sales and service', host: 'p1' }, // changed in both → conflict
      { sys_id: 'a2', class: 'app', name: 'Ledger', desc: 'Finance v2', host: 'p1' }, // deleted in D4 → not recreated
      { sys_id: 'p1', class: 'platform', name: 'Kubernetes 1.30' }, // changed in the source only → updated
      { sys_id: 'a3', class: 'app', name: 'Payments', host: 'p1' }, // new
    ];
    const r = await sync();
    expect(r).toMatchObject({ applied: true, elements: { created: 1, updated: 1 }, conflicts: { count: 1 }, deletedInD4: { count: 1 } });
    expect(r['conflicts'].items[0]).toMatchObject({ externalKey: 'cmdb:a1', applied: false });
    expect((await byKey('cmdb:a1'))!.attrs['description']).toBe('Edited in D4');
    expect((await byKey('cmdb:p1'))!.attrs['name']).toBe('Kubernetes 1.30');
    expect(await byKey('cmdb:a2')).toBeUndefined();

    // The source drops a3: reported, not deleted.
    source = source.filter((x) => (x as { sys_id: string }).sys_id !== 'a3');
    const gone = await sync();
    expect(gone['missingInSource']).toMatchObject({ count: 1, items: [{ externalKey: 'cmdb:a3' }] });
    expect(await byKey('cmdb:a3')).toBeDefined();

    // Source wins: the conflict is resolved in the source's favour.
    await new ConnectorStore(handle.db).update(LOCAL_TENANT, connectorId, { conflictPolicy: 'source-wins' });
    const wins = await sync();
    expect(wins['conflicts'].items[0]).toMatchObject({ externalKey: 'cmdb:a1', applied: true });
    expect((await byKey('cmdb:a1'))!.attrs['description']).toBe('Sales and service');
  });

  it('syncs model-as-code from a Git branch and records the commit', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'd4-model-repo-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
    const kubernetes = (await byKey('cmdb:p1'))!;
    const write = (desc: string) => {
      writeFileSync(
        join(repo, 'model.yaml'),
        `apiVersion: d4/v1\nkind: Model\nmetadata: { name: payments }\nelements:\n  - { key: pay, type: Application, name: Payments Hub, attrs: { description: ${desc} } }\nrelationships:\n  - { type: RUNS_ON, from: pay, to: ${kubernetes.id} }\n`,
      );
      git('add', '-A');
      git('commit', '-q', '-m', desc);
      return git('rev-parse', 'HEAD');
    };
    try {
      git('init', '-q', '-b', 'main');
      const first = write('v1');
      const gitConnector = await new ConnectorStore(handle.db).create(LOCAL_TENANT, {
        workspaceId: ws,
        key: 'repo',
        name: 'Model repo',
        kind: 'git',
        config: { url: `file://${repo}`, branch: 'main' },
        mapping: {},
        conflictPolicy: 'skip',
        createdBy: 'admin-1',
      });
      const run = async () => {
        const job = await new JobStore(handle.db).create(LOCAL_TENANT, { workspaceId: ws, kind: 'sync', params: { connectorId: gitConnector.id }, createdBy: 'admin-1' });
        await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
        const done = (await new JobStore(handle.db).get(LOCAL_TENANT, job.id))!;
        if (done.status !== 'succeeded') throw new Error(`git sync failed: ${done.error}`);
        return done.result as Record<string, any>;
      };
      // An element id as a relationship end resolves to the existing element.
      expect(await run()).toMatchObject({ applied: true, revision: first, files: ['model.yaml'], elements: { created: 1 }, relationships: { created: 1 }, unresolved: { count: 0 } });
      expect((await byKey('repo:pay'))!.attrs['description']).toBe('v1');
      const second = write('v2');
      expect(await run()).toMatchObject({ revision: second, elements: { updated: 1 } });
      expect((await byKey('repo:pay'))!.attrs['description']).toBe('v2');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('fails the job without retrying when the source refuses', async () => {
    deps = { ...deps, fetch: (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch };
    const job = await new JobStore(handle.db).create(LOCAL_TENANT, { workspaceId: ws, kind: 'sync', params: { connectorId }, createdBy: 'admin-1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps, { made: 0, max: 3 });
    expect(await new JobStore(handle.db).get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'failed', attempts: 1, error: 'https://cmdb.example.com/api/now/table/cmdb_ci answered HTTP 401' });
  });
});
