import { radialLayout, type Point } from './graph';

/**
 * Geometry for Graph Studio's GraphCanvas: where each node box goes for the five layouts, and the
 * connector routes between them. Pure functions, no DOM, so they are tested without a browser.
 */

export type CanvasLayout = 'hier' | 'flow' | 'layers' | 'radial' | 'force';
export const CANVAS_LAYOUTS: readonly CanvasLayout[] = ['hier', 'flow', 'layers', 'radial', 'force'];

export interface LayoutNode {
  id: string;
  layer: string;
}

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /** Relationship type, drawn as the connector's label. */
  label: string;
}

/** Top-left corner and size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Route {
  id: string;
  /** From the `from` box edge to the `to` box edge; the arrow tip is the last point. */
  points: Point[];
  /** Radial and Force: the quadratic curve's control point, once the connector is curved. */
  control?: Point;
  /** Elbow layouts: the coordinate of the bend line on `axis` (y for rows, x for columns). */
  bend?: { axis: 'x' | 'y'; at: number };
  /** Straight layouts: how far the connector's middle is pushed sideways. */
  curve?: number;
  label: Point;
  /** The point on the connector the label belongs to (GV-5b's dotted tie). */
  anchor: Point;
}

export interface CanvasGeometry {
  boxes: Map<string, Box>;
  routes: Route[];
  /** The drawing's extent: a node dragged past the top or left makes these negative. */
  minX: number;
  minY: number;
  width: number;
  height: number;
}

/**
 * What the user changed by hand, in canvas coordinates (GV-5, GV-5b): node centres, a connector's
 * bend line (elbow) or curve (straight), and label positions. Kept per layout by the host.
 */
export interface CanvasAdjustments {
  nodes: Readonly<Record<string, Point>>;
  bends: Readonly<Record<string, number>>;
  labels: Readonly<Record<string, Point>>;
}

export const NO_ADJUSTMENTS: CanvasAdjustments = { nodes: {}, bends: {}, labels: {} };

export interface GeometryOptions {
  /** From `canvasPlacement`, so dragging does not lay everything out again. */
  placement?: Map<string, Point>;
  /** Box size per node (semantic zoom draws smaller boxes); default the card. */
  size?: (id: string) => { w: number; h: number };
  adjust?: CanvasAdjustments;
}

/** Node card size and the slot each card sits in (ZM-7). */
export const CARD = { w: 180, h: 56 } as const;
const SLOT = { w: 220, h: 112 } as const;
const MARGIN = 40;
/** Approximate width of one label character at the 11px label size. */
const CHAR_W = 6.2;
const LABEL_H = 16;

/** Node centres for a layout, with the top-left card at the margin. */
export function canvasPlacement(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  rootIds: string[],
  layout: CanvasLayout,
  /** Metamodel layer order, for the By layer layout. */
  layers: readonly string[] = [],
): Map<string, Point> {
  const ids = new Set(nodes.map((n) => n.id));
  const centres = place(nodes, validEdges(edges, ids), rootIds.filter((r) => ids.has(r)), layout, layers);
  const xs = [...centres.values()].map((p) => p.x);
  const ys = [...centres.values()].map((p) => p.y);
  const dx = MARGIN + CARD.w / 2 - (xs.length ? Math.min(...xs) : 0);
  const dy = MARGIN + CARD.h / 2 - (ys.length ? Math.min(...ys) : 0);
  return new Map([...centres].map(([id, p]) => [id, { x: p.x + dx, y: p.y + dy }]));
}

