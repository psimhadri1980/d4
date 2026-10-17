import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { validateModel, type Element, type Relationship } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());

const sys = (id: string) => ({
  id,
  workspaceId: 'ws1',
  version: 1,
  validFrom: null,
  validTo: null,
  scenarioId: null,
  deleted: false,
  createdAt: '2026-10-17T00:00:00Z',
  createdBy: 'test',
  updatedAt: '2026-10-17T00:00:00Z',
  updatedBy: 'test',
});
const el = (id: string, type: string, attrs: Record<string, unknown> = {}): Element => ({
  ...sys(id),
  type,
  attrs: { name: id, ...attrs },
});
const rel = (id: string, type: string, fromId: string, toId: string, attrs = {}): Relationship => ({
  ...sys(id),
  type,
  fromId,
  toId,
  attrs,
});

describe('validateModel', () => {
  it('accepts a valid model', () => {
    const issues = validateModel(reg, {
      elements: [el('dp', 'DataProduct'), el('s1', 'DataStore'), el('s2', 'DataStore')],
      relationships: [
        rel('r1', 'HOLDS', 's1', 'dp', { role: 'MASTER' }),
        rel('r2', 'HOLDS', 's2', 'dp', { role: 'APPROVED_DISTRIBUTOR' }),
      ],
    });
    expect(issues).toEqual([]);
  });

  it('reports every problem at once', () => {
    const issues = validateModel(reg, {
      elements: [
        el('dp', 'DataProduct', { lifecycle: 'SOMEDAY' }),
        el('s1', 'DataStore'),
        el('s2', 'DataStore'),
        el('d1', 'Deliverable'),
        el('d2', 'Deliverable'),
      ],
      relationships: [
        rel('r1', 'HOLDS', 's1', 'dp', { role: 'MASTER' }),
        rel('r2', 'HOLDS', 's2', 'dp', { role: 'MASTER' }),
        rel('r3', 'DEPENDS_ON', 'd1', 'd2'),
        rel('r4', 'DEPENDS_ON', 'd2', 'd1'),
        rel('r5', 'OWNS', 'ghost', 'dp'),
      ],
    });
    expect(issues.map((i) => i.ruleId ?? i.subjectId)).toEqual(
      expect.arrayContaining(['dp', 'r5', 'single-master-per-data-product', 'no-dependency-cycles']),
    );
    expect(issues.find((i) => i.ruleId === 'no-dependency-cycles')?.message).toMatch(/d1 → d2 → d1/);
  });
});
