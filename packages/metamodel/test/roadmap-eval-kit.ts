import { loadRoadmapMetamodel, MetamodelRegistry } from '../src';

/**
 * Shared kit of the roadmap evaluations: a tiny in-memory graph, the checks the metamodel itself
 * makes on it, and the computations a roadmap view needs (bars, float, derived dependencies). It
 * reads only what roadmap.yaml stores; the computations are what the model leaves to be derived.
 */

export const reg = new MetamodelRegistry(loadRoadmapMetamodel());

export type Node = { id: string; type: string; attrs: Record<string, unknown> };
export type Edge = { rel: string; from: string; to: string; attrs?: Record<string, unknown> };
export type Graph = { nodes: Node[]; edges: Edge[] };

export const node = (id: string, type: string, attrs: Record<string, unknown> = {}): Node => ({ id, type, attrs: { name: id, ...attrs } });
export const edge = (rel: string, from: string, to: string, attrs?: Record<string, unknown>): Edge => ({ rel, from, to, attrs });
export const delivers = (from: string, to: string, responsibility = 'PRIMARY'): Edge => edge('DELIVERS', from, to, { responsibility });
export const dependsOn = (from: string, to: string, attrs: Record<string, unknown> = {}): Edge => edge('DEPENDS_ON', from, to, { strength: 'HARD', dependencyType: 'FINISH_START', ...attrs });
export const bar = (type: 'Milestone' | 'Epic', id: string, start: string, end: string, attrs: Record<string, unknown> = {}) =>
  node(id, type, { start, end, ...(type === 'Milestone' ? { confidence: 'MEDIUM', committed: true } : { status: 'ACTIVE' }), ...attrs });

/** What the metamodel itself says about a graph: attributes valid, every link allowed, its rules kept. */
export function problems(g: Graph): string[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const out: string[] = [];
  for (const n of g.nodes) for (const i of reg.validateNodeAttributes(n.type, n.attrs)) out.push(`${n.id}: ${i}`);
  for (const e of g.edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) out.push(`${e.rel}: unknown endpoint ${e.from} -> ${e.to}`);
    else if (!reg.canConnect(e.rel, a.type, b.type)) out.push(`${e.rel}: ${a.type} -> ${b.type} is not allowed`);
    for (const def of reg.relationshipType(e.rel)?.attributes ?? []) {
      const v = e.attrs?.[def.name];
      if (v === undefined) {
        if (def.required) out.push(`${e.rel} ${e.from} -> ${e.to}: ${def.name} is required`);
      } else if (def.enum && !reg.metamodel.enums[def.enum]?.includes(String(v))) out.push(`${e.rel} ${e.from} -> ${e.to}: ${def.name} must be one of ${def.enum}`);
    }
  }
  // The metamodel's uniqueValuePerTarget rules, applied as the platform applies them (no validity periods in these fixtures).
  for (const rule of reg.metamodel.rules) {
    if (rule.kind !== 'uniqueValuePerTarget') continue;
    for (const value of rule.values) {
      const byTarget = new Map<string, number>();
      for (const e of g.edges) if (e.rel === rule.relationship && e.attrs?.[rule.attribute] === value) byTarget.set(e.to, (byTarget.get(e.to) ?? 0) + 1);
      for (const [to, n] of byTarget) if (n > 1) out.push(`${rule.id}: ${to} has ${n} ${rule.relationship} with ${rule.attribute}=${value}`);
    }
  }
  return out;
}

