import { buildRoadmap, type ChangeAction, type DependencyType, type Roadmap, type RoadmapDependency, type RoadmapItem } from './roadmap';
import type { Element, IsoDate, Relationship } from './types';

/**
 * The part of the graph a roadmap needs: the planning items in scope (deliverables and milestones,
 * including transitive prerequisites) plus the relationships and elements that describe them.
 */
export interface PlanningGraph {
  items: { element: Element; kind: 'deliverable' | 'milestone' }[];
  /** DEPENDS_ON, CHANGES, PART_OF_MILESTONE, CONTAINS (into items) and OWNS (into containers). */
  relationships: Relationship[];
  /** Elements at the other end of those relationships (initiatives, divisions, changed elements). */
  related: Element[];
}

export const LANE_KINDS = ['initiative', 'division', 'status', 'type', 'milestone', 'none'] as const;
export type LaneKind = (typeof LANE_KINDS)[number];

export interface RoadmapChangeView {
  deliverableId: string;
  elementId: string;
  elementName: string;
  elementType: string;
  action: ChangeAction;
  targetLifecycle: string | null;
}

export interface RoadmapView extends Roadmap {
  lanesBy: LaneKind;
  changes: RoadmapChangeView[];
  /** Dependencies between items in the roadmap (`from` depends on `to`). */
  dependencies: RoadmapDependency[];
}

const name = (e: Element | undefined) => (e ? String(e.attrs['name'] ?? e.id) : '');
const date = (v: unknown): IsoDate | null => (v === null || v === undefined || v === '' ? null : String(v).slice(0, 10));

/** Turns a planning subgraph into a scheduled roadmap with lanes. */
export function roadmapFromGraph(g: PlanningGraph, opts: { lanes?: LaneKind; today?: IsoDate } = {}): RoadmapView {
  const lanesBy = opts.lanes ?? 'initiative';
  const all = new Map<string, Element>([...g.related, ...g.items.map((i) => i.element)].map((e) => [e.id, e]));
  const inScope = new Set(g.items.map((i) => i.element.id));
  const rels = (type: string) => g.relationships.filter((r) => r.type === type && !r.deleted);

  const container = new Map<string, string>();
  for (const r of rels('CONTAINS')) if (inScope.has(r.toId)) container.set(r.toId, r.fromId);
  const owner = new Map<string, string>();
  for (const r of rels('OWNS')) owner.set(r.toId, r.fromId);
  const milestone = new Map<string, string>();
  for (const r of rels('PART_OF_MILESTONE')) if (inScope.has(r.fromId)) milestone.set(r.fromId, r.toId);

  const lane = (e: Element, kind: 'deliverable' | 'milestone'): string | null => {
    switch (lanesBy) {
      case 'initiative':
        return kind === 'milestone' ? 'Milestones' : name(all.get(container.get(e.id) ?? '')) || null;
      case 'division': {
        const c = container.get(e.id);
        return name(all.get(owner.get(e.id) ?? (c ? owner.get(c) ?? '' : ''))) || null;
      }
      case 'status':
        return kind === 'milestone' ? 'Milestones' : String(e.attrs['status'] ?? 'NOT_STARTED');
      case 'type':
        return e.type;
      case 'milestone':
        return kind === 'milestone' ? name(e) : name(all.get(milestone.get(e.id) ?? '')) || null;
      default:
        return 'Plan';
    }
  };

  const items: RoadmapItem[] = g.items.map(({ element: e, kind }) => ({
    id: e.id,
    name: name(e),
    kind,
    start: date(kind === 'milestone' ? e.attrs['date'] : e.attrs['plannedStart']),
    end: kind === 'milestone' ? null : date(e.attrs['plannedEnd']),
    status: (e.attrs['status'] as string | undefined) ?? null,
    lane: lane(e, kind),
  }));

  const changes: RoadmapChangeView[] = rels('CHANGES')
    .filter((r) => inScope.has(r.fromId))
    .map((r) => ({
      deliverableId: r.fromId,
      elementId: r.toId,
      elementName: name(all.get(r.toId)) || r.toId,
      elementType: all.get(r.toId)?.type ?? '',
      action: r.attrs['action'] as ChangeAction,
      targetLifecycle: (r.attrs['targetLifecycle'] as string | undefined) ?? null,
    }));

  const dependencies: RoadmapDependency[] = rels('DEPENDS_ON')
    .filter((r) => inScope.has(r.fromId) && inScope.has(r.toId))
    .map((r) => ({
      from: r.fromId,
      to: r.toId,
      type: (r.attrs['dependencyType'] as DependencyType | undefined) ?? 'FINISH_START',
      lagDays: r.attrs['lagDays'] == null ? 0 : Number(r.attrs['lagDays']),
    }));
  const roadmap = buildRoadmap({
    items,
    dependencies,
    changes,
    milestones: [...milestone].map(([deliverableId, milestoneId]) => ({ deliverableId, milestoneId })),
    today: opts.today,
  });
  return { ...roadmap, lanesBy, changes, dependencies };
}
