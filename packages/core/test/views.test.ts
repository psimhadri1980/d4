import { describe, expect, it } from 'vitest';
import { applyView, diffModels, visibleIn, type Element, type ModelSnapshot, type Relationship } from '../src';

type Sys = { validFrom?: string | null; validTo?: string | null; scenarioId?: string | null; deleted?: boolean };
const sys = (id: string, s: Sys = {}) => ({
  id,
  workspaceId: 'ws1',
  version: 1,
  validFrom: s.validFrom ?? null,
  validTo: s.validTo ?? null,
  scenarioId: s.scenarioId ?? null,
  deleted: s.deleted ?? false,
  createdAt: '2026-10-17T00:00:00Z',
  createdBy: 'test',
  updatedAt: '2026-10-17T00:00:00Z',
  updatedBy: 'test',
});
const el = (id: string, type: string, s: Sys = {}): Element => ({ ...sys(id, s), type, attrs: { name: id } });
const rel = (id: string, fromId: string, toId: string, attrs: Record<string, unknown>, s: Sys = {}): Relationship => ({
  ...sys(id, s),
  type: 'HOLDS',
  fromId,
  toId,
  attrs,
});

/** The client-master hand-over from the sample, plus a scenario that brings it forward. */
const model: ModelSnapshot = {
  elements: [
    el('Client', 'DataProduct'),
    el('Legacy', 'DataStore', { validTo: '2028-01-01' }),
    el('MDM', 'DataStore', { validFrom: '2027-01-01' }),
    el('Fast', 'Scenario'),
    el('Cache', 'DataStore', { scenarioId: 'Fast' }),
    el('Gone', 'DataStore', { deleted: true }),
  ],
  relationships: [
    rel('legacy-master', 'Legacy', 'Client', { role: 'MASTER' }, { validTo: '2027-07-01' }),
    rel('legacy-replica', 'Legacy', 'Client', { role: 'REPLICA' }, { validFrom: '2027-07-01', validTo: '2027-12-31' }),
    rel('mdm-master', 'MDM', 'Client', { role: 'MASTER' }, { validFrom: '2027-07-01' }),
    // The scenario brings the hand-over forward by redefining both stores' HOLDS.
    rel('legacy-master-fast', 'Legacy', 'Client', { role: 'MASTER' }, { validTo: '2027-04-01', scenarioId: 'Fast' }),
    rel('mdm-master-early', 'MDM', 'Client', { role: 'MASTER' }, { validFrom: '2027-04-01', scenarioId: 'Fast' }),
    rel('cache', 'Cache', 'Client', { role: 'CONSUMER_CACHE' }, { scenarioId: 'Fast' }),
  ],
};

describe('visibleIn', () => {
  it('uses half-open validity and hides deleted items', () => {
    const p = { validFrom: '2027-01-01', validTo: '2027-07-01', scenarioId: null, deleted: false };
    expect(visibleIn(p, { asOf: '2027-01-01' })).toBe(true);
    expect(visibleIn(p, { asOf: '2027-07-01' })).toBe(false);
    expect(visibleIn(p, { asOf: '2026-12-31' })).toBe(false);
    expect(visibleIn(p)).toBe(true);
    expect(visibleIn({ ...p, deleted: true })).toBe(false);
  });

  it('shows scenario items only in their scenario, on top of the baseline', () => {
    const s = { validFrom: null, validTo: null, scenarioId: 'Fast', deleted: false };
    expect(visibleIn(s)).toBe(false);
    expect(visibleIn(s, { scenarioId: 'Fast' })).toBe(true);
    expect(visibleIn(s, { scenarioId: 'Other' })).toBe(false);
    expect(visibleIn({ ...s, scenarioId: null }, { scenarioId: 'Fast' })).toBe(true);
  });
});

describe('applyView', () => {
  it('drops relationships whose ends are not visible', () => {
    const v = applyView(model, { asOf: '2026-11-01' });
    expect(v.elements.map((e) => e.id)).toEqual(['Client', 'Legacy', 'Fast']);
    expect(v.relationships.map((r) => r.id)).toEqual(['legacy-master']);
  });
});

describe('diffModels', () => {
  it('pairs a replaced relationship as a change and lists additions', () => {
    const d = diffModels(model, { asOf: '2027-03-01' }, { asOf: '2027-08-01' });
    expect(d.elements).toEqual({ added: [], removed: [] });
    expect(d.relationships.added.map((r) => r.id)).toEqual(['mdm-master']);
    expect(d.relationships.removed).toEqual([]);
    expect(d.relationships.changed).toHaveLength(1);
    const c = d.relationships.changed[0]!;
    expect([c.before.id, c.after.id]).toEqual(['legacy-master', 'legacy-replica']);
    expect(c.fields).toEqual([
      { field: 'role', before: 'MASTER', after: 'REPLICA' },
      { field: 'validFrom', before: null, after: '2027-07-01' },
      { field: 'validTo', before: '2027-07-01', after: '2027-12-31' },
    ]);
  });

  it('compares the baseline with a scenario on the same date', () => {
    const d = diffModels(model, { asOf: '2027-05-01' }, { asOf: '2027-05-01', scenarioId: 'Fast' });
    expect(d.elements.added.map((e) => e.id)).toEqual(['Cache']);
    expect(d.relationships.added.map((r) => r.id).sort()).toEqual(['cache', 'mdm-master-early']);
    // The baseline legacy master is replaced by the scenario's, which already ended.
    expect(d.relationships.removed.map((r) => r.id)).toEqual(['legacy-master']);
    expect(d.elements.removed).toEqual([]);
  });

  it('lets a scenario replace baseline relationships between the same elements', () => {
    const masters = (v: { asOf: string; scenarioId?: string }) =>
      applyView(model, v).relationships.filter((r) => r.attrs['role'] === 'MASTER').map((r) => r.fromId);
    expect(masters({ asOf: '2027-05-01' })).toEqual(['Legacy']);
    expect(masters({ asOf: '2027-05-01', scenarioId: 'Fast' })).toEqual(['MDM']);
    expect(masters({ asOf: '2027-03-01', scenarioId: 'Fast' })).toEqual(['Legacy']);
    // The baseline replica after the hand-over is replaced too: the scenario did not define one.
    expect(applyView(model, { asOf: '2027-08-01', scenarioId: 'Fast' }).relationships.some((r) => r.id === 'legacy-replica')).toBe(false);
  });

  it('reports elements that disappear', () => {
    const d = diffModels(model, { asOf: '2027-12-30' }, { asOf: '2028-01-01' });
    expect(d.elements.removed.map((e) => e.id)).toEqual(['Legacy']);
    expect(d.relationships.removed.map((r) => r.id)).toEqual(['legacy-replica']);
  });
});
