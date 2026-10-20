import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DomainError, type DomainEvent } from '@d4/core';
import { createDb, JobStore, LOCAL_TENANT, runMigrations, seedLocal, UsageStore, applySettings, type DbHandle, type Limits } from '@d4/db';
import type { SessionProvider } from '@d4/graph';
import { Client } from 'pg';
import { assertJobQuota, assertWithin, DEFAULT_LIMITS, GraphQuotaGuard, limitsFor } from '../src';

const PG = process.env.D4_TEST_POSTGRES_URL;

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'OK';
  } catch (e) {
    return e instanceof DomainError ? e.code : String(e);
  }
};

describe('limits', () => {
  it('refuses only what would pass the limit; null is unlimited', () => {
    const limits: Limits = { ...DEFAULT_LIMITS, elements: 10, workspaces: null };
    expect(code(() => assertWithin(limits, 'elements', 9, 1))).toBe('OK');
    expect(code(() => assertWithin(limits, 'elements', 9, 2))).toBe('QUOTA_EXCEEDED');
    expect(code(() => assertWithin(limits, 'workspaces', 1e9))).toBe('OK');
    expect(() => assertWithin(limits, 'elements', 10)).toThrow('The plan allows 10 elements; 10 in use');
  });

  it('parses operator settings', () => {
    expect(applySettings({ elements: 5, jobsPerDay: 1 }, ['elements=200000', 'jobsPerDay=default', 'workspaces=unlimited'])).toEqual({ elements: 200000, workspaces: null });
    expect(() => applySettings({}, ['nodes=1'])).toThrow(/metrics: elements/);
    expect(() => applySettings({}, ['elements=1.5'])).toThrow(/not a whole number/);
  });
});

describe.skipIf(!PG)('usage and quotas (Postgres)', () => {
  let handle: DbHandle;
  let dbName: string;
  let ws: string;

  beforeAll(async () => {
    dbName = `d4_test_usage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(PG!);
    u.pathname = `/${dbName}`;
    handle = createDb(u.toString(), 2);
    await runMigrations(handle.db);
    ({ workspaceId: ws } = await seedLocal(handle.db));
  });
  afterAll(async () => {
    await handle?.close();
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  });

  /** A session provider that answers the two count queries and counts how often it was asked. */
  const fakeGraph = (elements: number, relationships: number) => {
    const calls = { n: 0 };
    const sessions: SessionProvider = async () =>
      ({
        run: async (cypher: string) => {
          calls.n++;
          const n = cypher.includes('-[r]->') ? relationships : elements;
          return { records: [{ get: () => n }] };
        },
        close: async () => undefined,
      }) as never;
    return { sessions, calls };
  };
  const ev = (type: DomainEvent['type'], n: number) => Array.from({ length: n }, (_, i) => ({ type, id: `${type}${i}` }) as DomainEvent);

  it('uses cached counts, moves them forward after writes, and recounts when stale', async () => {
      // The guard reads limits from Postgres; with no overrides for an unknown tenant it uses defaults.
      let now = 0;
      const guard = new GraphQuotaGuard(handle.db, 1000, () => now);
      const g = fakeGraph(DEFAULT_LIMITS.elements! - 2, 0);
      const done = await guard.check('t_quota_test', g.sessions, ev('ElementCreated', 2));
      done();
      expect(g.calls.n).toBe(2);
      await expect(guard.check('t_quota_test', g.sessions, ev('ElementCreated', 1))).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
      expect(g.calls.n).toBe(2); // cached
      // Updates and deletions do not count.
      await guard.check('t_quota_test', g.sessions, ev('ElementUpdated', 5));
      now = 2000;
      const fresh = fakeGraph(0, 0);
      await guard.check('t_quota_test', fresh.sessions, ev('ElementCreated', 1));
      expect(fresh.calls.n).toBe(2);
  });

  it('applies overrides over defaults and limits jobs per UTC day', async () => {
    const usage = new UsageStore(handle.db);
    expect(await limitsFor(handle.db, LOCAL_TENANT)).toEqual(DEFAULT_LIMITS);
    await usage.setOverrides(LOCAL_TENANT, { jobsPerDay: 2, workspaces: null }, 'test');
    expect(await limitsFor(handle.db, LOCAL_TENANT)).toMatchObject({ jobsPerDay: 2, workspaces: null, elements: DEFAULT_LIMITS.elements });

    const jobs = new JobStore(handle.db);
    for (let i = 0; i < 2; i++) {
      await assertJobQuota(handle.db, LOCAL_TENANT);
      await jobs.create(LOCAL_TENANT, { workspaceId: ws, kind: 'export', params: {}, createdBy: 'u1' });
    }
    await expect(assertJobQuota(handle.db, LOCAL_TENANT)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', message: expect.stringMatching(/2 background jobs today/) });
    // Tomorrow the count starts again.
    await expect(assertJobQuota(handle.db, LOCAL_TENANT, new Date(Date.now() + 86_400_000))).resolves.toBeUndefined();

    await usage.recordDay(LOCAL_TENANT, '2027-01-01', { jobsPerDay: 2, elements: 10 });
    await usage.recordDay(LOCAL_TENANT, '2027-01-01', { jobsPerDay: 3 });
    expect(await usage.history(LOCAL_TENANT, '2027-01-01')).toEqual([
      { day: '2027-01-01', metric: 'elements', value: 10 },
      { day: '2027-01-01', metric: 'jobsPerDay', value: 3 },
    ]);
  });
});