export function canvasGeometry(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  rootIds: string[],
  layout: CanvasLayout,
  layers: readonly string[] = [],
  opts: GeometryOptions = {},
): CanvasGeometry {
  const ids = new Set(nodes.map((n) => n.id));
  const valid = validEdges(edges, ids);
  const placement = opts.placement ?? canvasPlacement(nodes, edges, rootIds, layout, layers);
  const adjust = opts.adjust ?? NO_ADJUSTMENTS;
  const boxes = new Map<string, Box>();
  for (const n of nodes) {
    const c = adjust.nodes[n.id] ?? placement.get(n.id) ?? { x: 0, y: 0 };
    const { w, h } = opts.size?.(n.id) ?? CARD;
    boxes.set(n.id, { x: c.x - w / 2, y: c.y - h / 2, w, h });
  }

  const routes = elbowLayout(layout) ? elbowRoutes(boxes, valid, layout === 'flow' ? 'x' : 'y', adjust.bends) : straightRoutes(boxes, valid, adjust.bends);
  nudgeLabels(routes.filter((r) => !adjust.labels[r.id]), valid, boxes);
  for (const r of routes) if (adjust.labels[r.id]) r.label = adjust.labels[r.id]!;

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  const grow = (x: number, y: number, w: number, h: number) => {
    minX = Math.min(minX, x - MARGIN);
    minY = Math.min(minY, y - MARGIN);
    maxX = Math.max(maxX, x + w + MARGIN);
    maxY = Math.max(maxY, y + h + MARGIN);
  };
  for (const b of boxes.values()) grow(b.x, b.y, b.w, b.h);
  for (const r of routes) grow(r.label.x - 40, r.label.y - LABEL_H / 2, 80, LABEL_H);
  return { boxes, routes, minX, minY, width: maxX - minX, height: maxY - minY };
}

const validEdges = (edges: LayoutEdge[], ids: Set<string>) => edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to);

const elbowLayout = (l: CanvasLayout) => l === 'hier' || l === 'flow' || l === 'layers';

// ── Placement ────────────────────────────────────────────────────────────

function place(nodes: LayoutNode[], edges: LayoutEdge[], rootIds: string[], layout: CanvasLayout, layers: readonly string[]): Map<string, Point> {
  if (layout === 'radial') return radial(nodes, edges, rootIds);
  if (layout === 'force') return force(nodes, edges, radial(nodes, edges, rootIds));
  const hop = hops(nodes, edges, rootIds);
  const rank =
    layout === 'layers'
      ? layerRanks(nodes, layers)
      : new Map(nodes.map((n) => [n.id, hop.get(n.id)!]));
  const rows = orderRows(nodes, edges, rank, hop);
  const pos = new Map<string, Point>();
  const widest = Math.max(...[...rows.values()].map((r) => r.length));
  for (const [r, row] of rows) {
    // Centre each row under the widest one.
    const offset = ((widest - row.length) * (layout === 'flow' ? SLOT.h : SLOT.w)) / 2;
    row.forEach((id, i) =>
      pos.set(
        id,
        layout === 'flow'
          ? { x: r * SLOT.w * 1.3, y: offset + i * SLOT.h }
          : { x: offset + i * SLOT.w, y: r * SLOT.h * 1.4 },
      ),
    );
  }
  return pos;
}

/**
 * Hops from the nearest root over relationships in either direction. Nodes no root reaches go
 * one rank past the deepest, so they are still drawn.
 */
export function hops(nodes: LayoutNode[], edges: LayoutEdge[], rootIds: string[]): Map<string, number> {
  const next = adjacency(edges);
  const dist = new Map<string, number>();
  const queue = [...rootIds];
  for (const r of rootIds) dist.set(r, 0);
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const n of next.get(cur) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(cur)! + 1);
        queue.push(n);
      }
    }
  }
  const deepest = Math.max(0, ...dist.values());
  for (const n of nodes) if (!dist.has(n.id)) dist.set(n.id, deepest + 1);
  return dist;
}

/** One rank per metamodel layer, in metamodel order; layers with no nodes are skipped. */
function layerRanks(nodes: LayoutNode[], layers: readonly string[]): Map<string, number> {
  const order = (l: string) => {
    const i = layers.indexOf(l);
    return i < 0 ? layers.length : i;
  };
  const used = [...new Set(nodes.map((n) => order(n.layer)))].sort((a, b) => a - b);
  return new Map(nodes.map((n) => [n.id, used.indexOf(order(n.layer))]));
}

/**
 * Orders each rank to keep connectors short: a sweep down, then up, placing each node at the mean
 * position of its neighbours in the rank before (barycentre). Ties break by hop, then id, so the
 * result is the same every time.
 */
