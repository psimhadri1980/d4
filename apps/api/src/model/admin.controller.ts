import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { MetamodelStore, QUOTA_METRICS, RoleStore, ROLES, UsageStore, UserStore, WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/schemas';
import { Database } from '../infra/database.service';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { assertWorkspaceQuota, currentUsage, limitsFor } from '@d4/jobs';
import { describeMetamodelPacks, loadMetamodelPack, METAMODEL_PACKS, MetamodelRegistry } from '@d4/metamodel';
import { TenantGraphService } from '../infra/tenant-graph.service';

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'lowercase letters, digits and dashes, 2–48 characters');
const CreateWorkspace = z
  .object({
    slug,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    /** Starter (the tenant's active metamodel) or an industry pack composed on it. */
    metamodel: z.enum(METAMODEL_PACKS).optional(),
  })
  .strict();
const UpdateWorkspace = z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).nullable().optional() }).strict();
const Binding = z
  .object({
    principalType: z.enum(['user', 'group']).default('user'),
    principalId: z.string().min(1),
    role: z.enum(ROLES),
  })
  .strict();
const ListQuery = z.object({ archived: z.enum(['true', 'false']).optional() });

/**
 * Tenant administration: workspaces and who may do what in them. Admin only; everything is
 * scoped to the caller's tenant. Role changes apply to a user's next request (bindings are read
 * on each sign-in check).
 */
@Controller('v1')
export class AdminController {
  constructor(
    @Inject(MetamodelStore) private readonly metamodelStore: MetamodelStore,
    @Inject(RoleStore) private readonly roleStore: RoleStore,
    @Inject(UsageStore) private readonly usageStore: UsageStore,
    @Inject(UserStore) private readonly userStore: UserStore,
    @Inject(WorkspaceStore) private readonly workspaceStore: WorkspaceStore,
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
  ) {}

