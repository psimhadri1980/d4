import { DomainError, type DomainEvent } from '@d4/core';
import { QUOTA_METRICS, TenantStore, UsageStore, utcDayStart, type Db, type Limits, type QuotaMetric } from '@d4/db';
import type { SessionProvider } from '@d4/graph';
import type { TenantGraphs } from './tenant-graphs';

/** Limits for tenants without overrides. Generous enough for evaluation; the operator raises them per tenant. */
export const DEFAULT_LIMITS: Limits = {
  elements: 100_000,
  relationships: 500_000,
  workspaces: 20,
  queryRunsPerDay: 10_000,
  jobsPerDay: 500,
  storageBytes: 5 * 1024 ** 3,
};

const LABELS: Record<QuotaMetric, string> = {
  elements: 'elements',
  relationships: 'relationships',
  workspaces: 'active workspaces',
  queryRunsPerDay: 'query runs today',
  jobsPerDay: 'background jobs today',
  storageBytes: 'bytes of stored files',
};

export type Usage = Record<QuotaMetric, number>;

export async function limitsFor(db: Db, tenantId: string): Promise<Limits> {
  const overrides = await new UsageStore(db).overrides(tenantId);
  return Object.fromEntries(QUOTA_METRICS.map((m) => [m, m in overrides ? (overrides[m] ?? null) : DEFAULT_LIMITS[m]])) as Limits;
}

/** Live elements and relationships in a tenant's graph (every workspace). */
export async function graphCounts(sessions: SessionProvider): Promise<{ elements: number; relationships: number }> {
  const session = await sessions('READ');
  try {
    const els = await session.run('MATCH (n:Element) WHERE NOT coalesce(n.deleted, false) RETURN count(n) AS n');
    const rels = await session.run('MATCH (:Element)-[r]->(:Element) WHERE r.id IS NOT NULL AND NOT coalesce(r.deleted, false) RETURN count(r) AS n');
    return { elements: Number(els.records[0]!.get('n')), relationships: Number(rels.records[0]!.get('n')) };
  } finally {
    await session.close();
  }
}

export async function currentUsage(db: Db, sessions: SessionProvider, tenantId: string, now = new Date()): Promise<Usage> {
  const store = new UsageStore(db);
  const day = utcDayStart(now);
  const [graph, workspaces, queryRunsPerDay, jobsPerDay, storageBytes] = await Promise.all([
    graphCounts(sessions),
    store.activeWorkspaces(tenantId),
    store.queryRunsSince(tenantId, day),
    store.jobsSince(tenantId, day),
    store.storageBytes(tenantId),
  ]);
  return { ...graph, workspaces, queryRunsPerDay, jobsPerDay, storageBytes };
}

const exceeded = (metric: QuotaMetric, limit: number, used: number) =>
  new DomainError('QUOTA_EXCEEDED', `The plan allows ${limit.toLocaleString('en')} ${LABELS[metric]}; ${used.toLocaleString('en')} in use`, [], metric);

/** Refuses when adding `adding` to `used` would pass the limit. */
export function assertWithin(limits: Limits, metric: QuotaMetric, used: number, adding = 1): void {
  const limit = limits[metric];
  if (limit !== null && used + adding > limit) throw exceeded(metric, limit, used);
}

export async function assertJobQuota(db: Db, tenantId: string, now = new Date()): Promise<void> {
  const limits = await limitsFor(db, tenantId);
  const store = new UsageStore(db);
  assertWithin(limits, 'jobsPerDay', await store.jobsSince(tenantId, utcDayStart(now)));
  // Over the storage limit no new files are made until old ones are pruned or the limit is raised.
  assertWithin(limits, 'storageBytes', await store.storageBytes(tenantId), 0);
}

export async function assertQueryRunQuota(db: Db, tenantId: string, now = new Date()): Promise<void> {
  assertWithin(await limitsFor(db, tenantId), 'queryRunsPerDay', await new UsageStore(db).queryRunsSince(tenantId, utcDayStart(now)));
}

export async function assertWorkspaceQuota(db: Db, tenantId: string): Promise<void> {
  assertWithin(await limitsFor(db, tenantId), 'workspaces', await new UsageStore(db).activeWorkspaces(tenantId));
}

/**
 * Checks graph growth before a write. Counting a large graph takes a while, so counts are cached
 * per tenant for `ttlMs` and moved forward by this process's own writes; several processes
 * writing at once can overshoot a limit by what they add within one cache period.
 */
export class GraphQuotaGuard {
  private readonly cache = new Map<string, { at: number; elements: number; relationships: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(tenantId: string, sessions: SessionProvider, events: DomainEvent[]): Promise<() => void> {
    const adding = {
      elements: events.filter((e) => e.type === 'ElementCreated').length,
      relationships: events.filter((e) => e.type === 'RelationshipCreated').length,
    };
    if (!adding.elements && !adding.relationships) return () => undefined;
    let c = this.cache.get(tenantId);
    if (!c || this.now() - c.at > this.ttlMs) {
      c = { at: this.now(), ...(await graphCounts(sessions)) };
      this.cache.set(tenantId, c);
    }
    const limits = await limitsFor(this.db, tenantId);
    if (adding.elements) assertWithin(limits, 'elements', c.elements, adding.elements);
    if (adding.relationships) assertWithin(limits, 'relationships', c.relationships, adding.relationships);
    const counted = c;
    // Call after the write commits.
    return () => {
      counted.elements += adding.elements;
      counted.relationships += adding.relationships;
    };
  }
}

/** Records today's usage for every active tenant (billing and trends). Returns the tenants done. */
export async function meterUsage(db: Db, graphs: TenantGraphs, now = new Date()): Promise<number> {
  const day = utcDayStart(now).toISOString().slice(0, 10);
  const store = new UsageStore(db);
  let done = 0;
  for (const t of await new TenantStore(db).listActive()) {
    try {
      await store.recordDay(t.id, day, await currentUsage(db, graphs.sessions(t.id), t.id, now));
      done++;
    } catch {
      // A tenant whose graph is unreachable is skipped; the next pass tries again.
    }
  }
  return done;
}
