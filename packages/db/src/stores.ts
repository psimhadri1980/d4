import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { ulid, type DomainEvent } from '@d4/core';
import { Metamodel, MetamodelRegistry, checkReferences, type Metamodel as MetamodelDoc } from '@d4/metamodel';
import type { DbOrTx } from './client';
import {
  events,
  groupMembers,
  metamodels,
  roleBindings,
  ROLES,
  tenantDbInstances,
  tenants,
  users,
  workspaces,
} from './schema';

export type Role = (typeof ROLES)[number];

// ── Tenants ─────────────────────────────────────────────────────────────

export class TenantStore {
  constructor(private readonly db: DbOrTx) {}

  async get(tenantId: string) {
    const [row] = await this.db.select().from(tenants).where(eq(tenants.id, tenantId));
    return row;
  }

  async listActive() {
    return this.db.select().from(tenants).where(eq(tenants.status, 'active'));
  }

  /** The tenant's Neo4j instance, only when both the tenant and the instance are usable. */
  async readyDbInstance(tenantId: string) {
    const [row] = await this.db
      .select({ instance: tenantDbInstances })
      .from(tenantDbInstances)
      .innerJoin(tenants, eq(tenants.id, tenantDbInstances.tenantId))
      .where(
        and(
          eq(tenantDbInstances.tenantId, tenantId),
          eq(tenants.status, 'active'),
          eq(tenantDbInstances.status, 'ready'),
        ),
      );
    return row?.instance;
  }
}

// ── Metamodels ──────────────────────────────────────────────────────────

export const metamodelHash = (mm: MetamodelDoc) =>
  createHash('sha256').update(JSON.stringify(mm)).digest('hex');

export class MetamodelStore {
  constructor(private readonly db: DbOrTx) {}

  /**
   * Stores a validated metamodel version. Re-registering identical content is a no-op that
   * returns the existing id; reusing a name+version with different content is refused.
   */
  async register(tenantId: string, doc: MetamodelDoc, actor: string): Promise<string> {
    const mm = Metamodel.parse(doc);
    const issues = checkReferences(mm);
    if (issues.length) throw new Error(`Invalid metamodel: ${issues.join('; ')}`);
    const hash = metamodelHash(mm);

    const [existing] = await this.db
      .select({ id: metamodels.id, contentHash: metamodels.contentHash })
      .from(metamodels)
      .where(
        and(eq(metamodels.tenantId, tenantId), eq(metamodels.name, mm.id), eq(metamodels.version, mm.version)),
      );
    if (existing) {
      if (existing.contentHash !== hash) {
        throw new Error(`Metamodel ${mm.id}@${mm.version} already exists with different content`);
      }
      return existing.id;
    }
    const id = ulid();
    await this.db.insert(metamodels).values({
      id,
      tenantId,
      name: mm.id,
      version: mm.version,
      content: mm,
      contentHash: hash,
      createdBy: actor,
    });
    return id;
  }

  /** Makes a version active and retires other active versions of the same metamodel. */
  async activate(tenantId: string, id: string): Promise<void> {
    const target = await this.row(tenantId, id);
    await this.db
      .update(metamodels)
      .set({ status: 'retired' })
      .where(
        and(
          eq(metamodels.tenantId, tenantId),
          eq(metamodels.name, target.name),
          eq(metamodels.status, 'active'),
          ne(metamodels.id, id),
        ),
      );
    await this.db.update(metamodels).set({ status: 'active' }).where(eq(metamodels.id, id));
  }

  /** The newest active metamodel version for the tenant (what new workspaces use). */
  async activeId(tenantId: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: metamodels.id })
      .from(metamodels)
      .where(and(eq(metamodels.tenantId, tenantId), eq(metamodels.status, 'active')))
      .orderBy(desc(metamodels.createdAt))
      .limit(1);
    return row?.id;
  }

  async get(tenantId: string, id: string): Promise<MetamodelDoc> {
    return Metamodel.parse((await this.row(tenantId, id)).content);
  }

  async registryForWorkspace(tenantId: string, workspaceId: string): Promise<MetamodelRegistry> {
    const [ws] = await this.db
      .select({ metamodelId: workspaces.metamodelId })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, workspaceId)));
    if (!ws) throw new Error(`Workspace '${workspaceId}' not found`);
    return new MetamodelRegistry(await this.get(tenantId, ws.metamodelId));
  }

  private async row(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(metamodels)
      .where(and(eq(metamodels.tenantId, tenantId), eq(metamodels.id, id)));
    if (!row) throw new Error(`Metamodel '${id}' not found`);
    return row;
  }
}

