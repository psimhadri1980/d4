import { and, desc, eq, inArray, max, or, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { DbOrTx } from './client';
import { queries, queryExecutions, queryGrants, queryVersions, QUERY_STATUSES } from './schema';

export type QueryRow = typeof queries.$inferSelect;
export type QueryVersionRow = typeof queryVersions.$inferSelect;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

export interface NewQuery {
  slug: string;
  title: string;
  description?: string;
  tags?: string[];
  system?: boolean;
}

export interface DraftContent {
  cypher: string;
  /** Parameter definitions; validated by the service layer before they get here. */
  params: unknown[];
  resultShape: 'table' | 'graph';
  kind?: 'read' | 'write';
  contentHash: string;
}

export interface QueryGrant {
  principalType: 'role' | 'group';
  principal: string;
}

export interface CatalogEntry extends QueryRow {
  /** Highest published version, if any. */
  publishedVersion: number | null;
  /** Status of the open draft or review, if any. */
  openStatus: 'draft' | 'in_review' | null;
}

export interface SearchOptions {
  text?: string;
  tag?: string;
  /**
   * Restrict to queries the caller can run: a published version plus a grant to one of these
   * roles or groups. Omit for authors and stewards, who see everything in the tenant.
   */
  visibleTo?: { roles: string[]; groupIds: string[] };
}

export class CatalogError extends Error {}

/** Persistence for catalog entries, versions, grants and execution logs. */
export class QueryCatalogStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, q: NewQuery, ownerId: string): Promise<QueryRow> {
    const [row] = await this.db
      .insert(queries)
      .values({
        id: ulid(),
        tenantId,
        slug: q.slug,
        title: q.title,
        description: q.description,
        tags: q.tags ?? [],
        system: q.system ?? false,
        ownerId,
      })
      .returning();
    return row!;
  }

  async get(tenantId: string, id: string): Promise<QueryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(queries)
      .where(and(eq(queries.tenantId, tenantId), eq(queries.id, id)));
    return row;
  }

  async bySlug(tenantId: string, slug: string): Promise<QueryRow | undefined> {
    const [row] = await this.db
      .select()
      .from(queries)
      .where(and(eq(queries.tenantId, tenantId), eq(queries.slug, slug)));
    return row;
  }

  async updateMeta(
    tenantId: string,
    id: string,
    meta: Partial<Pick<QueryRow, 'title' | 'description' | 'tags' | 'certified'>>,
  ): Promise<void> {
    await this.db
      .update(queries)
      .set(meta)
      .where(and(eq(queries.tenantId, tenantId), eq(queries.id, id)));
  }

  async search(tenantId: string, opts: SearchOptions = {}): Promise<CatalogEntry[]> {
    const published = this.db
      .select({ queryId: queryVersions.queryId, v: max(queryVersions.version).as('v') })
      .from(queryVersions)
      .where(eq(queryVersions.status, 'published'))
      .groupBy(queryVersions.queryId)
      .as('published');
    const open = this.db
      .select({ queryId: queryVersions.queryId, s: queryVersions.status })
      .from(queryVersions)
      .where(inArray(queryVersions.status, ['draft', 'in_review']))
      .as('open');

    const filters = [eq(queries.tenantId, tenantId)];
    if (opts.text?.trim()) {
      filters.push(
        sql`query_search_doc(${queries.title}, ${queries.description}, ${queries.tags}) @@ plainto_tsquery('simple', ${opts.text.trim()})`,
      );
    }
    if (opts.tag) filters.push(sql`${opts.tag} = ANY(${queries.tags})`);
    if (opts.visibleTo) {
      const { roles, groupIds } = opts.visibleTo;
      const principals = [
        ...(roles.length
          ? [and(eq(queryGrants.principalType, 'role'), inArray(queryGrants.principal, roles))]
          : []),
        ...(groupIds.length
          ? [and(eq(queryGrants.principalType, 'group'), inArray(queryGrants.principal, groupIds))]
          : []),
      ];
      if (!principals.length) return [];
      filters.push(sql`${published.v} IS NOT NULL`);
      filters.push(
        sql`EXISTS (${this.db
          .select({ one: sql`1` })
          .from(queryGrants)
          .where(and(eq(queryGrants.queryId, queries.id), or(...principals)))})`,
      );
    }

    const rows = await this.db
      .select({ q: queries, publishedVersion: published.v, openStatus: open.s })
      .from(queries)
      .leftJoin(published, eq(published.queryId, queries.id))
      .leftJoin(open, eq(open.queryId, queries.id))
      .where(and(...filters))
      .orderBy(desc(queries.certified), queries.title);
    return rows.map((r) => ({
      ...r.q,
      publishedVersion: r.publishedVersion ?? null,
      openStatus: (r.openStatus as CatalogEntry['openStatus']) ?? null,
    }));
  }

  // ── Versions ──────────────────────────────────────────────────────────

  async versions(queryId: string): Promise<QueryVersionRow[]> {
    return this.db
      .select()
      .from(queryVersions)
      .where(eq(queryVersions.queryId, queryId))
      .orderBy(desc(queryVersions.version));
  }

  async version(queryId: string, version: number): Promise<QueryVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(queryVersions)
      .where(and(eq(queryVersions.queryId, queryId), eq(queryVersions.version, version)));
    return row;
  }

  async latestPublished(queryId: string): Promise<QueryVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(queryVersions)
      .where(and(eq(queryVersions.queryId, queryId), eq(queryVersions.status, 'published')))
      .orderBy(desc(queryVersions.version))
      .limit(1);
    return row;
  }

  async openVersion(queryId: string): Promise<QueryVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(queryVersions)
      .where(and(eq(queryVersions.queryId, queryId), inArray(queryVersions.status, ['draft', 'in_review'])));
    return row;
  }

  /** Creates the next version as a draft, or replaces the content of the open draft. */
  async saveDraft(queryId: string, content: DraftContent, actor: string): Promise<QueryVersionRow> {
    const open = await this.openVersion(queryId);
    if (open?.status === 'in_review') {
      throw new CatalogError('a version is in review; it must be published or sent back first');
    }
    const values = {
      cypher: content.cypher,
      params: content.params,
      resultShape: content.resultShape,
      kind: content.kind ?? 'read',
      contentHash: content.contentHash,
      checks: null,
    };
    if (open) {
      const [row] = await this.db
        .update(queryVersions)
        .set(values)
        .where(eq(queryVersions.id, open.id))
        .returning();
      return row!;
    }
    const [{ next } = { next: 1 }] = await this.db
      .select({ next: sql<number>`coalesce(max(${queryVersions.version}), 0) + 1` })
      .from(queryVersions)
      .where(eq(queryVersions.queryId, queryId));
    const [row] = await this.db
      .insert(queryVersions)
      .values({ id: ulid(), queryId, version: Number(next), createdBy: actor, ...values })
      .returning();
    return row!;
  }

  async setChecks(versionId: string, checks: unknown): Promise<void> {
    await this.db.update(queryVersions).set({ checks }).where(eq(queryVersions.id, versionId));
  }

  /** Moves a version along its lifecycle; the database trigger rejects illegal moves. */
  async setStatus(versionId: string, to: QueryStatus, actor: string, note?: string): Promise<QueryVersionRow> {
    const now = new Date();
    const stamp =
      to === 'in_review'
        ? { submittedAt: now }
        : to === 'published'
          ? { reviewedBy: actor, reviewedAt: now, reviewNote: note ?? null, publishedAt: now }
          : to === 'draft'
            ? { reviewedBy: actor, reviewedAt: now, reviewNote: note ?? null }
            : {};
    const [row] = await this.db
      .update(queryVersions)
      .set({ status: to, ...stamp })
      .where(eq(queryVersions.id, versionId))
      .returning();
    if (!row) throw new CatalogError(`query version '${versionId}' not found`);
    return row;
  }

  // ── Grants ────────────────────────────────────────────────────────────

  async grants(queryId: string): Promise<QueryGrant[]> {
    return this.db
      .select({ principalType: queryGrants.principalType, principal: queryGrants.principal })
      .from(queryGrants)
      .where(eq(queryGrants.queryId, queryId))
      .orderBy(queryGrants.principalType, queryGrants.principal);
  }

  /** Replaces the query's grants. */
  async setGrants(queryId: string, grants: QueryGrant[], actor: string): Promise<void> {
    await this.db.delete(queryGrants).where(eq(queryGrants.queryId, queryId));
    if (grants.length) {
      await this.db
        .insert(queryGrants)
        .values(grants.map((g) => ({ queryId, ...g, grantedBy: actor })))
        .onConflictDoNothing();
    }
  }

  async canRun(queryId: string, roles: string[], groupIds: string[]): Promise<boolean> {
    const principals = [
      ...(roles.length ? [and(eq(queryGrants.principalType, 'role'), inArray(queryGrants.principal, roles))] : []),
      ...(groupIds.length
        ? [and(eq(queryGrants.principalType, 'group'), inArray(queryGrants.principal, groupIds))]
        : []),
    ];
    if (!principals.length) return false;
    const [row] = await this.db
      .select({ one: sql`1` })
      .from(queryGrants)
      .where(and(eq(queryGrants.queryId, queryId), or(...principals)))
      .limit(1);
    return !!row;
  }

  // ── Executions ────────────────────────────────────────────────────────

  async logExecution(e: typeof queryExecutions.$inferInsert): Promise<void> {
    await this.db.insert(queryExecutions).values(e);
  }

  async executions(tenantId: string, queryId: string, limit = 50) {
    return this.db
      .select()
      .from(queryExecutions)
      .where(and(eq(queryExecutions.tenantId, tenantId), eq(queryExecutions.queryId, queryId)))
      .orderBy(desc(queryExecutions.seq))
      .limit(limit);
  }
}
