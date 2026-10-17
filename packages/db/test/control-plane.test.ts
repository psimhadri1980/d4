import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ulid, type DomainEvent } from '@d4/core';
import { loadStarterMetamodel } from '@d4/metamodel';
import {
  EventStore,
  LOCAL_TENANT,
  MetamodelStore,
  RoleStore,
  schema,
  seedLocal,
  TenantStore,
  UserStore,
  WorkspaceStore,
  type Db,
} from '../src';
import { ADMIN_URL, freshDatabase } from './helpers';

describe.skipIf(!ADMIN_URL)('control plane (Postgres)', () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let db: Db;
  let workspaceId: string;

  beforeAll(async () => {
    handle = await freshDatabase();
    db = handle.db;
    ({ workspaceId } = await seedLocal(db));
  });
  afterAll(() => handle?.dispose());

  it('seeds idempotently', async () => {
    const again = await seedLocal(db);
    expect(again.workspaceId).toBe(workspaceId);
    expect(await new TenantStore(db).readyDbInstance(LOCAL_TENANT)).toMatchObject({
      boltUri: 'bolt://neo4j:7687',
    });
  });

  it('serves the workspace metamodel as a registry', async () => {
    const reg = await new MetamodelStore(db).registryForWorkspace(LOCAL_TENANT, workspaceId);
    expect(reg.nodeType('DataProduct')?.layer).toBe('Data');
  });

  it('refuses to reuse a metamodel version with different content', async () => {
    const changed = { ...loadStarterMetamodel(), description: 'edited' };
    await expect(new MetamodelStore(db).register(LOCAL_TENANT, changed, 'test')).rejects.toThrow(
      /different content/,
    );
  });

  it('activating a new version retires the old one', async () => {
    const store = new MetamodelStore(db);
    const v2 = await store.register(LOCAL_TENANT, { ...loadStarterMetamodel(), version: '0.2.0' }, 'test');
    await store.activate(LOCAL_TENANT, v2);
    const rows = await db
      .select({ version: schema.metamodels.version, status: schema.metamodels.status })
      .from(schema.metamodels);
    expect(rows).toEqual(
      expect.arrayContaining([
        { version: '0.1.0', status: 'retired' },
        { version: '0.2.0', status: 'active' },
      ]),
    );
  });

  it('provisions users just-in-time and resolves roles via groups and workspaces', async () => {
    const users = new UserStore(db);
    const u = await users.upsertFromToken(LOCAL_TENANT, { subject: 'sub-1', email: 'a@x.test' });
    const again = await users.upsertFromToken(LOCAL_TENANT, { subject: 'sub-1', email: 'b@x.test' });
    expect(again.id).toBe(u.id);
    expect(again.email).toBe('b@x.test');

    const groupId = ulid();
    await db.insert(schema.groups).values({ id: groupId, tenantId: LOCAL_TENANT, name: 'Architects' });
    await db.insert(schema.groupMembers).values({ groupId, userId: u.id });

    const roles = new RoleStore(db);
    await roles.grant(LOCAL_TENANT, { principalType: 'user', principalId: u.id, role: 'viewer' }, 'test');
    await roles.grant(
      LOCAL_TENANT,
      { principalType: 'group', principalId: groupId, role: 'architect', workspaceId },
      'test',
    );
    // Duplicate grants are ignored.
    await roles.grant(LOCAL_TENANT, { principalType: 'user', principalId: u.id, role: 'viewer' }, 'test');

    expect(await roles.effectiveRoles(LOCAL_TENANT, u.id)).toEqual(['viewer']);
    expect(await roles.effectiveRoles(LOCAL_TENANT, u.id, workspaceId)).toEqual(['architect', 'viewer']);

    await roles.revoke(LOCAL_TENANT, { principalType: 'user', principalId: u.id, role: 'viewer' });
    expect(await roles.effectiveRoles(LOCAL_TENANT, u.id, workspaceId)).toEqual(['architect']);
  });

  it('rejects unknown roles at the database level', async () => {
    await expect(
      db.execute(
        sql`insert into role_bindings (id, tenant_id, principal_type, principal_id, role, created_by)
            values (${ulid()}, ${LOCAL_TENANT}, 'user', 'x', 'superuser', 'test')`,
      ),
    ).rejects.toThrow(/role_bindings_role_check/);
  });

  it('lists workspaces per tenant', async () => {
    const list = await new WorkspaceStore(db).list(LOCAL_TENANT);
    expect(list.map((w) => w.slug)).toContain('default');
  });

  describe('event log', () => {
    const event = (subjectId: string, version: number): DomainEvent => ({
      id: ulid(),
      type: version === 1 ? 'ElementCreated' : 'ElementUpdated',
      workspaceId: 'ws',
      actor: 'u1',
      occurredAt: new Date().toISOString(),
      subjectId,
      version,
      data: { n: version },
    });

    it('appends, reads history and streams in order', async () => {
      const store = new EventStore(db);
      await store.append(LOCAL_TENANT, [event('el-1', 1), event('el-1', 2), event('el-2', 1)]);
      const history = await store.forSubject(LOCAL_TENANT, 'el-1');
      expect(history.map((e) => e.version)).toEqual([1, 2]);
      const stream = await store.stream(LOCAL_TENANT, 'ws');
      expect(stream.map((e) => e.subjectId)).toEqual(['el-1', 'el-1', 'el-2']);
      expect((await store.stream(LOCAL_TENANT, 'ws', stream[1]!.seq)).length).toBe(1);
    });

    it('supports the outbox: unpublished → published once', async () => {
      const store = new EventStore(db);
      const pending = await store.unpublished();
      expect(pending.length).toBeGreaterThan(0);
      await store.markPublished(pending.map((e) => e.seq));
      expect(await store.unpublished()).toEqual([]);
      await expect(store.markPublished([pending[0]!.seq])).rejects.toThrow(/already set/);
    });

    it('is append-only', async () => {
      await expect(db.execute(sql`update events set actor = 'mallory'`)).rejects.toThrow(/immutable/);
      await expect(db.execute(sql`delete from events`)).rejects.toThrow(/append-only/);
      await expect(db.execute(sql`truncate events`)).rejects.toThrow(/append-only/);
    });
  });
});