// ── Workspaces ──────────────────────────────────────────────────────────

export interface NewWorkspace {
  slug: string;
  name: string;
  description?: string;
  metamodelId: string;
}

export class WorkspaceStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, w: NewWorkspace) {
    const [row] = await this.db
      .insert(workspaces)
      .values({ id: ulid(), tenantId, ...w })
      .returning();
    return row!;
  }

  async list(tenantId: string) {
    return this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), isNull(workspaces.archivedAt)))
      .orderBy(asc(workspaces.name));
  }

  async get(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, id)));
    return row;
  }

  /** Repoints a workspace at another metamodel version (callers migrate graph data first). */
  async setMetamodel(tenantId: string, id: string, metamodelId: string): Promise<void> {
    await this.db
      .update(workspaces)
      .set({ metamodelId })
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, id)));
  }

  /** Every workspace including archived ones (tenant administration). */
  async listAll(tenantId: string) {
    return this.db.select().from(workspaces).where(eq(workspaces.tenantId, tenantId)).orderBy(asc(workspaces.name));
  }

  async update(tenantId: string, id: string, changes: { name?: string; description?: string | null }) {
    const [row] = await this.db
      .update(workspaces)
      .set(changes)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, id)))
      .returning();
    return row;
  }

  /** Archived workspaces disappear for everyone but admins; nothing is deleted. */
  async setArchived(tenantId: string, id: string, archived: boolean) {
    const [row] = await this.db
      .update(workspaces)
      .set({ archivedAt: archived ? sql`now()` : null })
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, id)))
      .returning();
    return row;
  }

  async bySlug(tenantId: string, slug: string) {
    const [row] = await this.db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.slug, slug)));
    return row;
  }
}

// ── Users & roles ───────────────────────────────────────────────────────

export interface TokenIdentity {
  subject: string;
  email?: string;
  displayName?: string;
  /** Realm roles in the token; stored so background jobs can re-check access later. */
  roles?: readonly string[];
}

export class UserStore {
  constructor(private readonly db: DbOrTx) {}

  /** Just-in-time provisioning from a verified token; refreshes profile and last-seen. */
  async upsertFromToken(tenantId: string, id: TokenIdentity) {
    const [row] = await this.db
      .insert(users)
      .values({
        id: ulid(),
        tenantId,
        subject: id.subject,
        email: id.email,
        displayName: id.displayName,
        realmRoles: [...(id.roles ?? [])],
      })
      .onConflictDoUpdate({
        target: [users.tenantId, users.subject],
        set: {
          email: id.email,
          displayName: id.displayName,
          realmRoles: [...(id.roles ?? [])],
          lastSeenAt: sql`now()`,
        },
      })
      .returning();
    return row!;
  }

  async get(tenantId: string, id: string) {
    const [row] = await this.db.select().from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, id)));
    return row;
  }

  async list(tenantId: string) {
    return this.db.select().from(users).where(eq(users.tenantId, tenantId)).orderBy(asc(users.email), asc(users.id));
  }
}

export interface Grant {
  principalType: 'user' | 'group';
  principalId: string;
  role: Role;
  /** Omit for a tenant-wide grant. */
  workspaceId?: string;
}

export class RoleStore {
  constructor(private readonly db: DbOrTx) {}

  async grant(tenantId: string, g: Grant, actor: string): Promise<void> {
    await this.db
      .insert(roleBindings)
      .values({ id: ulid(), tenantId, ...g, workspaceId: g.workspaceId ?? null, createdBy: actor })
      .onConflictDoNothing();
  }

  async revoke(tenantId: string, g: Grant): Promise<void> {
    await this.db
      .delete(roleBindings)
      .where(
        and(
          eq(roleBindings.tenantId, tenantId),
          eq(roleBindings.principalType, g.principalType),
          eq(roleBindings.principalId, g.principalId),
          eq(roleBindings.role, g.role),
          g.workspaceId ? eq(roleBindings.workspaceId, g.workspaceId) : isNull(roleBindings.workspaceId),
        ),
      );
  }

