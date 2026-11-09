import { describe, expect, it } from 'vitest';
import { bar, committed, delivers, dependsOn, derived, edge, effective, floats, get, isBar, lateDependencies, node, problems, quarter, readyBy, sources, span, targets, days, type Float, type Graph } from './roadmap-eval-kit';

/**
 * Evaluation 1: can roadmap.yaml hold a Gantt-style roadmap, one view with lanes, milestones as line
 * items with a start and an end, epics inside each milestone, and dependencies between line items at
 * either level, with float derived from the bars?
 *
 * Platform X builds components A, B and C through three milestones. Platform Y builds E through one
 * milestone and consumes B: Y uses B, and Y's integration epic waits for X's release epic of B. All
 * bars fall in Q3 or Q4 2026. B is one component, built by X and only used by Y.
 */

// ---- what a Gantt view reads, beyond the shared kit ----
/** The initiative that carries a platform's roadmap: the one that delivers the platform. */
const roadmapOf = (g: Graph, platform: string) => sources(g, 'DELIVERS', platform).filter((id) => get(g, id).type === 'Initiative');
/** One lane's rows, depth first: each milestone, then the epics inside it, in time order. */
function rows(g: Graph, initiative: string) {
  const byStart = (ids: string[]) => [...ids].sort((a, b) => span(g, a).start.localeCompare(span(g, b).start));
  return byStart(sources(g, 'PART_OF', initiative).filter((id) => get(g, id).type === 'Milestone')).flatMap((m) => [
    { id: m, level: 0, ...span(g, m), type: 'Milestone' },
    ...byStart(sources(g, 'PART_OF', m)).map((e) => ({ id: e, level: 1, ...span(g, e), type: 'Epic' })),
  ]);
}
/** Lanes picked when the view is opened: by platform, or by use case. */
function lanes(g: Graph, by: 'platform' | 'useCase'): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (by === 'platform') {
    for (const p of g.nodes.filter((n) => n.attrs.kind === 'PLATFORM')) out[p.id] = roadmapOf(g, p.id).flatMap((i) => rows(g, i).map((r) => r.id));
  } else {
    for (const uc of g.nodes.filter((n) => n.type === 'UseCase')) {
      const owners = sources(g, 'REALISES', uc.id);
      // An item is in the lane when it realises the use case itself, or its initiative does.
      const items = g.nodes.filter((n) => isBar(g, n.id)).map((n) => n.id);
      const initiativeOf = (id: string): string | undefined => {
        const up = targets(g, 'PART_OF', id)[0];
        return up === undefined ? id : get(g, up).type === 'Initiative' ? up : initiativeOf(up);
      };
      out[uc.id] = items.filter((id) => owners.includes(id) || (!owners.some((o) => items.includes(o) && o !== initiativeOf(id)) && owners.includes(initiativeOf(id)!)));
    }
  }
  return out;
}
/** The window the user focuses on: what overlaps it, from `from` included to `to` not. */
const inWindow = (g: Graph, ids: string[], from: string, to: string) => ids.filter((id) => span(g, id).end >= from && span(g, id).start < to);

