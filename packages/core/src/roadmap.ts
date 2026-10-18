import type { IsoDate } from './types';

/**
 * Roadmap engine: pure scheduling over deliverables, milestones and their dependencies.
 *
 * Dates are whole days. A deliverable occupies [start, end] inclusive; a milestone is a point
 * (duration 0). Planned dates act as "not earlier than" constraints; dependencies can push an item
 * later, and the difference is reported as a conflict rather than silently rewriting the plan.
 */

export type DependencyType = 'FINISH_START' | 'START_START' | 'FINISH_FINISH' | 'START_FINISH';
export type ChangeAction = 'INTRODUCE' | 'MODIFY' | 'RETIRE';

export interface RoadmapItem {
  id: string;
  name: string;
  kind: 'deliverable' | 'milestone';
  /** Deliverable: plannedStart. Milestone: its date. */
  start: IsoDate | null;
  /** Deliverable: plannedEnd (inclusive). Ignored for milestones. */
  end: IsoDate | null;
  status?: string | null;
  lane?: string | null;
}

/** `from` depends on `to` (the graph's DEPENDS_ON direction). */
export interface RoadmapDependency {
  from: string;
  to: string;
  type?: DependencyType | null;
  lagDays?: number | null;
}

export interface RoadmapChange {
  deliverableId: string;
  elementId: string;
  elementName?: string;
  action: ChangeAction;
}

export interface RoadmapInput {
  items: RoadmapItem[];
  dependencies: RoadmapDependency[];
  changes?: RoadmapChange[];
  /** Deliverables that must be finished by a milestone (PART_OF_MILESTONE). */
  milestones?: { deliverableId: string; milestoneId: string }[];
  /** Used for "past due" checks. Defaults to no such checks. */
  today?: IsoDate;
}

export interface ScheduledItem extends RoadmapItem {
  /** Earliest start and finish (inclusive) given dependencies. */
  earliestStart: IsoDate;
  earliestEnd: IsoDate;
  durationDays: number;
  slackDays: number;
  critical: boolean;
}

export type ConflictKind =
  | 'cycle'
  | 'unscheduled'
  | 'dependency-violated'
  | 'change-after-retirement'
  | 'duplicate-introduction'
  | 'misses-milestone'
  | 'past-due'
  | 'done-before-predecessor';

export interface RoadmapConflict {
  kind: ConflictKind;
  itemIds: string[];
  message: string;
  /** For dependency-violated: how many days the plan has to slip. */
  days?: number;
}

export interface Lane {
  name: string;
  itemIds: string[];
}

export interface Roadmap {
  /** Topological order (predecessors first); empty when there is a cycle. */
  order: string[];
  items: ScheduledItem[];
  criticalPath: string[];
  conflicts: RoadmapConflict[];
  lanes: Lane[];
  start: IsoDate | null;
  end: IsoDate | null;
}

// ── day arithmetic ─────────────────────────────────────────────────────────

const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const toDay = (d: IsoDate): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
export const fromDay = (n: number): IsoDate => new Date(n * DAY).toISOString().slice(0, 10);
const isDate = (d: string | null | undefined): d is IsoDate => !!d && DATE.test(d) && !isNaN(Date.parse(d));

// ── graph helpers ──────────────────────────────────────────────────────────

/** Strongly connected components with more than one node (or a self-loop), via Tarjan. */
export function findCycles(ids: string[], edges: { from: string; to: string }[]): string[][] {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)?.push(e.to);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (v: string) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1 || (out.get(v) ?? []).includes(v)) cycles.push(scc.reverse());
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return cycles;
}

/** Kahn's algorithm, predecessors first; ties broken by `tieBreak`. Returns null on a cycle. */
export function topoOrder(ids: string[], deps: { from: string; to: string }[], tieBreak: (a: string, b: string) => number): string[] | null {
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const next = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const d of deps) {
    if (!indeg.has(d.from) || !indeg.has(d.to)) continue;
    next.get(d.to)!.push(d.from);
    indeg.set(d.from, indeg.get(d.from)! + 1);
  }
  const ready = ids.filter((id) => indeg.get(id) === 0).sort(tieBreak);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const s of next.get(id)!) {
      indeg.set(s, indeg.get(s)! - 1);
      if (indeg.get(s) === 0) {
        ready.push(s);
        ready.sort(tieBreak);
      }
    }
  }
  return order.length === ids.length ? order : null;
}

// ── scheduling ─────────────────────────────────────────────────────────────

