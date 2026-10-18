import type { Element, Relationship } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import { COLORS, esc, frame, LAYER_COLORS, num, truncate, type Svg } from './svg';

export interface Point {
  x: number;
  y: number;
}

/** Hops from the root over relationships in either direction (breadth first). */
export function hopDistances(rootId: string, relationships: { fromId: string; toId: string }[]): Map<string, number> {
  const next = new Map<string, string[]>();
  for (const r of relationships) {
    next.set(r.fromId, [...(next.get(r.fromId) ?? []), r.toId]);
    next.set(r.toId, [...(next.get(r.toId) ?? []), r.fromId]);
  }
  const dist = new Map([[rootId, 0]]);
  const queue = [rootId];
  for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
    for (const n of next.get(cur) ?? []) {
      if (!dist.has(n)) {
        dist.set(n, dist.get(cur)! + 1);
        queue.push(n);
      }
    }
  }
  return dist;
}

/** Arc length each node needs on its ring (label width plus a gap). */
export const NODE_SPACING = 120;
const RING_GAP = 150;

/**
 * Deterministic radial layout: the root in the centre, one ring per hop. Ring radii grow so that
 * nodes on a ring are at least NODE_SPACING apart, and nodes follow their parent's angle, which
 * keeps edges short and mostly free of crossings. Unreachable nodes go on an outer ring.
 */
export function radialLayout(rootId: string, ids: string[], relationships: { fromId: string; toId: string }[]): Map<string, Point> {
  const dist = hopDistances(rootId, relationships);
  const maxHop = Math.max(0, ...[...dist.values()]);
  const ring = (id: string) => dist.get(id) ?? maxHop + 1;
  const rings = new Map<number, string[]>();
  for (const id of [...new Set([rootId, ...ids])].sort()) rings.set(ring(id), [...(rings.get(ring(id)) ?? []), id]);

  const neighbours = new Map<string, string[]>();
  for (const r of relationships) {
    neighbours.set(r.fromId, [...(neighbours.get(r.fromId) ?? []), r.toId]);
    neighbours.set(r.toId, [...(neighbours.get(r.toId) ?? []), r.fromId]);
  }
  const pos = new Map<string, Point>([[rootId, { x: 0, y: 0 }]]);
  const angle = new Map<string, number>([[rootId, 0]]);
  let radius = 0;
  for (const k of [...rings.keys()].sort((a, b) => a - b)) {
    if (k === 0) continue;
    const list = rings.get(k)!;
    // Order by the mean angle of already placed neighbours (barycentre), then by id.
    const target = (id: string) => {
      const as = (neighbours.get(id) ?? []).filter((n) => angle.has(n) && ring(n) < k).map((n) => angle.get(n)!);
      return as.length ? Math.atan2(as.reduce((s, a) => s + Math.sin(a), 0), as.reduce((s, a) => s + Math.cos(a), 0)) : Math.PI;
    };
    const sorted = list.map((id) => ({ id, t: target(id) })).sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    radius = Math.max(radius + RING_GAP, (sorted.length * NODE_SPACING) / (2 * Math.PI));
    const step = (2 * Math.PI) / sorted.length;
    // Start where the first node wants to be, so a small ring sits next to its parents.
    const start = sorted[0]!.t;
    sorted.forEach(({ id }, n) => {
      const a = start + n * step;
      angle.set(id, a);
      pos.set(id, { x: radius * Math.cos(a), y: radius * Math.sin(a) });
    });
  }
  return pos;
}

const NODE_R = 9;
const PAD = 90;

/**
 * An element's neighbourhood as SVG: nodes coloured by layer with name and type, relationship
 * types on the edges, dashed edges for relationships not yet valid on the view date, a legend.
 */
