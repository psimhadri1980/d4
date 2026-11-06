/**
 * GraphCanvas's Overview (OV-1): the result summarised as one bubble per node type, sized by how
 * many nodes it has, with one connector per pair of types that are linked, weighted by how many
 * relationships join them. Laid out on rings by size, the largest in the middle.
 */

export interface OverviewBubble {
  type: string;
  layer: string;
  count: number;
  x: number;
  y: number;
  r: number;
}

export interface OverviewLink {
  /** The two types, in name order; relationships are counted both ways. */
  a: string;
  b: string;
  count: number;
}

export interface CanvasOverview {
  bubbles: OverviewBubble[];
  links: OverviewLink[];
  width: number;
  height: number;
}

const MIN_R = 22;
const GAP = 28;
const MARGIN = 24;

/** Radius grows with the square root of the count, so areas compare. */
export const bubbleRadius = (count: number, largest: number) => MIN_R + 48 * Math.sqrt(count / Math.max(1, largest));

export function canvasOverview(nodes: readonly { id: string; type: string; layer: string }[], edges: readonly { from: string; to: string }[]): CanvasOverview {
  const byType = new Map<string, { layer: string; count: number }>();
  for (const n of nodes) {
    const t = byType.get(n.type);
    if (t) t.count++;
    else byType.set(n.type, { layer: n.layer, count: 1 });
  }
  const typeOf = new Map(nodes.map((n) => [n.id, n.type]));
  const pairs = new Map<string, OverviewLink>();
  for (const e of edges) {
    const ta = typeOf.get(e.from);
    const tb = typeOf.get(e.to);
    if (!ta || !tb) continue;
    const [a, b] = ta < tb ? [ta, tb] : [tb, ta];
    const k = `${a}|${b}`;
    const p = pairs.get(k);
    if (p) p.count++;
    else pairs.set(k, { a, b, count: 1 });
  }

  const sorted = [...byType].map(([type, t]) => ({ type, ...t })).sort((p, q) => q.count - p.count || p.type.localeCompare(q.type));
  const largest = sorted[0]?.count ?? 1;
  const placed: OverviewBubble[] = [];
  // The largest in the middle, then rings, each holding as many bubbles as fit around it.
  let i = 0;
  let ringR = 0;
  while (i < sorted.length) {
    if (i === 0) {
      const s = sorted[0]!;
      placed.push({ ...s, x: 0, y: 0, r: bubbleRadius(s.count, largest) });
      ringR = placed[0]!.r;
      i++;
      continue;
    }
    const first = bubbleRadius(sorted[i]!.count, largest);
    const radius = ringR + GAP + first;
    const ring: typeof sorted = [];
    let used = 0;
    const room = 2 * Math.PI * radius;
    while (i < sorted.length) {
      const d = 2 * bubbleRadius(sorted[i]!.count, largest) + GAP;
      if (ring.length && used + d > room) break;
      ring.push(sorted[i]!);
      used += d;
      i++;
    }
    // Spread the ring's bubbles over the whole circle, in proportion to their size.
    let angle = -Math.PI / 2;
    const scale = (2 * Math.PI) / used;
    for (const s of ring) {
      const r = bubbleRadius(s.count, largest);
      const share = (2 * r + GAP) * scale;
      angle += share / 2;
      placed.push({ ...s, x: radius * Math.cos(angle), y: radius * Math.sin(angle), r });
      angle += share / 2;
    }
    ringR = radius + first;
  }

  const minX = Math.min(0, ...placed.map((b) => b.x - b.r)) - MARGIN;
  const minY = Math.min(0, ...placed.map((b) => b.y - b.r)) - MARGIN;
  const bubbles = placed.map((b) => ({ ...b, x: b.x - minX, y: b.y - minY }));
  const width = Math.max(0, ...bubbles.map((b) => b.x + b.r)) + MARGIN;
  const height = Math.max(0, ...bubbles.map((b) => b.y + b.r)) + MARGIN;
  return { bubbles, links: [...pairs.values()].sort((p, q) => q.count - p.count || p.a.localeCompare(q.a) || p.b.localeCompare(q.b)), width, height };
}