function orderRows(nodes: LayoutNode[], edges: LayoutEdge[], rank: Map<string, number>, hop: Map<string, number>): Map<number, string[]> {
  const rows = new Map<number, string[]>();
  for (const n of [...nodes].sort((a, b) => hop.get(a.id)! - hop.get(b.id)! || a.id.localeCompare(b.id))) {
    const r = rank.get(n.id)!;
    rows.set(r, [...(rows.get(r) ?? []), n.id]);
  }
  const next = adjacency(edges);
  const keys = [...rows.keys()].sort((a, b) => a - b);
  const sweep = (order: number[], dir: 1 | -1) => {
    for (const r of order) {
      const at = new Map<string, number>();
      for (const row of rows.values()) row.forEach((id, i) => at.set(id, i / Math.max(1, row.length - 1)));
      const centre = (id: string) => {
        const ps = (next.get(id) ?? []).filter((n) => rank.get(n) === r - dir).map((n) => at.get(n)!);
        return ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : at.get(id)!;
      };
      const row = rows.get(r)!;
      const c = new Map(row.map((id) => [id, centre(id)]));
      rows.set(r, [...row].sort((a, b) => c.get(a)! - c.get(b)! || a.localeCompare(b)));
    }
  };
  sweep(keys.slice(1), 1);
  sweep(keys.slice(0, -1).reverse(), -1);
  return rows;
}

const HUB = '\u0000roots';

function radial(nodes: LayoutNode[], edges: LayoutEdge[], rootIds: string[]): Map<string, Point> {
  const rels = edges.map((e) => ({ fromId: e.from, toId: e.to }));
  const ids = nodes.map((n) => n.id);
  if (rootIds.length === 1) return scale(radialLayout(rootIds[0]!, ids, rels));
  // Several roots: a hidden hub in the centre puts them on the first ring.
  const pos = radialLayout(HUB, ids, [...rels, ...rootIds.map((r) => ({ fromId: HUB, toId: r }))]);
  pos.delete(HUB);
  return scale(pos);
}

/** radialLayout spaces points for small dots; cards need about twice the room. */
const scale = (pos: Map<string, Point>) => new Map([...pos].map(([id, p]) => [id, { x: p.x * 1.9, y: p.y * 1.2 }]));

/**
 * Force-directed: spring forces along connectors, repulsion between nearby nodes, started from the
 * radial layout and cooled over a fixed number of steps, so it is deterministic. Repulsion counts
 * only nodes within CUTOFF (beyond it the push is under a sixteenth of that at one slot), found
 * through a grid of CUTOFF-sized cells, so a step costs about n rather than n² (1,000 nodes in well
 * under a second on a slow machine).
 */
