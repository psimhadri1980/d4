import { describe, expect, it } from 'vitest';
import { canvasOverview } from '../src';

const nodes = [
  ...Array.from({ length: 9 }, (_, i) => ({ id: `a${i}`, type: 'Application', layer: 'Application' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `s${i}`, type: 'Server', layer: 'Technology' })),
  { id: 'd0', type: 'DataStore', layer: 'Data' },
];
const edges = [
  { from: 'a0', to: 's0' },
  { from: 's1', to: 'a1' },
  { from: 'a2', to: 's2' },
  { from: 'a0', to: 'd0' },
  { from: 'a0', to: 'a1' },
];

describe('canvasOverview', () => {
  it('has one bubble per type, sized by count, with the largest in the middle', () => {
    const o = canvasOverview(nodes, edges);
    expect(o.bubbles.map((b) => [b.type, b.count])).toEqual([
      ['Application', 9],
      ['Server', 4],
      ['DataStore', 1],
    ]);
    const [app, srv, ds] = o.bubbles;
    expect(app!.r).toBeGreaterThan(srv!.r);
    expect(srv!.r).toBeGreaterThan(ds!.r);
    // No bubble overlaps another, and all fit in the drawing.
    for (const p of o.bubbles) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(0);
      expect(p.y + p.r).toBeLessThanOrEqual(o.height);
      for (const q of o.bubbles) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r);
    }
  });

  it('joins linked types once per pair, counting relationships both ways, and within a type', () => {
    expect(canvasOverview(nodes, edges).links).toEqual([
      { a: 'Application', b: 'Server', count: 3 },
      { a: 'Application', b: 'Application', count: 1 },
      { a: 'Application', b: 'DataStore', count: 1 },
    ]);
  });

  it('places many types without overlap', () => {
    const many = Array.from({ length: 40 }, (_, t) => Array.from({ length: (t % 7) + 1 }, (_, i) => ({ id: `${t}-${i}`, type: `Type${t}`, layer: 'Data' }))).flat();
    const o = canvasOverview(many, []);
    expect(o.bubbles).toHaveLength(40);
    for (const p of o.bubbles) for (const q of o.bubbles) if (p !== q) expect(Math.hypot(p.x - q.x, p.y - q.y)).toBeGreaterThan(p.r + q.r);
  });
});
