import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { BackupStore, createDb, JobStore, LOCAL_TENANT, MetamodelStore, runMigrations, seedLocal, WorkspaceLock, WorkspaceStore, type DbHandle } from '@d4/db';
import type { SessionProvider } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import { Client } from 'pg';
import { MemoryArtifactStore, modelHandles, processJob, type JobDeps } from '../src';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;

/**
 * Backup, verify, restore and rebuild against real Postgres and Neo4j. Everything happens in a
 * workspace created for this test, so the rest of the shared Neo4j database is never touched.
 */
describe.skipIf(!PG || !NEO)('workspace backups (Postgres + Neo4j)', () => {
  const dbName = `d4_backup_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  let driver: Driver;
  let sessions: SessionProvider;
  let reg: MetamodelRegistry;
  let ws: string;
  let deps: JobDeps & { artifacts: MemoryArtifactStore };
  let jobs: JobStore;

  const run = async (kind: 'backup' | 'verify' | 'restore' | 'rebuild', params: Record<string, unknown> = {}) => {
    const job = await jobs.create(LOCAL_TENANT, { workspaceId: ws, kind, params, createdBy: 'admin-1' });
    await processJob({ tenantId: LOCAL_TENANT, jobId: job.id }, deps);
    return (await jobs.get(LOCAL_TENANT, job.id))!;
  };
  const handles = () => modelHandles(handle.db, reg, sessions, LOCAL_TENANT);
  const ctx = () => ({ workspaceId: ws, actor: 'writer-1' });

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
    ws = (await new WorkspaceStore(handle.db).create(LOCAL_TENANT, { slug: `backup-${Date.now()}`, name: 'Backup test', metamodelId })).id;
    reg = await new MetamodelStore(handle.db).registryForWorkspace(LOCAL_TENANT, ws);

    driver = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev'), { disableLosslessIntegers: true });
    sessions = async (mode) => driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
    const s = await sessions('WRITE');
    await applySchema(s, reg);
    await awaitSchemaOnline(s);
    await s.close();
    deps = { db: handle.db, graphs: { sessions: () => sessions }, artifacts: new MemoryArtifactStore() };
    jobs = new JobStore(handle.db);

    // A little history through the normal write path, so every change is in the event log.
    const { service } = handles();
    const dp = await service.createElement(ctx(), { type: 'DataProduct', attrs: { name: 'Client', description: 'first' } });
    const lake = await service.createElement(ctx(), { type: 'DataStore', attrs: { name: 'Lake' } });
    await service.createRelationship(ctx(), { type: 'HOLDS', fromId: lake.id, toId: dp.id, attrs: { role: 'MASTER' } });
    await service.updateElement(ctx(), { id: dp.id, expectedVersion: 1, set: { lifecycle: 'PROPOSED' }, unset: ['description'] });
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

  it('backs up, and verify finds the graph matching the event log', async () => {
    const b = await run('backup');
    expect(b).toMatchObject({ status: 'succeeded', result: { elements: 2, relationships: 1, checksum: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(await new BackupStore(handle.db).list(LOCAL_TENANT, ws)).toHaveLength(1);
    expect((await run('verify')).result).toMatchObject({ matches: true, differences: 0, events: 4 });
  });

  it('finds drift, and rebuild from the event log repairs it', async () => {
    // Damage the graph behind the event log's back.
    await driver.executeQuery("MATCH (n:Element {name: 'Lake'}) WHERE n.workspaceId = $ws DETACH DELETE n", { ws });
    await driver.executeQuery("MATCH (n:Element {name: 'Client'}) WHERE n.workspaceId = $ws SET n.name = 'Tampered'", { ws });
    const drift = (await run('verify')).result as { matches: boolean; differences: number; examples: string[] };
    expect(drift).toMatchObject({ matches: false, differences: 3 });
    expect(drift.examples.join('\n')).toMatch(/missing from the graph/);

    const rebuilt = await run('rebuild');
    expect(rebuilt).toMatchObject({ status: 'succeeded', result: { from: 'events', elements: 2, relationships: 1, eventsReplayed: 4 } });
    expect((await run('verify')).result).toMatchObject({ matches: true });
    // The damaged graph was kept as a safety backup first, and the workspace is unlocked again.
    expect((await new BackupStore(handle.db).list(LOCAL_TENANT, ws)).map((b) => b.reason)).toEqual(['safety', 'manual']);
    expect(await new WorkspaceLock(handle.db).reason(LOCAL_TENANT, ws)).toBeNull();
  });

  it('restores a backup and then replays later changes, so nothing after the backup is lost', async () => {
    const backups = new BackupStore(handle.db);
    const first = (await backups.list(LOCAL_TENANT, ws)).find((b) => b.reason === 'manual')!;
    const { service } = handles();
    await service.createElement(ctx(), { type: 'Application', attrs: { name: 'Added after the backup' } });
    const before = (await run('verify')).result as { checksum: string };

    const restored = await run('restore', { backupId: first.id });
    expect(restored).toMatchObject({ status: 'succeeded', result: { from: { backupId: first.id }, elements: 3, checksum: before.checksum } });
    expect((await run('verify')).result).toMatchObject({ matches: true });
  });

  it('refuses model writes while the workspace is locked, and a second restore at once', async () => {
    const lock = new WorkspaceLock(handle.db);
    await lock.acquire(LOCAL_TENANT, ws, 'being restored from a backup');
    try {
      await expect(handles().service.createElement(ctx(), { type: 'Application', attrs: { name: 'Blocked' } })).rejects.toMatchObject({ code: 'LOCKED' });
      const job = await run('rebuild');
      expect(job).toMatchObject({ status: 'failed', error: 'Another restore or rebuild of this workspace is running' });
    } finally {
      await lock.release(LOCAL_TENANT, ws);
    }
  });

  it('refuses a damaged backup file', async () => {
    const b = (await new BackupStore(handle.db).list(LOCAL_TENANT, ws))[0]!;
    await deps.artifacts.put(b.objectKey, new Uint8Array([1, 2, 3]), 'application/gzip');
    const job = await run('restore', { backupId: b.id });
    expect(job.status).toBe('failed');
  });
});
