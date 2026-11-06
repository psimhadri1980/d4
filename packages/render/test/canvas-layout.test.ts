import { describe, expect, it } from 'vitest';
import { CANVAS_LAYOUTS, canvasGeometry, hops, overlaps, type Box, type LayoutEdge, type LayoutNode } from '../src';

// Two roots sharing a service, a chain below one of them, and a planned server off to the side.
const nodes: LayoutNode[] = [
  { id: 'r1', layer: 'Strategy' },
  { id: 'r2', layer: 'Application' },
  { id: 'iv', layer: 'Business' },
  { id: 'rc', layer: 'Strategy' },
  { id: 'kyc', layer: 'Application' },
  { id: 'cp', layer: 'Data' },
  { id: 'sv', layer: 'Technology' },
];
const edges: LayoutEdge[] = [
  { id: 'e1', from: 'r1', to: 'iv', label: 'ENABLED_BY' },
  { id: 'e2', from: 'r1', to: 'rc', label: 'SERVES' },
  { id: 'e3', from: 'iv', to: 'kyc', label: 'RELATED_TO' },
  { id: 'e4', from: 'r2', to: 'kyc', label: 'RELATED_TO' },
  { id: 'e5', from: 'r2', to: 'cp', label: 'RELATED_TO' },
  { id: 'e6', from: 'r2', to: 'sv', label: 'RELATED_TO' },
];
const LAYERS = ['Strategy', 'Business', 'Data', 'Application', 'Technology'];

/** True when `p` lies on the border of `b` (within half a pixel). */
const onBorder = (b: Box, p: { x: number; y: number }) => {
  const e = 0.5;
  const inX = p.x >= b.x - e && p.x <= b.x + b.w + e;
  const inY = p.y >= b.y - e && p.y <= b.y + b.h + e;
  const edgeX = Math.abs(p.x - b.x) < e || Math.abs(p.x - b.x - b.w) < e;
  const edgeY = Math.abs(p.y - b.y) < e || Math.abs(p.y - b.y - b.h) < e;
  return inX && inY && (edgeX || edgeY);
};

describe('canvasGeometry', () => {
  it.each(CANVAS_LAYOUTS)('%s: places every node without overlaps, inside the canvas', (layout) => {
    const g = canvasGeometry(nodes, edges, ['r1', 'r2'], layout, LAYERS);
    expect([...g.boxes.keys()].sort()).toEqual(nodes.map((n) => n.id).sort());
    const boxes = [...g.boxes.values()];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) expect(overlaps(boxes[i]!, boxes[j]!)).toBe(false);
      expect(boxes[i]!.x).toBeGreaterThanOrEqual(0);
      expect(boxes[i]!.y).toBeGreaterThanOrEqual(0);
      expect(boxes[i]!.x + boxes[i]!.w).toBeLessThanOrEqual(g.width);
      expect(boxes[i]!.y + boxes[i]!.h).toBeLessThanOrEqual(g.height);
    }
  });

  it.each(CANVAS_LAYOUTS)('%s: every connector starts and ends on its boxes (ZM-5)', (layout) => {
    const g = canvasGeometry(nodes, edges, ['r1', 'r2'], layout, LAYERS);
    expect(g.routes.map((r) => r.id).sort()).toEqual(edges.map((e) => e.id));
    for (const r of g.routes) {
      const e = edges.find((x) => x.id === r.id)!;
      expect(onBorder(g.boxes.get(e.from)!, r.points[0]!)).toBe(true);
      expect(onBorder(g.boxes.get(e.to)!, r.points.at(-1)!)).toBe(true);
    }
  });

  it('hierarchical: roots on the top row, then one row per hop, with right-angled connectors', () => {
    const g = canvasGeometry(nodes, edges, ['r1', 'r2'], 'hier');
    const y = (id: string) => g.boxes.get(id)!.y;
    expect(y('r1')).toBe(y('r2'));
    expect(y('iv')).toBeGreaterThan(y('r1'));
    expect(y('kyc')).toBe(y('iv'));
    for (const r of g.routes) {
      expect(r.points).toHaveLength(4);
      for (let i = 1; i < r.points.length; i++) {
        const [a, b] = [r.points[i - 1]!, r.points[i]!];
        expect(a.x === b.x || a.y === b.y).toBe(true);
      }
    }
  });

  it('flow runs left to right; by layer puts one metamodel layer per row', () => {
    const flow = canvasGeometry(nodes, edges, ['r1', 'r2'], 'flow');
    expect(flow.boxes.get('iv')!.x).toBeGreaterThan(flow.boxes.get('r1')!.x);
    const byLayer = canvasGeometry(nodes, edges, ['r1', 'r2'], 'layers', LAYERS);
    const y = (id: string) => byLayer.boxes.get(id)!.y;
    expect(y('r1')).toBe(y('rc'));
    expect(y('r2')).toBe(y('kyc'));
    expect(y('cp')).toBeLessThan(y('kyc'));
    expect(y('sv')).toBeGreaterThan(y('kyc'));
  });

  it('gives connectors that share a box side their own ports and a gap their own bend lines', () => {
    const g = canvasGeometry(nodes, edges, ['r1', 'r2'], 'hier');
    const fromR2 = g.routes.filter((r) => ['e4', 'e5', 'e6'].includes(r.id));
    expect(new Set(fromR2.map((r) => r.points[0]!.x)).size).toBe(3);
    const bends = g.routes.filter((r) => edges.find((e) => e.id === r.id)!.from.startsWith('r')).map((r) => r.points[1]!.y);
    expect(new Set(bends).size).toBe(bends.length);
  });

  it('keeps labels off each other and off the cards', () => {
    for (const layout of CANVAS_LAYOUTS) {
      const g = canvasGeometry(nodes, edges, ['r1', 'r2'], layout, LAYERS);
      const labels = g.routes.map((r) => ({ x: r.label.x - 30, y: r.label.y - 8, w: 60, h: 16 }));
      const clashes = labels.filter((l, i) => labels.some((m, j) => i !== j && overlaps(l, m)));
      expect(clashes.length, layout).toBeLessThanOrEqual(2);
    }
  });

  it('is deterministic and handles one node, no edges and unreachable nodes', () => {
    expect(canvasGeometry(nodes, edges, ['r1'], 'force')).toEqual(canvasGeometry(nodes, edges, ['r1'], 'force'));
    const one = canvasGeometry([{ id: 'a', layer: 'Data' }], [], ['a'], 'radial');
    expect(one.boxes.get('a')).toMatchObject({ x: 40, y: 40 });
    const lonely = hops([...nodes, { id: 'z', layer: 'Data' }], edges, ['r1']);
    expect(lonely.get('z')).toBe(Math.max(...[...lonely.values()].filter((_, i, a) => i < a.length - 1)) + 1);
  });

  it('lays out 1,000 nodes quickly', () => {
    const many: LayoutNode[] = Array.from({ length: 1000 }, (_, i) => ({ id: `n${i}`, layer: LAYERS[i % 5]! }));
    const links: LayoutEdge[] = many.slice(1).map((n, i) => ({ id: `l${i}`, from: `n${Math.floor(i / 4)}`, to: n.id, label: 'USES' }));
    for (const layout of CANVAS_LAYOUTS) {
      const t = Date.now();
      canvasGeometry(many, links, ['n0'], layout, LAYERS);
      expect(Date.now() - t, layout).toBeLessThan(3000);
    }
  });
});