export function buildRoadmap(input: RoadmapInput): Roadmap {
  const items = new Map(input.items.map((i) => [i.id, i]));
  const ids = [...items.keys()];
  const deps = input.dependencies.filter((d) => items.has(d.from) && items.has(d.to));
  const conflicts: RoadmapConflict[] = [];
  const name = (id: string) => items.get(id)?.name ?? id;

  const cycles = findCycles(ids, deps);
  for (const c of cycles) {
    conflicts.push({ kind: 'cycle', itemIds: c, message: `Dependency cycle: ${[...c, c[0]!].map(name).join(' → ')}` });
  }
  if (cycles.length) return { order: [], items: [], criticalPath: [], conflicts, lanes: lanesOf(input.items, []), start: null, end: null };

  // Durations in days; EF is exclusive (day after the last day).
  const dur = new Map<string, number>();
  const anchor = new Map<string, number | null>();
  for (const it of input.items) {
    const s = isDate(it.start) ? toDay(it.start) : null;
    if (it.kind === 'milestone') {
      dur.set(it.id, 0);
    } else {
      const e = isDate(it.end) ? toDay(it.end) : null;
      dur.set(it.id, s !== null && e !== null && e >= s ? e - s + 1 : 0);
      if (s === null || e === null || e < s) {
        conflicts.push({ kind: 'unscheduled', itemIds: [it.id], message: `${it.name} has no valid planned start and end` });
      }
    }
    anchor.set(it.id, s);
    if (it.kind === 'milestone' && s === null) {
      conflicts.push({ kind: 'unscheduled', itemIds: [it.id], message: `${it.name} has no date` });
    }
  }
  const known = [...anchor.values()].filter((v): v is number => v !== null);
  const projectStart = known.length ? Math.min(...known) : 0;

  const byStart = (a: string, b: string) =>
    (anchor.get(a) ?? projectStart) - (anchor.get(b) ?? projectStart) || name(a).localeCompare(name(b));
  const order = topoOrder(ids, deps, byStart)!;

  const preds = new Map<string, RoadmapDependency[]>(ids.map((id) => [id, []]));
  const succs = new Map<string, RoadmapDependency[]>(ids.map((id) => [id, []]));
  for (const d of deps) {
    preds.get(d.from)!.push(d);
    succs.get(d.to)!.push(d);
  }

  // Forward pass.
  const es = new Map<string, number>();
  const ef = new Map<string, number>();
  for (const id of order) {
    const d = dur.get(id)!;
    let required = Number.NEGATIVE_INFINITY;
    for (const p of preds.get(id)!) required = Math.max(required, earliestFrom(p, es, ef, d));
    const planned = anchor.get(id);
    const start = Math.max(planned ?? projectStart, required);
    if (planned != null && required > planned) {
      const days = required - planned;
      const blockers = preds.get(id)!.filter((p) => earliestFrom(p, es, ef, d) > planned).map((p) => p.to);
      conflicts.push({
        kind: 'dependency-violated',
        itemIds: [id, ...blockers],
        days,
        message: `${name(id)} is planned ${days} day${days === 1 ? '' : 's'} too early for ${blockers.map(name).join(', ')}`,
      });
    }
    es.set(id, start);
    ef.set(id, start + d);
  }

  // Backward pass.
  const projectEnd = Math.max(...ids.map((id) => ef.get(id)!), projectStart);
  const ls = new Map<string, number>();
  const lf = new Map<string, number>();
  for (const id of [...order].reverse()) {
    const d = dur.get(id)!;
    let latest = projectEnd;
    for (const s of succs.get(id)!) latest = Math.min(latest, latestFrom(s, ls, lf, d));
    lf.set(id, latest);
    ls.set(id, latest - d);
  }

  const scheduled: ScheduledItem[] = order.map((id) => {
    const it = items.get(id)!;
    const d = dur.get(id)!;
    const slack = ls.get(id)! - es.get(id)!;
    return {
      ...it,
      earliestStart: fromDay(es.get(id)!),
      earliestEnd: fromDay(d === 0 ? es.get(id)! : ef.get(id)! - 1),
      durationDays: d,
      slackDays: slack,
      critical: slack === 0,
    };
  });

  conflicts.push(
    ...milestoneConflicts(input, es, ef, dur, name),
    ...changeConflicts(input.changes ?? [], es, ef, name),
    ...statusConflicts(input, deps, ef, name),
  );

  return {
    order,
    items: scheduled,
    criticalPath: criticalChain(order, scheduled, preds, es, ef, dur),
    conflicts,
    lanes: lanesOf(input.items, order),
    start: scheduled.length ? scheduled.map((i) => i.earliestStart).sort()[0]! : null,
    end: scheduled.length ? scheduled.map((i) => i.earliestEnd).sort().at(-1)! : null,
  };
}

/** The earliest start that dependency `p` allows for its dependant (duration `d`). */
function earliestFrom(p: RoadmapDependency, es: Map<string, number>, ef: Map<string, number>, d: number): number {
  const lag = p.lagDays ?? 0;
  switch (p.type ?? 'FINISH_START') {
    case 'START_START':
      return es.get(p.to)! + lag;
    case 'FINISH_FINISH':
      return ef.get(p.to)! + lag - d;
    case 'START_FINISH':
      return es.get(p.to)! + lag - d;
    default:
      return ef.get(p.to)! + lag;
  }
}

/** The latest finish that successor dependency `s` allows for its predecessor (duration `d`). */
function latestFrom(s: RoadmapDependency, ls: Map<string, number>, lf: Map<string, number>, d: number): number {
  const lag = s.lagDays ?? 0;
  switch (s.type ?? 'FINISH_START') {
    case 'START_START':
      return ls.get(s.from)! - lag + d;
    case 'FINISH_FINISH':
      return lf.get(s.from)! - lag;
    case 'START_FINISH':
      return lf.get(s.from)! - lag + d;
    default:
      return ls.get(s.from)! - lag;
  }
}

