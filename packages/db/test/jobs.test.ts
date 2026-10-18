import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobStore, LOCAL_TENANT, seedLocal } from '../src';
import { ADMIN_URL, freshDatabase } from './helpers';

describe.skipIf(!ADMIN_URL)('job store (Postgres)', () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let store: JobStore;
  let ws: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    ({ workspaceId: ws } = await seedLocal(handle.db));
    store = new JobStore(handle.db);
  });
  afterAll(() => handle?.dispose());

  it('moves queued → running → succeeded and ignores duplicate deliveries', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: { format: 'mermaid' }, createdBy: 'u1' });
    expect(job).toMatchObject({ status: 'queued', progress: 0, attempts: 0 });

    expect(await store.start(LOCAL_TENANT, job.id)).toMatchObject({ status: 'running', attempts: 1 });
    await store.progress(LOCAL_TENANT, job.id, 42.4);
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ progress: 42 });

    const artifact = { key: `jobs/${job.id}/out.mmd`, name: 'default.mmd', type: 'text/plain', bytes: 120 };
    await store.succeed(LOCAL_TENANT, job.id, { characters: 120 }, artifact);
    const done = await store.get(LOCAL_TENANT, job.id);
    expect(done).toMatchObject({ status: 'succeeded', progress: 100, result: { characters: 120 }, artifactKey: artifact.key, artifactBytes: 120 });
    expect(done!.finishedAt).toBeInstanceOf(Date);

    // A redelivered message must not restart or fail a finished job.
    expect(await store.start(LOCAL_TENANT, job.id)).toBeUndefined();
    await store.fail(LOCAL_TENANT, job.id, 'late failure', true);
    expect((await store.get(LOCAL_TENANT, job.id))!.status).toBe('succeeded');
  });

  it('keeps a job running between retries and fails it on the last attempt', async () => {
    const job = await store.create(LOCAL_TENANT, { workspaceId: ws, kind: 'import-tabular', params: {}, createdBy: 'u2' });
    await store.start(LOCAL_TENANT, job.id);
    await store.fail(LOCAL_TENANT, job.id, 'neo4j unavailable', false);
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'running', error: 'neo4j unavailable' });
    expect(await store.start(LOCAL_TENANT, job.id)).toMatchObject({ attempts: 2, error: null });
    await store.fail(LOCAL_TENANT, job.id, 'still unavailable', true);
    expect(await store.get(LOCAL_TENANT, job.id)).toMatchObject({ status: 'failed', error: 'still unavailable' });
  });

  it('lists a workspace newest first, optionally by creator, and scopes by tenant', async () => {
    const mine = await store.list(LOCAL_TENANT, ws, { createdBy: 'u2' });
    expect(mine.map((j) => j.kind)).toEqual(['import-tabular']);
    expect((await store.list(LOCAL_TENANT, ws)).map((j) => j.kind)).toEqual(['import-tabular', 'export']);
    expect(await store.list('t_other', ws)).toEqual([]);
    expect(await store.get('t_other', mine[0]!.id)).toBeUndefined();
  });
});
