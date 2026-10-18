import { describe, expect, it } from 'vitest';
import { buildRoadmap, findCycles, fromDay, toDay, type RoadmapItem } from '../src';

const del = (id: string, start: string, end: string, extra: Partial<RoadmapItem> = {}): RoadmapItem => ({
  id,
  name: id,
  kind: 'deliverable',
  start,
  end,
  ...extra,
});
const ms = (id: string, date: string): RoadmapItem => ({ id, name: id, kind: 'milestone', start: date, end: null });

/** The client-master plan from samples/ubs-banking.yaml. */
const sample = {
  items: [
    del('build', '2026-10-01', '2027-03-31', { status: 'IN_PROGRESS', lane: 'Data' }),
    del('contract', '2027-01-15', '2027-04-30', { lane: 'Data' }),
    del('migrate', '2027-04-01', '2027-06-30', { lane: 'Data' }),
    del('repoint', '2027-05-01', '2027-06-30', { lane: 'Apps' }),
    del('dq', '2027-04-01', '2027-05-31', { lane: 'Data' }),
    del('decommission', '2027-07-01', '2027-12-31', { lane: 'Apps' }),
    ms('mdm-live', '2027-03-31'),
    ms('cutover', '2027-07-01'),
  ],
  dependencies: [
    { from: 'contract', to: 'build', type: 'START_START' as const, lagDays: 90 },
    { from: 'migrate', to: 'build' },
    { from: 'migrate', to: 'contract' },
    { from: 'repoint', to: 'contract' },
    { from: 'dq', to: 'build' },
    { from: 'decommission', to: 'cutover' },
  ],
};

describe('day arithmetic', () => {
  it('round-trips and crosses year ends', () => {
    expect(fromDay(toDay('2027-02-28') + 1)).toBe('2027-03-01');
    expect(fromDay(toDay('2026-12-31') + 1)).toBe('2027-01-01');
  });
});

describe('buildRoadmap', () => {
  const r = buildRoadmap(sample);
  const item = (id: string) => r.items.find((i) => i.id === id)!;

  it('orders predecessors first', () => {
    const pos = (id: string) => r.order.indexOf(id);
    for (const d of sample.dependencies) expect(pos(d.to)).toBeLessThan(pos(d.from));
    expect(r.order).toHaveLength(8);
  });

  it('pushes items that start before their dependencies allow, and reports it', () => {
    expect(item('migrate').earliestStart).toBe('2027-05-01');
    expect(item('migrate').earliestEnd).toBe('2027-07-30');
    const v = r.conflicts.filter((c) => c.kind === 'dependency-violated');
    expect(v).toEqual([expect.objectContaining({ itemIds: ['migrate', 'contract'], days: 30 })]);
  });

  it('honours start-to-start lags without flagging a later plan', () => {
    expect(item('contract').earliestStart).toBe('2027-01-15');
    expect(r.conflicts.some((c) => c.itemIds[0] === 'contract')).toBe(false);
  });

  it('finds slack and the critical path', () => {
    expect(r.end).toBe('2027-12-31');
    expect(r.start).toBe('2026-10-01');
    expect(item('decommission').slackDays).toBe(0);
    expect(r.criticalPath).toEqual(['cutover', 'decommission']);
    expect(item('dq').slackDays).toBeGreaterThan(0);
    expect(item('cutover').durationDays).toBe(0);
  });

  it('groups into lanes in schedule order', () => {
    expect(r.lanes.map((l) => l.name)).toEqual(['Data', 'Other', 'Apps']);
    expect(r.lanes[0]!.itemIds[0]).toBe('build');
  });

  it('follows a finish-start chain as the critical path', () => {
    const chain = buildRoadmap({
      items: [del('a', '2027-01-01', '2027-01-10'), del('b', '2027-01-11', '2027-01-20'), del('c', '2027-01-01', '2027-01-05')],
      dependencies: [{ from: 'b', to: 'a' }],
    });
    expect(chain.criticalPath).toEqual(['a', 'b']);
    expect(chain.items.find((i) => i.id === 'c')!.slackDays).toBe(15);
  });

  it('supports finish-finish and lag', () => {
    const ff = buildRoadmap({
      items: [del('a', '2027-01-01', '2027-01-10'), del('b', '2027-01-01', '2027-01-05')],
      dependencies: [{ from: 'b', to: 'a', type: 'FINISH_FINISH', lagDays: 2 }],
    });
    expect(ff.items.find((i) => i.id === 'b')!.earliestEnd).toBe('2027-01-12');
  });
});

describe('conflicts', () => {
  it('reports cycles and stops scheduling', () => {
    const r = buildRoadmap({
      items: [del('a', '2027-01-01', '2027-01-02'), del('b', '2027-01-01', '2027-01-02'), del('c', '2027-01-01', '2027-01-02')],
      dependencies: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
        { from: 'c', to: 'a' },
      ],
    });
    expect(r.order).toEqual([]);
    expect(r.conflicts).toEqual([expect.objectContaining({ kind: 'cycle', itemIds: expect.arrayContaining(['a', 'b']) })]);
    expect(findCycles(['x'], [{ from: 'x', to: 'x' }])).toEqual([['x']]);
  });

  it('flags changes to an element after its retirement starts, and double introductions', () => {
    const r = buildRoadmap({
      items: [del('retire', '2027-03-01', '2027-03-31'), del('tweak', '2027-02-01', '2027-04-15'), del('again', '2027-01-01', '2027-01-31')],
      dependencies: [],
      changes: [
        { deliverableId: 'retire', elementId: 'x', elementName: 'Legacy DB', action: 'RETIRE' },
        { deliverableId: 'tweak', elementId: 'x', action: 'MODIFY' },
        { deliverableId: 'again', elementId: 'x', action: 'INTRODUCE' },
        { deliverableId: 'tweak', elementId: 'y', action: 'INTRODUCE' },
        { deliverableId: 'retire', elementId: 'y', action: 'INTRODUCE' },
      ],
    });
    const kinds = r.conflicts.map((c) => [c.kind, c.itemIds]);
    expect(kinds).toContainEqual(['change-after-retirement', ['tweak', 'retire']]);
    expect(kinds).not.toContainEqual(['change-after-retirement', ['again', 'retire']]);
    expect(kinds).toContainEqual(['duplicate-introduction', ['tweak', 'retire']]);
    expect(r.conflicts.find((c) => c.kind === 'change-after-retirement')!.message).toContain('Legacy DB');
  });

  it('flags past-due, unscheduled and done-before-predecessor items', () => {
    const r = buildRoadmap({
      items: [
        del('late', '2026-01-01', '2026-02-01'),
        del('closed', '2026-01-01', '2026-02-01', { status: 'DONE' }),
        del('nodates', '', ''),
        ms('undated', ''),
      ],
      dependencies: [{ from: 'closed', to: 'late' }],
      today: '2026-10-18',
    });
    const kinds = r.conflicts.map((c) => `${c.kind}:${c.itemIds.join(',')}`);
    expect(kinds).toEqual(
      expect.arrayContaining(['past-due:late', 'unscheduled:nodates', 'unscheduled:undated', 'done-before-predecessor:closed,late']),
    );
    expect(kinds).not.toContain('past-due:closed');
  });

  it('handles an empty plan', () => {
    expect(buildRoadmap({ items: [], dependencies: [] })).toMatchObject({ order: [], criticalPath: [], start: null, end: null });
  });
});