  /** Usage against the tenant's limits now, and daily readings for the last 30 days. */
  @Get('admin/usage')
  async usage(@CurrentPrincipal() p: Principal) {
    this.admin(p);
    const db = this.database.db;
    const [usage, limits, history] = await Promise.all([
      currentUsage(db, this.graph.sessions(p.tenantId), p.tenantId),
      limitsFor(db, p.tenantId),
      this.usageStore.history(p.tenantId, new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)),
    ]);
    return { metrics: QUOTA_METRICS.map((m) => ({ metric: m, used: usage[m], limit: limits[m] })), history };
  }

  @Get('admin/workspaces')
  async workspaces(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    this.admin(p);
    const archived = parse(ListQuery, query).archived === 'true';
    const store = this.workspaceStore;
    const rows = archived ? await store.listAll(p.tenantId) : await store.list(p.tenantId);
    const labels = await this.metamodelStore.labels(p.tenantId);
    return rows.map((w) => ({ id: w.id, slug: w.slug, name: w.name, description: w.description, archived: !!w.archivedAt, metamodel: labels.get(w.metamodelId) ?? null, createdAt: w.createdAt.toISOString() }));
  }

  /** Metamodels a new workspace can start from. */
  @Get('admin/metamodel-packs')
  packs(@CurrentPrincipal() p: Principal) {
    this.admin(p);
    return describeMetamodelPacks();
  }

  @Post('admin/workspaces')
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    this.admin(p);
    const b = parse(CreateWorkspace, body);
    const store = this.workspaceStore;
    if (await store.bySlug(p.tenantId, b.slug)) throw new ConflictException(`A workspace with slug '${b.slug}' already exists`);
    await assertWorkspaceQuota(this.database.db, p.tenantId);
    const metamodels = this.metamodelStore;
    let metamodelId: string | undefined;
    if (b.metamodel && b.metamodel !== 'd4-starter') {
      // A pack is registered for the tenant (once per version) and its labels and indexes are added
      // to the tenant graph before any element of its types can be written.
      const doc = loadMetamodelPack(b.metamodel);
      metamodelId = await metamodels.register(p.tenantId, doc, p.userId);
      const session = await this.graph.session(p.tenantId, 'WRITE');
      try {
        await applySchema(session, new MetamodelRegistry(doc));
        await awaitSchemaOnline(session);
      } finally {
        await session.close();
      }
    } else {
      metamodelId = await metamodels.activeId(p.tenantId);
    }
    if (!metamodelId) throw new ConflictException('The tenant has no active metamodel');
    const w = await store.create(p.tenantId, { slug: b.slug, name: b.name, ...(b.description && { description: b.description }), metamodelId });
    const label = (await metamodels.labels(p.tenantId)).get(metamodelId) ?? null;
    return { id: w.id, slug: w.slug, name: w.name, description: w.description, archived: false, metamodel: label, createdAt: w.createdAt.toISOString() };
  }

  @Patch('admin/workspaces/:ws')
  async update(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    this.admin(p);
    const row = await this.workspaceStore.update(p.tenantId, ws, parse(UpdateWorkspace, body));
    if (!row) throw new NotFoundException(`Workspace '${ws}' not found`);
    return { id: row.id, slug: row.slug, name: row.name, description: row.description, archived: !!row.archivedAt };
  }

  /** Archive hides the workspace from everyone but admins; its data stays. */
  @Post('admin/workspaces/:ws/archive')
  @HttpCode(204)
  async archive(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    await this.setArchived(p, ws, true);
  }

  @Post('admin/workspaces/:ws/restore')
  @HttpCode(204)
  async restore(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    await this.setArchived(p, ws, false);
  }

  @Get('admin/users')
  async users(@CurrentPrincipal() p: Principal) {
    this.admin(p);
    return (await this.userStore.list(p.tenantId)).map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      realmRoles: u.realmRoles,
      lastSeenAt: u.lastSeenAt.toISOString(),
    }));
  }

  /** `ws` = a workspace id, or `tenant` for tenant-wide roles. */
  @Get('admin/members/:ws')
  async members(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    this.admin(p);
    const scope = await this.scope(p, ws);
    const users = new Map((await this.userStore.list(p.tenantId)).map((u) => [u.id, u]));
    return (await this.roleStore.bindings(p.tenantId, scope)).map((b) => ({
      principalType: b.principalType,
      principalId: b.principalId,
      label: b.principalType === 'user' ? (users.get(b.principalId)?.email ?? users.get(b.principalId)?.displayName ?? b.principalId) : b.principalId,
      role: b.role,
      createdBy: b.createdBy,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  @Post('admin/members/:ws')
  @HttpCode(204)
  async grant(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    this.admin(p);
    const scope = await this.scope(p, ws);
    const b = parse(Binding, body);
    if (b.principalType === 'user' && !(await this.userStore.get(p.tenantId, b.principalId))) {
      throw new NotFoundException(`User '${b.principalId}' not found (users appear after their first sign-in)`);
    }
    await this.roleStore.grant(p.tenantId, { ...b, ...(scope && { workspaceId: scope }) }, p.userId);
  }

  @Delete('admin/members/:ws')
  @HttpCode(204)
  async revoke(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    this.admin(p);
    const scope = await this.scope(p, ws);
    const b = parse(Binding, body);
    // Keep at least one way back in: an admin cannot remove their own tenant-wide admin binding.
    if (!scope && b.role === 'admin' && b.principalType === 'user' && b.principalId === p.userId) {
      throw new ConflictException('You cannot remove your own tenant-wide admin role');
    }
    await this.roleStore.revoke(p.tenantId, { ...b, ...(scope && { workspaceId: scope }) });
  }

  private admin(p: Principal) {
    if (!p.roles.includes('admin')) throw new ForbiddenException('Tenant administration needs the admin role');
  }

  private async scope(p: Principal, ws: string): Promise<string | null> {
    if (ws === 'tenant') return null;
    const row = await this.workspaceStore.get(p.tenantId, ws);
    if (!row) throw new NotFoundException(`Workspace '${ws}' not found`);
    return row.id;
  }

  private async setArchived(p: Principal, ws: string, archived: boolean) {
    this.admin(p);
    // Restoring makes a workspace active again, so it counts against the limit.
    if (!archived) await assertWorkspaceQuota(this.database.db, p.tenantId);
    if (!(await this.workspaceStore.setArchived(p.tenantId, ws, archived))) throw new NotFoundException(`Workspace '${ws}' not found`);
  }
}
