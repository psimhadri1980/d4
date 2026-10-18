import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import { CatalogError, LOCAL_TENANT, QueryCatalogStore, schema, seedLocal, type Db } from '../src';
import { ADMIN_URL, freshDatabase } from './helpers';

describe.skipIf(!ADMIN_URL)('query catalog store (Postgres)', () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let db: Db;
  let store: QueryCatalogStore;

  const draft = (cypher: string) => ({
    cypher,
    params: [{ name: 'id', type: 'element' }],
    resultShape: 'table' as const,
    contentHash: `sha256:${cypher.length}`,
  });

  beforeAll(async () => {
    handle = await freshDatabase();
    db = handle.db;
    await seedLocal(db);
    store = new QueryCatalogStore(db);
  });
  afterAll(() => handle?.dispose());

  it('creates entries and versions drafts', async () => {
    const q = await store.create(LOCAL_TENANT, { slug: 'impact', title: 'Impact of retiring a platform', tags: ['impact'] }, 'author-1');
    const v1 = await store.saveDraft(q.id, draft('MATCH (n) RETURN n'), 'author-1');
    expect(v1).toMatchObject({ version: 1, status: 'draft' });
    // Saving again edits the same open draft.
    const v1b = await store.saveDraft(q.id, draft('MATCH (n) RETURN n LIMIT 10'), 'author-1');
    expect(v1b.id).toBe(v1.id);
    expect(v1b.cypher).toContain('LIMIT 10');
  });

  it('runs the review lifecycle and freezes content after draft', async () => {
    const q = (await store.bySlug(LOCAL_TENANT, 'impact'))!;
    const open = (await store.openVersion(q.id))!;
    await store.setStatus(open.id, 'in_review', 'author-1');
    await expect(store.saveDraft(q.id, draft('X'), 'author-1')).rejects.toThrow(CatalogError);

    // Content is immutable once out of draft.
    await expect(
      db.execute(sql`update query_versions set cypher = 'MATCH (n) DETACH DELETE n' where id = ${open.id}`),
    ).rejects.toThrow(/immutable/);

    const published = await store.setStatus(open.id, 'published', 'steward-1', 'looks good');
    expect(published).toMatchObject({ status: 'published', reviewedBy: 'steward-1', reviewNote: 'looks good' });
    expect((await store.latestPublished(q.id))?.version).toBe(1);

    // Skipping states is refused by the database.
    await expect(store.setStatus(open.id, 'retired', 'steward-1')).rejects.toThrow(/cannot move from published to retired/);

    // A new draft becomes version 2; v1 stays published meanwhile.
    const v2 = await store.saveDraft(q.id, draft('MATCH (n:Platform) RETURN n LIMIT 5'), 'author-1');
    expect(v2.version).toBe(2);
    expect((await store.latestPublished(q.id))?.version).toBe(1);
  });

  it('sends a review back to draft with a note', async () => {
    const q = (await store.bySlug(LOCAL_TENANT, 'impact'))!;
    const v2 = (await store.openVersion(q.id))!;
    await store.setStatus(v2.id, 'in_review', 'author-1');
    const back = await store.setStatus(v2.id, 'draft', 'steward-1', 'add a LIMIT');
    expect(back).toMatchObject({ status: 'draft', reviewNote: 'add a LIMIT' });
  });

  it('searches the catalog and filters by grants', async () => {
    const other = await store.create(LOCAL_TENANT, { slug: 'orphans', title: 'Orphan elements', description: 'Elements without relationships' }, 'author-1');
    const impact = (await store.bySlug(LOCAL_TENANT, 'impact'))!;
    await store.setGrants(impact.id, [{ principalType: 'role', principal: 'viewer' }], 'steward-1');

    const all = await store.search(LOCAL_TENANT);
    expect(all.map((q) => q.slug).sort()).toEqual(['impact', 'orphans']);
    expect(all.find((q) => q.slug === 'impact')).toMatchObject({ publishedVersion: 1, openStatus: 'draft' });

    expect((await store.search(LOCAL_TENANT, { text: 'relationships' })).map((q) => q.slug)).toEqual(['orphans']);
    expect((await store.search(LOCAL_TENANT, { tag: 'impact' })).map((q) => q.slug)).toEqual(['impact']);

    // Viewers only see published, granted entries.
    const viewer = await store.search(LOCAL_TENANT, { visibleTo: { roles: ['viewer'], groupIds: [] } });
    expect(viewer.map((q) => q.slug)).toEqual(['impact']);
    expect(await store.search(LOCAL_TENANT, { visibleTo: { roles: ['planner'], groupIds: [] } })).toEqual([]);

    expect(await store.canRun(impact.id, ['viewer'], [])).toBe(true);
    expect(await store.canRun(other.id, ['viewer'], [])).toBe(false);

    const groupId = ulid();
    await store.setGrants(other.id, [{ principalType: 'group', principal: groupId }], 'steward-1');
    expect(await store.canRun(other.id, [], [groupId])).toBe(true);
  });

  it('logs executions', async () => {
    const q = (await store.bySlug(LOCAL_TENANT, 'impact'))!;
    await store.logExecution({
      tenantId: LOCAL_TENANT,
      queryId: q.id,
      version: 1,
      workspaceId: 'ws',
      userId: 'u1',
      params: { id: 'x' },
      status: 'ok',
      rowCount: 3,
      durationMs: 12,
    });
    const log = await store.executions(LOCAL_TENANT, q.id);
    expect(log[0]).toMatchObject({ status: 'ok', rowCount: 3 });
  });

  it('rejects invalid statuses at the database level', async () => {
    await expect(
      db.insert(schema.queryVersions).values({
        id: ulid(),
        queryId: (await store.bySlug(LOCAL_TENANT, 'orphans'))!.id,
        version: 9,
        cypher: 'RETURN 1',
        params: [],
        resultShape: 'table',
        contentHash: 'x',
        status: 'bogus' as never,
        createdBy: 'x',
      }),
    ).rejects.toThrow(/query_versions_status_check/);
  });
});
