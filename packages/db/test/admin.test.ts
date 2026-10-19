import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_TENANT, MetamodelStore, RoleStore, seedLocal, UserStore, WorkspaceStore } from '../src';
import { ADMIN_URL, freshDatabase } from './helpers';

describe.skipIf(!ADMIN_URL)('tenant administration stores (Postgres)', () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let seeded: { workspaceId: string; metamodelId: string };

  beforeAll(async () => {
    handle = await freshDatabase();
    seeded = await seedLocal(handle.db);
  });
  afterAll(() => handle?.dispose());

  it('creates, renames, archives and restores workspaces on the active metamodel', async () => {
    const mm = await new MetamodelStore(handle.db).activeId(LOCAL_TENANT);
    expect(mm).toBe(seeded.metamodelId);
    const store = new WorkspaceStore(handle.db);
    const ws = await store.create(LOCAL_TENANT, { slug: 'retail', name: 'Retail', metamodelId: mm! });
    expect((await store.update(LOCAL_TENANT, ws.id, { name: 'Retail Banking', description: 'Retail division' }))).toMatchObject({ name: 'Retail Banking' });
    await store.setArchived(LOCAL_TENANT, ws.id, true);
    expect((await store.list(LOCAL_TENANT)).map((w) => w.slug)).not.toContain('retail');
    expect((await store.listAll(LOCAL_TENANT)).find((w) => w.slug === 'retail')!.archivedAt).toBeInstanceOf(Date);
    await store.setArchived(LOCAL_TENANT, ws.id, false);
    expect((await store.list(LOCAL_TENANT)).map((w) => w.slug)).toContain('retail');
  });

  it('lists bindings per workspace and tenant-wide, and users', async () => {
    const u = await new UserStore(handle.db).upsertFromToken(LOCAL_TENANT, { subject: 'adm-1', email: 'adm@example.test' });
    const roles = new RoleStore(handle.db);
    await roles.grant(LOCAL_TENANT, { principalType: 'user', principalId: u.id, role: 'planner', workspaceId: seeded.workspaceId }, 'admin');
    await roles.grant(LOCAL_TENANT, { principalType: 'user', principalId: u.id, role: 'viewer' }, 'admin');
    expect((await roles.bindings(LOCAL_TENANT, seeded.workspaceId)).map((b) => b.role)).toEqual(['planner']);
    expect((await roles.bindings(LOCAL_TENANT, null)).map((b) => b.role)).toEqual(['viewer']);
    expect((await new UserStore(handle.db).list(LOCAL_TENANT)).map((x) => x.email)).toContain('adm@example.test');
  });
});