export const targets = (g: Graph, rel: string, from: string) => g.edges.filter((e) => e.rel === rel && e.from === from).map((e) => e.to);
export const sources = (g: Graph, rel: string, to: string) => g.edges.filter((e) => e.rel === rel && e.to === to).map((e) => e.from);
export const get = (g: Graph, id: string) => g.nodes.find((n) => n.id === id)!;
export const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
export const quarter = (date: string) => `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;

/** A roadmap line item: an initiative, a milestone or an epic. */
export const isItem = (g: Graph, id: string) => ['Initiative', 'Milestone', 'Epic'].includes(get(g, id).type);
export const isBar = (g: Graph, id: string) => ['Milestone', 'Epic'].includes(get(g, id).type);

/** Start and end of a bar; an initiative spans its milestones. */
export function span(g: Graph, id: string): { start: string; end: string } {
  const n = get(g, id);
  if (n.type === 'Initiative') {
    const spans = sources(g, 'PART_OF', id).filter((m) => get(g, m).type === 'Milestone').map((m) => span(g, m));
    return { start: spans.map((s) => s.start).sort()[0]!, end: spans.map((s) => s.end).sort().reverse()[0]! };
  }
  const end = n.attrs.end as string;
  return { start: (n.attrs.start as string | undefined) ?? end, end };
}

/** A line item and every line item inside it. */
export const contained = (g: Graph, id: string): string[] => [id, ...sources(g, 'PART_OF', id).filter((c) => isItem(g, c)).flatMap((c) => contained(g, c))];

/** The line item that primarily delivers an element, or else the nearest part-of ancestor's. */
export function deliveringItem(g: Graph, element: string, seen = new Set<string>()): string | undefined {
  if (seen.has(element)) return undefined;
  seen.add(element);
  const own = g.edges.find((e) => e.rel === 'DELIVERS' && e.to === element && e.attrs?.responsibility === 'PRIMARY' && isItem(g, e.from));
  if (own) return own.from;
  for (const parent of targets(g, 'PART_OF', element).filter((p) => !isItem(g, p))) {
    const up = deliveringItem(g, parent, seen);
    if (up) return up;
  }
  return undefined;
}

/** ready-by of an element: the end of the line item that primarily delivers it. */
export const readyBy = (g: Graph, element: string) => {
  const item = deliveringItem(g, element);
  return item ? span(g, item).end : undefined;
};

export type Float = { dependent: string; on: string; type: string; float: number; derived?: boolean; via?: string };

function floatOf(g: Graph, dependent: string, on: string, type: string, lag: number) {
  const dep = span(g, dependent);
  const pre = span(g, on);
  const pairs: Record<string, [string, string]> = { FINISH_START: [dep.start, pre.end], START_START: [dep.start, pre.start], FINISH_FINISH: [dep.end, pre.end], START_FINISH: [dep.end, pre.start] };
  const [needed, ready] = pairs[type]!;
  return days(ready, needed) - lag;
}

/** The dependencies someone recorded between line items. Float comes from the bars. */
export function floats(g: Graph): Float[] {
  return g.edges
    .filter((e) => e.rel === 'DEPENDS_ON' && isItem(g, e.from) && isItem(g, e.to))
    .map((e) => {
      const type = (e.attrs?.dependencyType as string | undefined) ?? 'FINISH_START';
      return { dependent: e.from, on: e.to, type, float: floatOf(g, e.from, e.to, type, (e.attrs?.lagDays as number | undefined) ?? 0) };
    });
}

/**
 * The dependencies that follow from the facts, with nobody entering them twice: an element USES
 * another, a process READS data (it depends on the data) or WRITES data (the data depends on it).
 * Each is taken between the line items that deliver the two ends, finish-finish unless the link says
 * otherwise.
 */
export function derived(g: Graph): Float[] {
  const out: Float[] = [];
  for (const e of g.edges.filter((x) => ['USES', 'READS', 'WRITES'].includes(x.rel))) {
    const [dependentEnd, prerequisiteEnd] = e.rel === 'WRITES' ? [e.to, e.from] : [e.from, e.to];
    const dependent = deliveringItem(g, dependentEnd);
    const on = deliveringItem(g, prerequisiteEnd);
    if (!dependent || !on || dependent === on) continue;
    const type = (e.attrs?.dependencyType as string | undefined) ?? 'FINISH_FINISH';
    out.push({ dependent, on, type, float: floatOf(g, dependent, on, type, (e.attrs?.lagDays as number | undefined) ?? 0), derived: true, via: `${e.rel} ${e.from} -> ${e.to}` });
  }
  return out;
}

/** Recorded dependencies, plus derived ones for pairs nobody recorded: a recorded dependency between line items inside the two ends replaces the derived one. */
export function effective(g: Graph): Float[] {
  const recorded = floats(g);
  const replaced = (d: Float) => {
    const inside = contained(g, d.dependent);
    const prerequisites = contained(g, d.on);
    return recorded.some((r) => inside.includes(r.dependent) && prerequisites.includes(r.on));
  };
  return [...recorded, ...derived(g).filter((d) => !replaced(d))];
}

/** Whether a line item belongs to a committed milestone (an initiative: any of its milestones). */
export function committed(g: Graph, id: string): boolean {
  const n = get(g, id);
  if (n.type === 'Milestone') return n.attrs.committed === true;
  if (n.type === 'Initiative') return sources(g, 'PART_OF', id).some((m) => get(g, m).type === 'Milestone' && get(g, m).attrs.committed === true);
  return targets(g, 'PART_OF', id).some((p) => committed(g, p));
}

/** Risk signal: a dependency of a committed line item with negative float. */
export const lateDependencies = (g: Graph) => effective(g).filter((f) => f.float < 0 && committed(g, f.dependent));
