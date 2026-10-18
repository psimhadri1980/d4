import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { checkCatalogQuery, checkReadOnly, contentHash, paramDefIssues } from '@d4/cypher';
import { DomainError } from '@d4/core';
import { QueryCatalogStore, RoleStore, ROLES, type QueryGrant, type QueryRow, type QueryVersionRow } from '@d4/db';
import { neo4jExplainer } from '@d4/graph';
import { hasAnyRole, type Principal } from '../auth/identity';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import { PackInstaller } from './pack-installer.service';

export const isAuthor = (p: Principal) => hasAnyRole(p.roles, ['query-author']);
export const isSteward = (p: Principal) => hasAnyRole(p.roles, ['query-steward']);

export interface DraftInput {
  cypher: string;
  params: unknown[];
  resultShape: 'table' | 'graph';
}

/** Catalog rules: visibility, authoring, review and grants (ADR 0002). */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
    @Inject(PackInstaller) private readonly packs: PackInstaller,
  ) {}

  private store() {
    return new QueryCatalogStore(this.database.db);
  }

  /** Authors and stewards see the whole catalog; everyone else sees what is granted to them. */
  async search(p: Principal, filter: { q?: string; tag?: string }) {
    await this.packs.ensureInstalled(p.tenantId);
    const visibleTo = isAuthor(p) || isSteward(p) ? undefined : { roles: p.roles, groupIds: await this.groups(p) };
    return this.store().search(p.tenantId, { text: filter.q, tag: filter.tag, visibleTo });
  }

  async detail(p: Principal, id: string) {
    await this.packs.ensureInstalled(p.tenantId);
    const entry = await this.entry(p, id);
    const privileged = isAuthor(p) || isSteward(p);
    if (!privileged && !(await this.store().canRun(id, p.roles, await this.groups(p)))) {
      throw new NotFoundException(`Query '${id}' not found`);
    }
    const versions = (await this.store().versions(id)).filter(
      (v) => privileged || v.status === 'published' || v.status === 'deprecated',
    );
    return {
      ...entry,
      versions,
      ...(privileged && { grants: await this.store().grants(id) }),
    };
  }

  // ── Authoring ─────────────────────────────────────────────────────────

  async create(p: Principal, input: { slug: string; title: string; description?: string; tags?: string[] }) {
    this.require(isAuthor(p), 'query-author');
    if (await this.store().bySlug(p.tenantId, input.slug)) {
      throw new ConflictException(`A query with slug '${input.slug}' already exists`);
    }
    return this.store().create(p.tenantId, input, p.userId);
  }

  async updateMeta(
    p: Principal,
    id: string,
    input: { title?: string; description?: string; tags?: string[]; certified?: boolean },
  ) {
    const entry = await this.entry(p, id);
    const owner = isAuthor(p) && entry.ownerId === p.userId;
    this.require(isSteward(p) || owner, 'query-steward or the owning author');
    if (input.certified !== undefined) this.require(isSteward(p), 'query-steward');
    if (entry.system) throw new ConflictException('System queries are managed by the platform');
    await this.store().updateMeta(p.tenantId, id, input);
    return this.entry(p, id);
  }

  /** Saves the open draft (creating the next version if needed) and records the static checks. */
  async saveDraft(p: Principal, id: string, input: DraftInput) {
    this.require(isAuthor(p), 'query-author');
    const entry = await this.entry(p, id);
    if (entry.system) throw new ConflictException('System queries are managed by the platform');

    const { defs, issues } = paramDefIssues(input.params);
    const checks = checkCatalogQuery(input.cypher, defs);
    const content = { cypher: input.cypher, params: defs.length ? defs : input.params, resultShape: input.resultShape, kind: 'read' as const };
    const version = await this.store().saveDraft(id, { ...content, contentHash: contentHash(content) }, p.userId);
    const result = { errors: [...issues, ...checks.errors], warnings: checks.warnings };
    await this.store().setChecks(version.id, result);
    return { version: { ...version, checks: result }, checks: result };
  }

  /** Re-checks the draft (static + Neo4j EXPLAIN) and sends it for review if clean. */
  async submit(p: Principal, id: string) {
    this.require(isAuthor(p), 'query-author');
    await this.entry(p, id);
    const draft = await this.store().openVersion(id);
    if (draft?.status !== 'draft') throw new ConflictException('There is no draft to submit');

    const checks = await this.fullChecks(p.tenantId, draft);
    await this.store().setChecks(draft.id, checks);
    if (checks.errors.length) throw new DomainError('VALIDATION', 'The draft does not pass the checks', checks.errors);
    return this.store().setStatus(draft.id, 'in_review', p.userId);
  }

  // ── Review and lifecycle (stewards) ───────────────────────────────────

  async review(p: Principal, id: string, decision: 'publish' | 'reject', note?: string) {
    this.require(isSteward(p), 'query-steward');
    await this.entry(p, id);
    const pending = await this.store().openVersion(id);
    if (pending?.status !== 'in_review') throw new ConflictException('There is no version in review');
    // Separation of duties: authors cannot approve their own work (admins excepted).
    if (pending.createdBy === p.userId && !p.roles.includes('admin')) {
      throw new ForbiddenException('You cannot review your own query');
    }
    if (decision === 'reject') return this.store().setStatus(pending.id, 'draft', p.userId, note);

    // Publish only exactly what was checked.
    if (contentHash(pending) !== pending.contentHash) {
      throw new ConflictException('Stored content does not match its fingerprint');
    }
    const checks = await this.fullChecks(p.tenantId, pending);
    if (checks.errors.length) throw new DomainError('VALIDATION', 'The version no longer passes the checks', checks.errors);
    return this.store().setStatus(pending.id, 'published', p.userId, note);
  }

  async setVersionStatus(p: Principal, id: string, version: number, to: 'deprecated' | 'retired' | 'published') {
    this.require(isSteward(p), 'query-steward');
    await this.entry(p, id);
    const v = await this.store().version(id, version);
    if (!v) throw new NotFoundException(`Version ${version} not found`);
    try {
      return await this.store().setStatus(v.id, to, p.userId);
    } catch (e) {
      throw new ConflictException((e as Error).message);
    }
  }

  async setGrants(p: Principal, id: string, grants: QueryGrant[]) {
    this.require(isSteward(p), 'query-steward');
    await this.entry(p, id);
    const bad = grants.filter((g) => g.principalType === 'role' && !(ROLES as readonly string[]).includes(g.principal));
    if (bad.length) throw new DomainError('VALIDATION', 'Unknown roles', bad.map((g) => g.principal));
    await this.store().setGrants(id, grants, p.userId);
    return this.store().grants(id);
  }

  /**
   * Removes an entry: never-published entries are deleted outright; entries with published
   * history are archived (hidden, with versions and run log kept for audit).
   */
  async remove(p: Principal, id: string): Promise<{ removed: 'deleted' | 'archived' }> {
    const entry = await this.entry(p, id);
    this.require(isSteward(p) || (isAuthor(p) && entry.ownerId === p.userId), 'query-steward or the owning author');
    if (entry.system) throw new ConflictException('System queries are managed by the platform');
    const store = this.store();
    if (await store.everPublished(id)) {
      await store.archive(p.tenantId, id);
      return { removed: 'archived' };
    }
    await store.deleteUnpublished(p.tenantId, id);
    return { removed: 'deleted' };
  }

  async executions(p: Principal, id: string) {
    const entry = await this.entry(p, id);
    this.require(isSteward(p) || (isAuthor(p) && entry.ownerId === p.userId), 'query-steward or the owning author');
    return this.store().executions(p.tenantId, id);
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  async entry(p: Principal, id: string): Promise<QueryRow> {
    const entry = await this.store().get(p.tenantId, id);
    if (!entry || entry.archivedAt) throw new NotFoundException(`Query '${id}' not found`);
    return entry;
  }

  groups(p: Principal): Promise<string[]> {
    return new RoleStore(this.database.db).groupIdsOf(p.userId);
  }

  /** Static checks plus Neo4j's read-only classification against the tenant's database. */
  private async fullChecks(tenantId: string, v: QueryVersionRow) {
    const { defs, issues } = paramDefIssues(v.params);
    const stat = checkCatalogQuery(v.cypher, defs);
    const errors = [...issues, ...stat.errors];
    if (!errors.length) {
      const nulls = Object.fromEntries(defs.map((d) => [d.name, null]));
      const ro = await checkReadOnly(neo4jExplainer(this.graph.sessions(tenantId)), v.cypher, {
        ...nulls,
        workspace: '',
      });
      errors.push(...ro.errors);
    }
    return { errors, warnings: stat.warnings };
  }

  private require(ok: boolean, what: string): void {
    if (!ok) throw new ForbiddenException(`Requires ${what}`);
  }
}