/** A dependency recorded between epics shows at milestone level too: the worst float of those underneath. */
function rolledUp(g: Graph): Float[] {
  const milestoneOf = (id: string): string => (get(g, id).type === 'Epic' ? targets(g, 'PART_OF', id)[0]! : id);
  const worst = new Map<string, Float>();
  for (const f of floats(g)) {
    const key = `${milestoneOf(f.dependent)} ${milestoneOf(f.on)}`;
    if (milestoneOf(f.dependent) === milestoneOf(f.on)) continue;
    if (!worst.has(key) || f.float < worst.get(key)!.float) worst.set(key, { ...f, dependent: milestoneOf(f.dependent), on: milestoneOf(f.on) });
  }
  return [...worst.values()];
}
/** What a slip reaches: the line items that depend on it, their milestones, and what those deliver. */
function impactOf(g: Graph, id: string) {
  const items = sources(g, 'DEPENDS_ON', id);
  const milestones = [...new Set(items.map((i) => (get(g, i).type === 'Epic' ? targets(g, 'PART_OF', i)[0]! : i)))];
  return { items, milestones, delivers: milestones.flatMap((m) => targets(g, 'DELIVERS', m)) };
}
function scenario(): Graph {
  const nodes = [
    node('PlatformX', 'ApplicationElement', { kind: 'PLATFORM', lifecycle: 'BUILDING' }),
    node('PlatformY', 'ApplicationElement', { kind: 'PLATFORM', lifecycle: 'BUILDING' }),
    ...['A', 'B', 'C', 'E'].map((c) => node(c, 'ApplicationElement', { kind: 'COMPONENT', lifecycle: 'PLANNED' })),
    node('XRoadmap', 'Initiative', { level: 'INITIATIVE', status: 'ACTIVE' }),
    node('YRoadmap', 'Initiative', { level: 'INITIATIVE', status: 'ACTIVE' }),
    node('Onboarding', 'UseCase', { statement: 'Onboard a customer end to end' }),
    bar('Milestone', 'X.M1', '2026-07-01', '2026-08-15', { confidence: 'HIGH' }),
    bar('Milestone', 'X.M2', '2026-08-17', '2026-10-15'),
    bar('Milestone', 'X.M3', '2026-10-16', '2026-12-15', { confidence: 'LOW' }),
    bar('Epic', 'X.M2.build', '2026-08-17', '2026-09-30'),
    bar('Epic', 'X.M2.release', '2026-10-01', '2026-10-15'),
    bar('Milestone', 'Y.M1', '2026-10-01', '2026-11-15'),
    bar('Epic', 'Y.M1.build', '2026-10-01', '2026-10-19'),
    bar('Epic', 'Y.M1.integrate', '2026-10-20', '2026-11-15'),
  ];
  const edges = [
    // X builds A, B and C; its roadmap initiative delivers X through three milestones, each delivering one component.
    ...['A', 'B', 'C'].map((c) => edge('PART_OF', c, 'PlatformX')),
    delivers('XRoadmap', 'PlatformX'),
    ...['X.M1', 'X.M2', 'X.M3'].map((m) => edge('PART_OF', m, 'XRoadmap')),
    delivers('X.M1', 'A'),
    delivers('X.M2', 'B'),
    delivers('X.M3', 'C'),
    edge('PART_OF', 'X.M2.build', 'X.M2'),
    edge('PART_OF', 'X.M2.release', 'X.M2'),
    // Y builds E through one milestone, and consumes B: Y uses it, and Y's integration waits for X's release of it.
    edge('PART_OF', 'E', 'PlatformY'),
    delivers('YRoadmap', 'PlatformY'),
    edge('PART_OF', 'Y.M1', 'YRoadmap'),
    delivers('Y.M1', 'E'),
    edge('PART_OF', 'Y.M1.build', 'Y.M1'),
    edge('PART_OF', 'Y.M1.integrate', 'Y.M1'),
    edge('USES', 'PlatformY', 'B', { strength: 'HARD' }),
    dependsOn('Y.M1.integrate', 'X.M2.release'),
    // Both initiatives realise one use case.
    edge('REALISES', 'XRoadmap', 'Onboarding'),
    edge('REALISES', 'YRoadmap', 'Onboarding'),
  ];
  return { nodes, edges };
}