export function graphSvg(
  g: { root: Element; elements: Element[]; relationships: Relationship[] },
  reg: MetamodelRegistry,
  opts: { title: string; subtitle?: string; asOf?: string },
): Svg {
  const all = new Map([g.root, ...g.elements].map((e) => [e.id, e]));
  const rels = g.relationships.filter((r) => all.has(r.fromId) && all.has(r.toId));
  const pos = radialLayout(g.root.id, [...all.keys()], rels);
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const header = 60;
  const legendH = 30;
  const width = Math.max(640, Math.max(...xs) - minX + PAD);
  const height = Math.max(...ys) - minY + PAD + header + legendH;
  const at = (id: string) => {
    const p = pos.get(id)!;
    return { x: p.x - minX, y: p.y - minY + header };
  };
  const layer = (e: Element) => reg.nodeType(e.type)?.layer ?? 'System';
  const today = opts.asOf ?? new Date().toISOString().slice(0, 10);

  const b: string[] = [];
  // A white outline behind labels keeps them readable where edges pass underneath.
  const halo = `stroke="${COLORS.layer01}" stroke-width="4" stroke-linejoin="round" paint-order="stroke"`;
  b.push(`<text x="16" y="26" font-size="18" font-weight="600" fill="${COLORS.text}">${esc(opts.title)}</text>`);
  const sub = [opts.subtitle, `${all.size} elements · ${rels.length} relationships`, opts.asOf ? `as of ${opts.asOf}` : ''].filter(Boolean).join(' · ');
  b.push(`<text x="16" y="44" fill="${COLORS.textSecondary}">${esc(sub)}</text>`);

  // Several relationships between the same two elements (e.g. MASTER, then REPLICA over time)
  // share one line and one combined label.
  const pairs = new Map<string, Relationship[]>();
  for (const r of [...rels].sort((a, c) => a.id.localeCompare(c.id))) {
    const k = [r.fromId, r.toId].sort().join('|');
    pairs.set(k, [...(pairs.get(k) ?? []), r]);
  }
  const edgeLabels: string[] = [];
  for (const unordered of pairs.values()) {
    // In time order, so a hand-over reads "MASTER · REPLICA".
    const group = [...unordered].sort((x, y) => (x.validFrom ?? '').localeCompare(y.validFrom ?? '') || x.id.localeCompare(y.id));
    const r = group[0]!;
    const a = at(r.fromId);
    const z = at(r.toId);
    const future = group.every((x) => !!x.validFrom && x.validFrom > today);
    b.push(`<line x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(z.x)}" y2="${num(z.y)}" stroke="${COLORS.edge}" stroke-width="1"${future ? ' stroke-dasharray="5 4"' : ''}/>`);
    const label = [
      ...new Set(
        group.map((x) => {
          const detail = x.attrs['role'] ?? x.attrs['op'] ?? x.attrs['action'];
          return `${x.type}${detail ? ` (${String(detail)})` : ''}`;
        }),
      ),
    ].join(' · ');
    const mx = (a.x + z.x) / 2;
    const my = (a.y + z.y) / 2;
    const rot = (Math.atan2(z.y - a.y, z.x - a.x) * 180) / Math.PI;
    const upright = rot > 90 || rot < -90 ? rot + 180 : rot;
    edgeLabels.push(`<text x="${num(mx)}" y="${num(my - 3)}" font-size="9" fill="${COLORS.textSecondary}" ${halo} text-anchor="middle" transform="rotate(${num(upright)} ${num(mx)} ${num(my)})">${esc(label)}</text>`);
  }
  // Labels after every line, so no edge crosses over one.
  b.push(...edgeLabels);
  for (const [id, e] of [...all].sort(([a], [c]) => a.localeCompare(c))) {
    const p = at(id);
    const isRoot = id === g.root.id;
    const fill = LAYER_COLORS[layer(e)] ?? COLORS.borderStrong;
    b.push(`<circle cx="${num(p.x)}" cy="${num(p.y)}" r="${isRoot ? NODE_R + 5 : NODE_R}" fill="${fill}" stroke="${isRoot ? COLORS.text : COLORS.layer01}" stroke-width="${isRoot ? 3 : 2}"/>`);
    b.push(`<text x="${num(p.x)}" y="${num(p.y + NODE_R + 16)}" text-anchor="middle" fill="${COLORS.text}" ${halo}${isRoot ? ' font-weight="600"' : ''}>${esc(truncate(String(e.attrs['name'] ?? e.id), 28))}</text>`);
    b.push(`<text x="${num(p.x)}" y="${num(p.y + NODE_R + 29)}" text-anchor="middle" font-size="10" fill="${COLORS.textSecondary}" ${halo}>${esc(e.type)}</text>`);
  }
  const layers = [...new Set([...all.values()].map(layer))].sort();
  layers.forEach((l, n) => {
    b.push(
      `<g transform="translate(${16 + n * 120},${num(height - 14)})"><circle cx="5" cy="-4" r="5" fill="${LAYER_COLORS[l] ?? COLORS.borderStrong}"/><text x="16" y="0" fill="${COLORS.textSecondary}">${esc(l)}</text></g>`,
    );
  });
  return frame(width, height, b, opts.title);
}
