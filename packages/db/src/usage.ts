import { and, asc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import { jobs, queryExecutions, QUOTA_METRICS, tenantQuotas, usageDaily, workspaces } from './schema';

export type QuotaMetric = (typeof QUOTA_METRICS)[number];
/** A limit per metric; `null` is unlimited. */
export type Limits = Record<QuotaMetric, number | null>;

/** Start of the current UTC day: per-day quotas reset at midnight UTC. */
export const utcDayStart = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Usage figures kept in Postgres (graph sizes come from the tenant's Neo4j). */
export class UsageStore {
  constructor(private readonly db: DbOrTx) {}

  async overrides(tenantId: string): Promise<Partial<Limits>> {
    const [row] = await this.db.select().from(tenantQuotas).where(eq(tenantQuotas.tenantId, tenantId));
    return (row?.limits ?? {}) as Partial<Limits>;
  }

  /** Replaces the tenant's overrides; metrics left out fall back to the defaults. */
  async setOverrides(tenantId: string, limits: Partial<Limits>, by: string): Promise<void> {
    await this.db
      .insert(tenantQuotas)
      .values({ tenantId, limits, updatedBy: by })
      .onConflictDoUpdate({ target: tenantQuotas.tenantId, set: { limits, updatedBy: by, updatedAt: sql`now()` } });
  }

  async activeWorkspaces(tenantId: string): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(workspaces).where(and(eq(workspaces.tenantId, tenantId), isNull(workspaces.archivedAt)));
    return r!.n;
  }

  async queryRunsSince(tenantId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(queryExecutions)
      .where(and(eq(queryExecutions.tenantId, tenantId), gte(queryExecutions.executedAt, since)));
    return r!.n;
  }

  async jobsSince(tenantId: string, since: Date): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)::int` }).from(jobs).where(and(eq(jobs.tenantId, tenantId), gte(jobs.createdAt, since)));
    return r!.n;
  }

  /** Bytes of job files still stored (pruned files no longer count). */
  async storageBytes(tenantId: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`coalesce(sum(${jobs.artifactBytes}), 0)::bigint` })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), isNotNull(jobs.artifactKey)));
    return Number(r!.n);
  }

  async recordDay(tenantId: string, day: string, values: Partial<Record<QuotaMetric, number>>): Promise<void> {
    const rows = Object.entries(values).map(([metric, value]) => ({ tenantId, day, metric, value: value! }));
    if (!rows.length) return;
    await this.db
      .insert(usageDaily)
      .values(rows)
      .onConflictDoUpdate({ target: [usageDaily.tenantId, usageDaily.day, usageDaily.metric], set: { value: sql`excluded.value`, recordedAt: sql`now()` } });
  }

  /** Daily readings from `fromDay` (YYYY-MM-DD) on, oldest first. */
  async history(tenantId: string, fromDay: string): Promise<{ day: string; metric: string; value: number }[]> {
    return this.db
      .select({ day: usageDaily.day, metric: usageDaily.metric, value: usageDaily.value })
      .from(usageDaily)
      .where(and(eq(usageDaily.tenantId, tenantId), gte(usageDaily.day, fromDay)))
      .orderBy(asc(usageDaily.day), asc(usageDaily.metric));
  }
}
