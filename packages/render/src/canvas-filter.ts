/**
 * GraphCanvas's "Show only" filter (FK-1): an inclusion filter. Empty lists show everything;
 * ticked node types or relationship types show only those. A node also drops out when the only
 * way to it from a root passes through something hidden. Roots always stay, so the result keeps
 * its anchor and the table its top-level rows.
 */

export interface CanvasFilter {
  nodeTypes: readonly string[];
  relationshipTypes: readonly string[];
}

export const NO_FILTER: CanvasFilter = { nodeTypes: [], relationshipTypes: [] };

export const filterActive = (f: CanvasFilter) => f.nodeTypes.length > 0 || f.relationshipTypes.length > 0;

export function applyCanvasFilter<N extends { id: string; type: string }, E extends { from: string; to: string; type: string }>(
  nodes: readonly N[],
  edges: readonly E[],
  rootIds: readonly string[],
  f: CanvasFilter,
): { nodes: N[]; edges: E[] } {
  if (!filterActive(f)) return { nodes: [...nodes], edges: [...edges] };
  const types = new Set(f.nodeTypes);
  const rels = new Set(f.relationshipTypes);
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const roots = new Set(rootIds.filter((r) => typeOf.has(r)));
  const nodeOk = (id: string) => roots.has(id) || !types.size || types.has(typeOf.get(id)!);
  const edgeOk = (e: E) => !rels.size || rels.has(e.type);

  const next = new Map<string, string[]>();
  for (const e of edges) {
    if (!edgeOk(e) || !typeOf.has(e.from) || !typeOf.has(e.to)) continue;
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    next.set(e.to, [...(next.get(e.to) ?? []), e.from]);
  }
  // Reachable from a root through shown nodes and shown relationships only.
  const shown = new Set(roots);
  const queue = [...roots];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const n of next.get(cur) ?? []) {
      if (!shown.has(n) && nodeOk(n)) {
        shown.add(n);
        queue.push(n);
      }
    }
  }
  return {
    nodes: nodes.filter((n) => shown.has(n.id)),
    edges: edges.filter((e) => edgeOk(e) && shown.has(e.from) && shown.has(e.to)),
  };
}

/** Each node type and relationship type in the result with its count, for the panel's lists. */
export function kindCounts(nodes: readonly { type: string }[], edges: readonly { type: string }[]) {
  const count = (xs: readonly { type: string }[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x.type, (m.get(x.type) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([type, n]) => ({ type, count: n }));
  };
  return { nodeTypes: count(nodes), relationshipTypes: count(edges) };
}
