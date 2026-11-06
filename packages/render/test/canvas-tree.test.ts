import { describe, expect, it } from 'vitest';
import { CanvasTree, MAX_EXPANDED_PATHS } from '../src';

// r1 → iv → kyc ← r2, r1 → rc; kyc is reached from both roots, cp hangs off kyc and r2.
const tree = new CanvasTree({
  nodeIds: ['r1', 'r2', 'cp', 'iv', 'kyc', 'rc'],
  edges: [
    { from: 'r1', to: 'iv' },
    { from: 'r1', to: 'rc' },
    { from: 'iv', to: 'kyc' },
    { from: 'r2', to: 'kyc' },
    { from: 'kyc', to: 'cp' },
    { from: 'r2', to: 'cp' },
  ],
  rootIds: ['r1', 'r2'],
});
const shape = (rows: ReturnType<CanvasTree['rows']>) => rows.map((r) => `${'  '.repeat(r.level - 1)}${r.id}${r.repeat ? '*' : ''}(${r.childCount})`);

describe('CanvasTree', () => {
  it('shows the roots, expanded to level 1 by default, with dependents in display order', () => {
    expect(shape(tree.rows(new Set(['r1', 'r2'])))).toEqual(['r1(2)', '  iv(1)', '  rc(0)', 'r2(2)', '  cp(0)', '  kyc(1)']);
  });

  it('follows relationships both ways and tags later appearances as repeats', () => {
    const rows = tree.rows(new Set(['r1', 'r1/iv', 'r1/iv/kyc', 'r2']));
    // r2 is also reached from r1 (three hops away): it shows there too, marked as a root.
    expect(shape(rows)).toEqual(['r1(2)', '  iv(1)', '    kyc(2)', '      r2(0)', '      cp(0)', '  rc(0)', 'r2(2)', '  cp*(0)', '  kyc*(1)']);
    expect(rows.find((r) => r.path === 'r1/iv/kyc/r2')).toMatchObject({ root: true, repeat: false });
    expect(rows.find((r) => r.path === 'r1/iv/kyc')).toMatchObject({ level: 3, parentPath: 'r1/iv', expanded: true });
  });

  it('stops cycles: children are always one hop further from their root', () => {
    const ring = new CanvasTree({ nodeIds: ['a', 'b', 'c'], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }], rootIds: ['a'] });
    expect(shape(ring.rows(new Set(ring.allExpandable())))).toEqual(['a(2)', '  b(0)', '  c(0)']);
  });

  it('collapsed paths hide their subtree; Expand all lists every path with children', () => {
    expect(shape(tree.rows(new Set()))).toEqual(['r1(2)', 'r2(2)']);
    expect(tree.allExpandable()).toEqual(['r1', 'r2', 'r1/iv', 'r2/kyc', 'r1/iv/kyc', 'r2/kyc/iv', 'r2/kyc/iv/r1']);
    expect(tree.rows(new Set(['r1/iv'])).map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('caps Expand all on dense graphs', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    const edges = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ from: a, to: b })));
    const layered = new CanvasTree({ nodeIds: [...ids, 'z'], edges: [...edges.filter((e) => e.from === 'n0'), ...ids.slice(1).map((n) => ({ from: n, to: 'z' }))], rootIds: ['n0'] });
    expect(layered.allExpandable().length).toBeLessThanOrEqual(MAX_EXPANDED_PATHS);
    expect(layered.rows(new Set(layered.allExpandable())).filter((r) => r.id === 'z')).toHaveLength(39);
  });
});
