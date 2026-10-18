import { describe, expect, it } from 'vitest';
import { buildRoadmap, type RoadmapView } from '@d4/core';
import { ganttGeometry } from '../src/components/Gantt';
import { roadmapToCsv, roadmapToMermaid } from '../src/roadmap-export';

const dependencies = [{ from: 'b', to: 'a', type: 'FINISH_START' as const, lagDays: 0 }];
const base = buildRoadmap({
  items: [
    { id: 'a', name: 'Build: hub', kind: 'deliverable', start: '2027-01-01', end: '2027-01-31', status: 'IN_PROGRESS', lane: 'Data' },
    { id: 'b', name: 'Migrate, "clients"', kind: 'deliverable', start: '2027-01-15', end: '2027-02-28', lane: 'Data' },
    { id: 'm', name: 'Go live', kind: 'milestone', start: '2027-03-01', end: null, lane: 'Milestones' },
  ],
  dependencies,
});
const r: RoadmapView = { ...base, lanesBy: 'initiative', changes: [], dependencies };

describe('roadmap exports', () => {
  it('writes CSV with planned and earliest dates, escaping', () => {
    const lines = roadmapToCsv(r).split('\n');
    expect(lines[0]).toContain('plannedStart,plannedEnd,earliestStart,earliestEnd');
    const b = lines.find((l) => l.startsWith('b,'))!;
    expect(b).toContain('"Migrate, ""clients"""');
    expect(b).toContain('2027-01-15,2027-02-28,2027-02-01');
    expect(b).toContain('Build: hub');
    expect(b).toMatch(/too early/);
  });

  it('writes a Mermaid gantt with sections, crit and milestones', () => {
    const m = roadmapToMermaid(r, 'Client: data');
    expect(m.split('\n').slice(0, 2)).toEqual(['gantt', '  title Client data']);
    expect(m).toContain('  section Data');
    expect(m).toContain('    Build hub :crit, active, t1, 2027-01-01, 31d');
    expect(m).toMatch(/Go live :.*milestone, t3, 2027-03-01, 0d/);
  });
});

describe('ganttGeometry', () => {
  it('pads the axis to whole months and lays out lane and item rows', () => {
    const g = ganttGeometry(r, 'month');
    expect(g.months.map((m) => m.label)).toEqual(['Jan 27', 'Feb 27', 'Mar 27']);
    expect(g.rows.map((x) => (x.kind === 'lane' ? `#${x.lane}` : x.item!.id))).toEqual(['#Data', 'a', 'b', '#Milestones', 'm']);
    const a = g.bar(r.items.find((i) => i.id === 'a')!);
    const b = g.bar(r.items.find((i) => i.id === 'b')!);
    expect(b.x - a.x).toBe(31 * g.pxPerDay);
    expect(b.px).toBe(a.x + 14 * g.pxPerDay);
    expect(a.px).toBeUndefined();
    expect(g.bar(r.items.find((i) => i.id === 'm')!).w).toBe(0);
  });
});
