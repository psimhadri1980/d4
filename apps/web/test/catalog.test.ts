import { describe, expect, it } from 'vitest';
import type { QueryParamDef, RunResult } from '../src/api';
import { paramsFromForm } from '../src/components/ParamForm';
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