  /** Bindings for one workspace, or tenant-wide ones (`workspaceId` null). */
  async bindings(tenantId: string, workspaceId: string | null) {
    return this.db
      .select()
      .from(roleBindings)
      .where(and(eq(roleBindings.tenantId, tenantId), workspaceId ? eq(roleBindings.workspaceId, workspaceId) : isNull(roleBindings.workspaceId)))
      .orderBy(asc(roleBindings.principalType), asc(roleBindings.principalId), asc(roleBindings.role));
  }

  async groupIdsOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return rows.map((r) => r.groupId);
  }

  /**
   * Roles granted to the user directly or through groups, tenant-wide or (when given) for the
   * workspace. Realm roles from the IdP are merged in by the API's authorisation layer.
   */
  async effectiveRoles(tenantId: string, userId: string, workspaceId?: string): Promise<Role[]> {
    const groupIds = (
      await this.db
        .select({ groupId: groupMembers.groupId })
        .from(groupMembers)
        .where(eq(groupMembers.userId, userId))
    ).map((r) => r.groupId);

    const principal = or(
      and(eq(roleBindings.principalType, 'user'), eq(roleBindings.principalId, userId)),
      groupIds.length
        ? and(eq(roleBindings.principalType, 'group'), inArray(roleBindings.principalId, groupIds))
        : undefined,
    );
    const scope = workspaceId
      ? or(isNull(roleBindings.workspaceId), eq(roleBindings.workspaceId, workspaceId))
      : isNull(roleBindings.workspaceId);

    const rows = await this.db
      .selectDistinct({ role: roleBindings.role })
      .from(roleBindings)
      .where(and(eq(roleBindings.tenantId, tenantId), principal, scope));
    return rows.map((r) => r.role).sort();
  }
}

// ── Event log ───────────────────────────────────────────────────────────

export interface StoredEvent extends DomainEvent {
  seq: number;
}

const toDomain = (r: typeof events.$inferSelect): StoredEvent => ({
  seq: r.seq,
  id: r.id,
  type: r.type as DomainEvent['type'],
  workspaceId: r.workspaceId,
  actor: r.actor,
  occurredAt: r.occurredAt.toISOString(),
  subjectId: r.subjectId,
  version: r.subjectVersion,
  data: r.data as Record<string, unknown>,
});

export class EventStore {
  constructor(private readonly db: DbOrTx) {}

  /** Appends in order. Call inside the same unit of work as the graph write (outbox). */
  async append(tenantId: string, batch: DomainEvent[]): Promise<void> {
    if (!batch.length) return;
    await this.db.insert(events).values(
      batch.map((e) => ({
        id: e.id,
        tenantId,
        workspaceId: e.workspaceId,
        type: e.type,
        subjectId: e.subjectId,
        subjectVersion: e.version,
        actor: e.actor,
        occurredAt: new Date(e.occurredAt),
        data: e.data,
      })),
    );
  }

  /** History of one element or relationship, oldest first. */
  async forSubject(tenantId: string, subjectId: string): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.subjectId, subjectId)))
      .orderBy(asc(events.seq));
    return rows.map(toDomain);
  }

  /** Ordered stream for a workspace, for rebuilds and change feeds. */
  async stream(tenantId: string, workspaceId: string, afterSeq = 0, limit = 500): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.workspaceId, workspaceId), gt(events.seq, afterSeq)))
      .orderBy(asc(events.seq))
      .limit(limit);
    return rows.map(toDomain);
  }

  /** Outbox relay: oldest unpublished events across tenants. */
  async unpublished(limit = 100): Promise<(StoredEvent & { tenantId: string })[]> {
    const rows = await this.db
      .select()
      .from(events)
      .where(isNull(events.publishedAt))
      .orderBy(asc(events.seq))
      .limit(limit);
    return rows.map((r) => ({ ...toDomain(r), tenantId: r.tenantId }));
  }

  async markPublished(seqs: number[]): Promise<void> {
    if (!seqs.length) return;
    await this.db.update(events).set({ publishedAt: sql`now()` }).where(inArray(events.seq, seqs));
  }
}