describe('evaluation 1: a Gantt-style roadmap over platforms, milestones and epics', () => {
  const g = scenario();

  it('is valid against the metamodel', () => {
    expect(problems(g)).toEqual([]);
  });

  it('tells platforms from components by kind, and a builder from a consumer', () => {
    expect(get(g, 'PlatformX').attrs.kind).toBe('PLATFORM');
    expect(sources(g, 'PART_OF', 'PlatformX').sort()).toEqual(['A', 'B', 'C']);
    expect(sources(g, 'PART_OF', 'PlatformY')).toEqual(['E']); // Y does not own B
    expect(targets(g, 'PART_OF', 'B')).toEqual(['PlatformX']);
    expect(sources(g, 'USES', 'B')).toEqual(['PlatformY']);
    expect(readyBy(g, 'B')).toBe('2026-10-15');
  });

  describe('the single view: one lane per platform, milestones as bars, epics inside them', () => {
    it("lays out platform X's lane: three milestones in time order, with the epics of B's milestone below it", () => {
      expect(rows(g, 'XRoadmap').map((r) => [r.level, r.id, r.start, r.end])).toEqual([
        [0, 'X.M1', '2026-07-01', '2026-08-15'],
        [0, 'X.M2', '2026-08-17', '2026-10-15'],
        [1, 'X.M2.build', '2026-08-17', '2026-09-30'],
        [1, 'X.M2.release', '2026-10-01', '2026-10-15'],
        [0, 'X.M3', '2026-10-16', '2026-12-15'],
      ]);
    });

    it('lays out platform Y\'s lane: one milestone, with its two epics', () => {
      expect(rows(g, 'YRoadmap').map((r) => [r.level, r.id])).toEqual([
        [0, 'Y.M1'],
        [1, 'Y.M1.build'],
        [1, 'Y.M1.integrate'],
      ]);
    });

    it('puts every bar in Q3 or Q4 2026', () => {
      const all = [...rows(g, 'XRoadmap'), ...rows(g, 'YRoadmap')];
      expect(new Set(all.flatMap((r) => [quarter(r.start), quarter(r.end)]))).toEqual(new Set(['2026-Q3', '2026-Q4']));
    });

    it('lets the same view be laid out by use case instead of platform', () => {
      expect(lanes(g, 'useCase').Onboarding!.sort()).toEqual(['X.M1', 'X.M2', 'X.M2.build', 'X.M2.release', 'X.M3', 'Y.M1', 'Y.M1.build', 'Y.M1.integrate']);
      expect(Object.keys(lanes(g, 'platform')).sort()).toEqual(['PlatformX', 'PlatformY']);
    });

    it('narrows to the window the user focuses on: Q4 2026 leaves out the milestone that ended in Q3', () => {
      const all = lanes(g, 'platform').PlatformX!;
      expect(inWindow(g, all, '2026-10-01', '2027-01-01')).toEqual(['X.M2', 'X.M2.release', 'X.M3']);
      expect(inWindow(g, all, '2026-07-01', '2026-10-01')).toEqual(['X.M1', 'X.M2', 'X.M2.build']);
    });
  });

  describe('dependencies, with float from the bars', () => {
    it("shows Y's integration waiting for X's release of B, five days ahead", () => {
      expect(floats(g)).toEqual([{ dependent: 'Y.M1.integrate', on: 'X.M2.release', type: 'FINISH_START', float: 5 }]);
      expect(lateDependencies(g)).toEqual([]);
    });

    it('shows the same dependency at milestone level, so a collapsed milestone still draws its arrow', () => {
      expect(rolledUp(g)).toEqual([{ dependent: 'Y.M1', on: 'X.M2', type: 'FINISH_START', float: 5 }]);
    });

    it('is recorded at the finest level: a coarse milestone-to-milestone dependency would give the wrong float', () => {
      const coarse: Graph = { ...g, edges: g.edges.filter((e) => e.rel !== 'DEPENDS_ON').concat(dependsOn('Y.M1', 'X.M2')) };
      expect(floats(coarse)[0]!.float).toBe(-14); // Y.M1 starts before X.M2 ends, though only its second epic waits
    });

    it('derives the dependency from "Y uses B" when nobody recorded it, and lets a recorded finer one replace it', () => {
      const unrecorded: Graph = { ...g, edges: g.edges.filter((e) => e.rel !== 'DEPENDS_ON') };
      expect(effective(unrecorded)).toEqual([{ dependent: 'YRoadmap', on: 'X.M2', type: 'FINISH_FINISH', float: 31, derived: true, via: 'USES PlatformY -> B' }]);
      expect(derived(g)).toHaveLength(1);
      expect(effective(g).map((f) => [f.dependent, f.on, f.float])).toEqual([['Y.M1.integrate', 'X.M2.release', 5]]); // the recorded epic dependency wins
    });

    it('supports the other dependency types and a lag', () => {
      const ss: Graph = { ...g, edges: g.edges.map((e) => (e.rel === 'DEPENDS_ON' ? dependsOn('Y.M1.integrate', 'X.M2.release', { dependencyType: 'FINISH_FINISH', lagDays: 7 }) : e)) };
      expect(floats(ss)[0]!.float).toBe(days('2026-10-15', '2026-11-15') - 7); // 31 - 7
    });
  });

  describe('when the roadmap is at risk: X slips the release of B to 5 November', () => {
    const slipped: Graph = { ...g, nodes: g.nodes.map((n) => (n.id === 'X.M2.release' ? { ...n, attrs: { ...n.attrs, end: '2026-11-05' } } : n)) };

    it('turns the dependency into a late one, with the days it is short', () => {
      expect(lateDependencies(slipped)).toEqual([{ dependent: 'Y.M1.integrate', on: 'X.M2.release', type: 'FINISH_START', float: -16 }]);
    });

    it('traces the impact from the slipped epic to the milestone and component it holds up', () => {
      expect(impactOf(slipped, 'X.M2.release')).toEqual({ items: ['Y.M1.integrate'], milestones: ['Y.M1'], delivers: ['E'] });
    });
  });

  it('refuses a second primary delivery of B', () => {
    const bad: Graph = { ...g, edges: [...g.edges, delivers('Y.M1', 'B')] };
    expect(problems(bad)).toEqual(['single-primary-delivery-per-element: B has 2 DELIVERS with responsibility=PRIMARY']);
  });

  it('requires a milestone to have an end', () => {
    const noEnd: Graph = { ...g, nodes: g.nodes.map((n) => (n.id === 'X.M1' ? { ...n, attrs: { name: 'X.M1', start: '2026-07-01' } } : n)) };
    expect(problems(noEnd)[0]).toMatch(/X\.M1: .*end.*required/i);
  });
});
