import { describe, expect, it } from 'vitest';
import type { QueryParamDef, RunResult } from '../src/api';
import { paramsFromForm } from '../src/components/ParamForm';
import { hopDistances } from '../src/components/GraphCanvas';
import { graphFromRows } from '../src/components/QueryResultView';
import { toCsv } from '../src/components/ResultTable';

describe('paramsFromForm', () => {
  const defs: QueryParamDef[] = [
    { name: 'element', type: 'element', required: true },
    { name: 'depth', type: 'integer' },
    { name: 'types', type: 'string[]' },
    { name: 'flag', type: 'boolean' },
    { name: 'asOf', type: 'date' },
  ];

  it('converts form text to typed params and leaves blanks out', () => {
    expect(paramsFromForm(defs, { element: '01M55H69QB6DW04HJM23564S16', depth: '3', types: 'Platform, Application', flag: true, asOf: '' })).toEqual({
      element: '01M55H69QB6DW04HJM23564S16',
      depth: 3,
      types: ['Platform', 'Application'],
      flag: true,
    });
    expect(paramsFromForm(defs, { flag: false })).toEqual({});
  });
});

describe('toCsv', () => {
  it('quotes values and flattens lists and graph objects', () => {
    const r: RunResult = {
      columns: ['name', 'changes', 'node'],
      rows: [{ name: 'A, "quoted"', changes: ['x (RETIRE)', 'y'], node: { properties: { name: 'Mainframe' } } }],
      truncated: false,
      durationMs: 1,
      queryId: 'q',
      version: 1,
      status: 'published',
    };
    expect(toCsv(r)).toBe('name,changes,node\n"A, ""quoted""","x (RETIRE), y",Mainframe');
  });
});

describe('graphFromRows', () => {
  const node = (eid: string, id: string, type: string, name: string) => ({
    elementId: eid,
    labels: ['Element', type],
    properties: { id, type, name, workspaceId: 'ws', version: 1 },
  });
  const rel = (eid: string, type: string, s: string, e: string, extra: Record<string, unknown> = {}) => ({
    elementId: eid,
    type,
    startNodeId: s,
    endNodeId: e,
    properties: { id: `R${eid}`, ...extra },
  });

  it('collects nodes and relationships from paths nested in lists, using D4 ids', () => {
    const dp = node('n1', 'DP', 'DataProduct', 'Client Master');
    const store = node('n2', 'DS', 'DataStore', 'MDM Hub');
    const step = node('n3', 'ST', 'ProcessStep', 'Capture');
    const rows = [
      {
        product: dp,
        paths: [
          { start: dp, end: store, segments: [{ start: store, relationship: rel('r1', 'HOLDS', 'n2', 'n1', { role: 'MASTER' }), end: dp }] },
          { start: dp, end: step, segments: [{ start: step, relationship: rel('r2', 'ACTS_ON', 'n3', 'n1'), end: dp }] },
        ],
      },
    ];
    const g = graphFromRows(rows);
    expect(g.elements.map((e) => `${e.id}:${e.type}:${String(e.attrs['name'])}`).sort()).toEqual([
      'DP:DataProduct:Client Master',
      'DS:DataStore:MDM Hub',
      'ST:ProcessStep:Capture',
    ]);
    expect(g.relationships.map((r) => `${r.fromId}-${r.type}->${r.toId}`).sort()).toEqual(['DS-HOLDS->DP', 'ST-ACTS_ON->DP']);
    expect(g.relationships.find((r) => r.type === 'HOLDS')?.attrs['role']).toBe('MASTER');
    expect(g.elements[0]!.attrs).not.toHaveProperty('workspaceId');
  });

  it('drops relationships whose endpoints are not in the result', () => {
    const g = graphFromRows([{ r: rel('r9', 'OWNS', 'x', 'y'), n: node('n1', 'A', 'Platform', 'K8s') }]);
    expect(g.elements).toHaveLength(1);
    expect(g.relationships).toEqual([]);
  });
});

describe('hopDistances', () => {
  it('measures undirected hops from the root; unreachable nodes are absent', () => {
    const d = hopDistances('A', [
      { fromId: 'B', toId: 'A' },
      { fromId: 'B', toId: 'C' },
      { fromId: 'D', toId: 'C' },
      { fromId: 'X', toId: 'Y' },
    ]);
    expect(Object.fromEntries(d)).toEqual({ A: 0, B: 1, C: 2, D: 3 });
  });
});

describe('parseTabs', () => {
  it('reads tabs from the URL, ignoring junk and duplicates', async () => {
    const { parseTabs } = await import('../src/pages/Queries');
    expect(parseTabs('run:A,edit:B,run:A,bogus:C,review:,review:D')).toEqual([
      { mode: 'run', id: 'A' },
      { mode: 'edit', id: 'B' },
      { mode: 'review', id: 'D' },
    ]);
    expect(parseTabs(null)).toEqual([]);
  });
});