/** Follow driving (zero-gap) critical predecessors back from the latest-finishing critical item. */
function criticalChain(
  order: string[],
  items: ScheduledItem[],
  preds: Map<string, RoadmapDependency[]>,
  es: Map<string, number>,
  ef: Map<string, number>,
  dur: Map<string, number>,
): string[] {
  const critical = new Set(items.filter((i) => i.critical).map((i) => i.id));
  if (!critical.size) return [];
  let cur = [...critical].sort((a, b) => ef.get(b)! - ef.get(a)! || order.indexOf(b) - order.indexOf(a))[0]!;
  const chain = [cur];
  for (;;) {
    const driver = preds
      .get(cur)!
      .find((p) => critical.has(p.to) && earliestFrom(p, es, ef, dur.get(cur)!) === es.get(cur));
    if (!driver) break;
    cur = driver.to;
    chain.unshift(cur);
  }
  return chain;
}

/** A deliverable's last day must be on or before its milestone's date. */
function milestoneConflicts(
  input: RoadmapInput,
  es: Map<string, number>,
  ef: Map<string, number>,
  dur: Map<string, number>,
  name: (id: string) => string,
): RoadmapConflict[] {
  const out: RoadmapConflict[] = [];
  for (const { deliverableId: d, milestoneId: m } of input.milestones ?? []) {
    if (!es.has(d) || !es.has(m) || dur.get(d) === 0) continue;
    const late = ef.get(d)! - 1 - es.get(m)!;
    if (late > 0) {
      out.push({
        kind: 'misses-milestone',
        itemIds: [d, m],
        days: late,
        message: `${name(d)} finishes ${late} day${late === 1 ? '' : 's'} after ${name(m)}`,
      });
    }
  }
  return out;
}

function changeConflicts(
  changes: RoadmapChange[],
  es: Map<string, number>,
  ef: Map<string, number>,
  name: (id: string) => string,
): RoadmapConflict[] {
  const out: RoadmapConflict[] = [];
  const byElement = new Map<string, RoadmapChange[]>();
  for (const c of changes) if (es.has(c.deliverableId)) byElement.set(c.elementId, [...(byElement.get(c.elementId) ?? []), c]);
  for (const [elementId, list] of byElement) {
    const label = list[0]!.elementName ?? elementId;
    for (const r of list.filter((c) => c.action === 'RETIRE')) {
      for (const o of list.filter((c) => c.action !== 'RETIRE' && c.deliverableId !== r.deliverableId)) {
        if (ef.get(o.deliverableId)! > es.get(r.deliverableId)!) {
          out.push({
            kind: 'change-after-retirement',
            itemIds: [o.deliverableId, r.deliverableId],
            message: `${name(o.deliverableId)} still changes ${label} after ${name(r.deliverableId)} starts retiring it`,
          });
        }
      }
    }
    const intro = list.filter((c) => c.action === 'INTRODUCE');
    if (new Set(intro.map((c) => c.deliverableId)).size > 1) {
      out.push({
        kind: 'duplicate-introduction',
        itemIds: [...new Set(intro.map((c) => c.deliverableId))],
        message: `${label} is introduced by more than one deliverable`,
      });
    }
  }
  return out;
}

const CLOSED = new Set(['DONE', 'CANCELLED']);

function statusConflicts(
  input: RoadmapInput,
  deps: RoadmapDependency[],
  ef: Map<string, number>,
  name: (id: string) => string,
): RoadmapConflict[] {
  const out: RoadmapConflict[] = [];
  const byId = new Map(input.items.map((i) => [i.id, i]));
  if (input.today && isDate(input.today)) {
    const today = toDay(input.today);
    for (const it of input.items) {
      if (it.kind === 'deliverable' && !CLOSED.has(it.status ?? '') && ef.get(it.id)! <= today && isDate(it.end)) {
        out.push({ kind: 'past-due', itemIds: [it.id], message: `${it.name} was due ${it.end} and is not done` });
      }
    }
  }
  for (const d of deps) {
    const to = byId.get(d.to)!;
    if (byId.get(d.from)!.status === 'DONE' && to.kind === 'deliverable' && !CLOSED.has(to.status ?? '')) {
      out.push({ kind: 'done-before-predecessor', itemIds: [d.from, d.to], message: `${name(d.from)} is done but ${name(d.to)} is not` });
    }
  }
  return out;
}

/** Lanes in first-appearance order of their items (unlaned items go to "Other"). */
function lanesOf(list: RoadmapItem[], order: string[]): Lane[] {
  const pos = new Map(order.map((id, i) => [id, i]));
  const sorted = [...list].sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));
  const lanes = new Map<string, string[]>();
  for (const it of sorted) {
    const k = it.lane || 'Other';
    lanes.set(k, [...(lanes.get(k) ?? []), it.id]);
  }
  return [...lanes].map(([name, itemIds]) => ({ name, itemIds }));
}
