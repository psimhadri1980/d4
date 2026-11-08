import { describe, expect, it } from 'vitest';
import { queryProjection, queryRootIds } from '../src/studio';

const node = (id: string, labels = ['Element', 'Application']) => ({ elementId: `4:x:${id}`, labels, properties: { id, name: id } });

describe('query lens roots', () => {
  it('take the id column, in order and without repeats', () => {
    expect(queryRootIds({ columns: ['id', 'name'], rows: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, { id: 3 }] })).toEqual(['b', 'a']);
  });

  it('else every element node in the rows, lists included', () => {
    const rows = [{ app: node('a'), stores: [node('s1'), node('s2')] }, { app: node('a'), other: node('x', ['Tenant']) }];
    expect(queryRootIds({ columns: ['app', 'stores'], rows })).toEqual(['a', 's1', 's2']);
  });

  it('are empty when the rows hold neither', () => {
    expect(queryRootIds({ columns: ['n'], rows: [{ n: 4 }] })).toEqual([]);
  });
});

describe('query projections (D94)', () => {
  it('are queries with a node column: nodes in order, parent links with their relationship, anchors where no link leads', () => {
    const rows = [{ node: 'a', parent: null }, { node: node('b'), parent: 'a', rel: 'USES' }, { node: 'c', parent: 'b' }, { node: 'b', parent: 'a', rel: 'USES' }];
    expect(queryProjection({ columns: ['node', 'parent', 'rel'], rows })).toEqual({
      nodeIds: ['a', 'b', 'c'],
      links: [{ from: 'a', to: 'b', rel: 'USES' }, { from: 'b', to: 'c' }],
      anchorIds: ['a'],
      levels: {},
      weights: {},
    });
  });

  it('take from, anchor and level when given', () => {
    const rows = [{ node: 'a', anchor: false, level: 2 }, { node: 'b', from: 'a', anchor: true, level: 0 }];
    expect(queryProjection({ columns: ['node', 'from', 'anchor', 'level'], rows })).toMatchObject({ anchorIds: ['b'], levels: { a: 2, b: 0 }, links: [{ from: 'a', to: 'b' }] });
  });

  it('take the highest weight a node is given, and name the row whose weight is not a number (D96)', () => {
    const rows = [{ node: 'a', weight: 1 }, { node: 'b', weight: { toNumber: () => 5 } }, { node: 'a', weight: 3 }, { node: 'c', weight: null }];
    expect(queryProjection({ columns: ['node', 'weight'], rows })).toMatchObject({ weights: { a: 3, b: 5 } });
    expect(queryProjection({ columns: ['node', 'weight'], rows: [{ node: 'a', weight: 'high' }] })).toEqual({ error: 'Row 1: the weight column must be a number' });
  });

  it('are not projections without a node column, and name the row whose node is not an element', () => {
    expect(queryProjection({ columns: ['id'], rows: [{ id: 'a' }] })).toBeNull();
    expect(queryProjection({ columns: ['node'], rows: [{ node: 'a' }, { node: 4 }] })).toEqual({ error: 'Row 2: the node column must be an element id or an element node' });
  });
});
