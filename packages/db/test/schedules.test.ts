import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimDueSchedules, LOCAL_TENANT, ScheduleStore, seedLocal } from '../src';
import { ADMIN_URL, freshDatabase } from './helpers';

describe.skipIf(!ADMIN_URL)('schedule store (Postgres)', () => {
  let handle: Awaited<ReturnType<typeof freshDatabase>>;
  let store: ScheduleStore;
  let ws: string;
  const at = (iso: string) => new Date(iso);
  const spec = (name: string, nextRunAt: Date) => ({
    workspaceId: ws,
    name,
    kind: 'export' as const,
    params: { format: 'yaml' },
    useRunDate: true,
    cadence: { frequency: 'daily', hour: 6 },
    nextRunAt,
    createdBy: 'u1',
  });

  beforeAll(async () => {
    handle = await freshDatabase();
    ({ workspaceId: ws } = await seedLocal(handle.db));
    store = new ScheduleStore(handle.db);
  });
  afterAll(() => handle?.dispose());

  it('claims only due, enabled schedules and moves them forward', async () => {
    const due = await store.create(LOCAL_TENANT, spec('Due', at('2027-01-01T06:00:00Z')));
    await store.create(LOCAL_TENANT, spec('Later', at('2027-01-02T06:00:00Z')));
    const paused = await store.create(LOCAL_TENANT, spec('Paused', at('2027-01-01T05:00:00Z')));
    await store.update(LOCAL_TENANT, paused.id, { enabled: false });

    const next = at('2027-01-02T06:00:00Z');
    const claimed = await claimDueSchedules(handle.db, at('2027-01-01T06:00:30Z'), () => next);
    expect(claimed.map((s) => s.name)).toEqual(['Due']);
    expect((await store.get(LOCAL_TENANT, due.id))!.nextRunAt).toEqual(next);
    // Claimed once: polling again at the same time finds nothing.
    expect(await claimDueSchedules(handle.db, at('2027-01-01T06:00:30Z'), () => next)).toEqual([]);
  });

  it('never hands the same schedule to two concurrent pollers', async () => {
    for (let i = 0; i < 10; i++) await store.create(LOCAL_TENANT, spec(`Batch ${i}`, at('2027-02-01T06:00:00Z')));
    const later = () => at('2027-03-01T06:00:00Z');
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => claimDueSchedules(handle.db, at('2027-02-01T07:00:00Z'), later, 4)));
    const ids = [...a!, ...b!, ...c!].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Every batch schedule is claimed exactly once across this round and the next.
    const rest = await claimDueSchedules(handle.db, at('2027-02-01T07:00:00Z'), later, 20);
    const batch = [...a!, ...b!, ...c!, ...rest].filter((s) => s.name.startsWith('Batch')).map((s) => s.id);
    expect(batch).toHaveLength(10);
    expect(new Set(batch).size).toBe(10);
  });

  it('records runs, updates, lists by owner and deletes', async () => {
    const s = await store.create(LOCAL_TENANT, { ...spec('Mine', at('2027-04-01T06:00:00Z')), createdBy: 'owner-9' });
    await store.recordRun(LOCAL_TENANT, s.id, 'job-1', at('2027-04-01T06:00:05Z'));
    expect(await store.get(LOCAL_TENANT, s.id)).toMatchObject({ lastJobId: 'job-1', lastRunAt: at('2027-04-01T06:00:05Z') });
    expect((await store.update(LOCAL_TENANT, s.id, { name: 'Renamed' }))!.name).toBe('Renamed');
    expect((await store.list(LOCAL_TENANT, ws, { createdBy: 'owner-9' })).map((x) => x.name)).toEqual(['Renamed']);
    expect(await store.get('t_other', s.id)).toBeUndefined();
    expect(await store.remove(LOCAL_TENANT, s.id)).toBe(true);
    expect(await store.remove(LOCAL_TENANT, s.id)).toBe(false);
  });
});
