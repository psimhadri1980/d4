import { describe, expect, it } from 'vitest';
import { applyCanvasFilter, kindCounts, NO_FILTER } from '../src';

// app (root) → db (Database), app → srv (Server) → disk (Storage), app → api (Interface) → srv2 (Server)
const nodes = [
  { id: 'app', type: 'Application' },
  { id: 'db', type: 'Database' },
  { id: 'srv', type: 'Server' },
  { id: 'disk', type: 'Storage' },
  { id: 'api', type: 'Interface' },
  { id: 'srv2', type: 'Server' },
];
const edges = [
  { from: 'app', to: 'db', type: 'USES' },
  { from: 'app', to: 'srv', type: 'RUNS_ON' },
  { from: 'srv', to: 'disk', type: 'USES' },
  { from: 'app', to: 'api', type: 'EXPOSES' },
  { from: 'api', to: 'srv2', type: 'RUNS_ON' },
];
const ids = (r: { nodes: { id: string }[] }) => r.nodes.map((n) => n.id);

describe('applyCanvasFilter', () => {
  it('shows everything by default', () => {
    expect(applyCanvasFilter(nodes, edges, ['app'], NO_FILTER)).toEqual({ nodes, edges });
  });

  it('ticked node types show only those, keeping roots, and drop what is reached only through hidden nodes', () => {
    const r = applyCanvasFilter(nodes, edges, ['app'], { nodeTypes: ['Server'], relationshipTypes: [] });
    // srv2 is only reachable through the hidden Interface.
    expect(ids(r)).toEqual(['app', 'srv']);
    expect(r.edges).toEqual([edges[1]]);
    // Each further tick widens the view.
    expect(ids(applyCanvasFilter(nodes, edges, ['app'], { nodeTypes: ['Server', 'Interface'], relationshipTypes: [] }))).toEqual(['app', 'srv', 'api', 'srv2']);
  });

  it('ticked relationship types show only those, and the nodes they reach', () => {
    const r = applyCanvasFilter(nodes, edges, ['app'], { nodeTypes: [], relationshipTypes: ['USES'] });
    // disk hangs off srv, which is reached only by RUNS_ON.
    expect(ids(r)).toEqual(['app', 'db']);
    expect(r.edges).toEqual([edges[0]]);
  });

  it('combines both lists', () => {
    const r = applyCanvasFilter(nodes, edges, ['app'], { nodeTypes: ['Server', 'Storage'], relationshipTypes: ['RUNS_ON', 'USES'] });
    expect(ids(r)).toEqual(['app', 'srv', 'disk']);
  });
});

describe('kindCounts', () => {
  it('counts each node and relationship type, sorted by name', () => {
    expect(kindCounts(nodes, edges)).toEqual({
      nodeTypes: [
        { type: 'Application', count: 1 },
        { type: 'Database', count: 1 },
        { type: 'Interface', count: 1 },
        { type: 'Server', count: 2 },
        { type: 'Storage', count: 1 },
      ],
      relationshipTypes: [
        { type: 'EXPOSES', count: 1 },
        { type: 'RUNS_ON', count: 2 },
        { type: 'USES', count: 2 },
      ],
    });
  });
});