function force(nodes: LayoutNode[], edges: LayoutEdge[], start: Map<string, Point>): Map<string, Point> {
  const n = nodes.length;
  const index = new Map(nodes.map((nd, i) => [nd.id, i]));
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  nodes.forEach((nd, i) => {
    const p = start.get(nd.id) ?? { x: 0, y: 0 };
    x[i] = p.x;
    y[i] = p.y;
  });
  const links = edges.map((e) => [index.get(e.from)!, index.get(e.to)!] as const);
  const k = SLOT.w;
  const CUTOFF = 4 * k;
  const steps = n > 300 ? 30 : 80;
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  const push = (i: number, j: number) => {
    const dx = x[i]! - x[j]! || 0.01;
    const dy = (y[i]! - y[j]!) * 1.6 || 0.01;
    const d2 = dx * dx + dy * dy;
    if (d2 > CUTOFF * CUTOFF) return;
    const f = (k * k) / d2;
    sx[i]! += dx * f;
    sy[i]! += dy * f;
    sx[j]! -= dx * f;
    sy[j]! -= dy * f;
  };
  for (let s = 0; s < steps; s++) {
    const temp = k * (1 - s / steps);
    sx.fill(0);
    sy.fill(0);
    // Nodes by grid cell; each pair is met once, from the cell that comes first.
    const cells = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(x[i]! / CUTOFF)},${Math.floor((y[i]! * 1.6) / CUTOFF)}`;
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    }
    for (const [key, list] of cells) {
      const [cx, cy] = key.split(',').map(Number) as [number, number];
      for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) push(list[a]!, list[b]!);
      for (const [ox, oy] of [[1, -1], [1, 0], [1, 1], [0, 1]] as const) {
        const other = cells.get(`${cx + ox},${cy + oy}`);
        if (other) for (const i of list) for (const j of other) push(i, j);
      }
    }
    for (const [a, b] of links) {
      const dx = x[a]! - x[b]!;
      const dy = y[a]! - y[b]!;
      const f = (Math.hypot(dx, dy) || 0.01) / k;
      sx[a]! -= dx * f;
      sy[a]! -= dy * f;
      sx[b]! += dx * f;
      sy[b]! += dy * f;
    }
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(sx[i]!, sy[i]!) || 1;
      const step = Math.min(len, temp) / len;
      x[i]! += sx[i]! * step;
      y[i]! += sy[i]! * step;
    }
  }
  return new Map(nodes.map((nd, i) => [nd.id, { x: x[i]!, y: y[i]! }]));
}

// ── Connectors ───────────────────────────────────────────────────────────

/**
 * Elbow connectors along `axis` (y: rows top to bottom; x: columns left to right). Each connector
 * leaves and enters its box at a port of its own, spread along the facing side in the order of
 * the other ends, and connectors crossing the same gap get bend lines of their own (GV-3a).
 */
function elbowRoutes(boxes: Map<string, Box>, edges: LayoutEdge[], axis: 'x' | 'y', moved: CanvasAdjustments['bends'] = {}): Route[] {
  const main = (b: Box) => (axis === 'y' ? b.y : b.x);
  const size = (b: Box) => (axis === 'y' ? b.h : b.w);
  const cross = (b: Box) => (axis === 'y' ? b.x + b.w / 2 : b.y + b.h / 2);
  const crossSize = (b: Box) => (axis === 'y' ? b.w : b.h);
  const pt = (m: number, c: number): Point => (axis === 'y' ? { x: c, y: m } : { x: m, y: c });

  // For each connector: which end is first along the axis, and which sides it uses.
  type Leg = { e: LayoutEdge; a: string; b: string; same: boolean };
  const legs: Leg[] = edges.map((e) => {
    const f = boxes.get(e.from)!;
    const t = boxes.get(e.to)!;
    const same = Math.abs(main(f) - main(t)) < 1;
    const fFirst = same ? cross(f) <= cross(t) : main(f) < main(t);
    return { e, a: fFirst ? e.from : e.to, b: fFirst ? e.to : e.from, same };
  });

  // Ports: per box and side, connectors sorted by the cross position of their other end.
  const ports = new Map<string, number>();
  const sides = new Map<string, { leg: Leg; other: string }[]>();
  const add = (box: string, side: string, leg: Leg, other: string) => {
    const k = `${box}|${side}`;
    sides.set(k, [...(sides.get(k) ?? []), { leg, other }]);
  };
  for (const leg of legs) {
    // Connectors within one row leave and enter through the far side, so they run in the gap
    // after the row instead of across the cards between their ends.
    add(leg.a, 'after', leg, leg.b);
    add(leg.b, leg.same ? 'after' : 'before', leg, leg.a);
  }
  for (const [k, list] of sides) {
    const box = boxes.get(k.split('|')[0]!)!;
    const from = cross(box) - crossSize(box) / 2;
    list
      .sort((p, q) => cross(boxes.get(p.other)!) - cross(boxes.get(q.other)!) || p.leg.e.id.localeCompare(q.leg.e.id))
      .forEach(({ leg }, i) => ports.set(`${leg.e.id}|${k.split('|')[0]}`, from + ((i + 1) * crossSize(box)) / (list.length + 1)));
  }

  // Bend lines: connectors crossing the same gap share it, each at its own offset.
  const gaps = new Map<string, Leg[]>();
  for (const leg of legs) {
    const k = String(Math.round(main(boxes.get(leg.a)!) + size(boxes.get(leg.a)!)));
    gaps.set(k, [...(gaps.get(k) ?? []), leg]);
  }
  const bend = new Map<string, number>();
  for (const list of gaps.values()) {
    const top = main(boxes.get(list[0]!.a)!) + size(boxes.get(list[0]!.a)!);
    const across = list.filter((l) => !l.same);
    // Within-row connectors after the last row stay inside the canvas margin.
    const gap = across.length ? Math.min(...across.map((l) => main(boxes.get(l.b)!))) - top : MARGIN * 0.75;
    list
      .sort((p, q) => ports.get(`${p.e.id}|${p.a}`)! - ports.get(`${q.e.id}|${q.a}`)! || p.e.id.localeCompare(q.e.id))
      .forEach((l, i) => bend.set(l.e.id, top + ((i + 1) * gap) / (list.length + 1)));
  }

  return legs.map((leg) => {
    const A = boxes.get(leg.a)!;
    const B = boxes.get(leg.b)!;
    const pa = ports.get(`${leg.e.id}|${leg.a}`)!;
    const pb = ports.get(`${leg.e.id}|${leg.b}`)!;
    // A bend line the user dragged stays where they put it (GV-5b).
    const m = moved[leg.e.id] ?? bend.get(leg.e.id)!;
    const points = [pt(main(A) + size(A), pa), pt(m, pa), pt(m, pb), pt(main(B) + (leg.same ? size(B) : 0), pb)];
    if (leg.a !== leg.e.from) points.reverse();
    const s1 = points[1]!;
    const s2 = points[2]!;
    const mid = { x: (s1.x + s2.x) / 2, y: (s1.y + s2.y) / 2 };
    return { id: leg.e.id, points, bend: { axis, at: m }, label: { ...mid }, anchor: mid };
  });
}

/**
 * Straight connectors from box edge to box edge, labelled at the middle (Radial, Force). A curved
 * one (`curves`, the sideways push at its middle) is a quadratic curve that still ends on the
 * box edges, aimed at its control point.
 */
function straightRoutes(boxes: Map<string, Box>, edges: LayoutEdge[], curves: CanvasAdjustments['bends'] = {}): Route[] {
  return edges.map((e) => {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    const ca = centre(a);
    const cb = centre(b);
    const curve = curves[e.id] ?? 0;
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
    const normal = { x: -(cb.y - ca.y) / len, y: (cb.x - ca.x) / len };
    // The curve passes through mid + normal·curve when its control point is twice as far out.
    const control = curve ? { x: (ca.x + cb.x) / 2 + normal.x * curve * 2, y: (ca.y + cb.y) / 2 + normal.y * curve * 2 } : undefined;
    const p = edgePoint(a, control ?? cb);
    const q = edgePoint(b, control ?? ca);
    const mid = control
      ? { x: 0.25 * p.x + 0.5 * control.x + 0.25 * q.x, y: 0.25 * p.y + 0.5 * control.y + 0.25 * q.y }
      : { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    return { id: e.id, points: [p, q], control, curve, label: { ...mid }, anchor: mid };
  });
}

const centre = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

/** Where the line from the box's centre towards `to` leaves the box (ZM-5: connectors touch). */
export function edgePoint(b: Box, to: Point): Point {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (!dx && !dy) return c;
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

export const labelSize = (text: string) => ({ w: text.length * CHAR_W + 8, h: LABEL_H });

/**
 * Moves labels off each other and off node boxes: each label, in turn, tries its place and then
 * positions further along its connector's middle segment, alternating sides, until it is clear.
 */
function nudgeLabels(routes: Route[], edges: LayoutEdge[], boxes: Map<string, Box>) {
  const text = new Map(edges.map((e) => [e.id, e.label]));
  const placed: Box[] = [...boxes.values()];
  for (const r of routes) {
    const { w, h } = labelSize(text.get(r.id) ?? '');
    const mid = Math.floor((r.points.length - 1) / 2);
    const s1 = r.points[mid]!;
    const s2 = r.points[mid + 1]!;
    const len = Math.hypot(s2.x - s1.x, s2.y - s1.y) || 1;
    const ux = (s2.x - s1.x) / len;
    const uy = (s2.y - s1.y) / len;
    const at = (d: number): Box => ({ x: r.label.x + ux * d - w / 2, y: r.label.y + uy * d - h / 2, w, h });
    let best = at(0);
    for (let i = 0; i < 16; i++) {
      const d = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (Math.max(w, h) * 0.6);
      if (Math.abs(d) > len / 2 + w) continue;
      const cand = at(d);
      if (!placed.some((p) => overlaps(p, cand))) {
        best = cand;
        break;
      }
    }
    placed.push(best);
    r.label = { x: best.x + w / 2, y: best.y + h / 2 };
  }
}

export const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function adjacency(edges: LayoutEdge[]): Map<string, string[]> {
  const next = new Map<string, string[]>();
  for (const e of edges) {
    next.set(e.from, [...(next.get(e.from) ?? []), e.to]);
    next.set(e.to, [...(next.get(e.to) ?? []), e.from]);
  }
  return next;
}
