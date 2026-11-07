import { describe, expect, it } from 'vitest';
import { queryRootIds } from '../src/studio';

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
