import { describe, expect, it } from 'vitest';
import { describeFilter, flowRank, flowStage, groupLabel, lensChips, lensNote, lensSearch, lensSpec, LENS_PHRASE, matchPhrases, stepAt, timeMark, changesSince, type Lens } from '../src';

const mastered: Lens = {
  id: 'mastered',
  name: 'Mastered data products',
  contour: { type: 'DataProduct', attributes: [{ attribute: 'lifecycle', op: 'eq', value: 'LIVE' }] },
  facets: [{ types: ['DataStore'], relationship: 'HOLDS', direction: 'IN', link: 'has' }],
  match: 'all',
  depth: 1,
  layout: 'hier',
  view: 'graph',
};

describe('lenses', () => {
  it('describe themselves for the picker and as locked chips', () => {
    expect(lensNote(mastered)).toBe('DataProduct · 1 facet');
    expect(lensNote({ ...mastered, facets: [] })).toBe('DataProduct');
    expect(lensChips(mastered)).toEqual(['DataProduct', 'Lifecycle LIVE', 'Linked to DataStore by HOLDS']);
    expect(lensChips({ ...mastered, contour: { type: 'Capability' }, facets: [{ types: ['Application'], direction: 'BOTH', link: 'none' }] })).toEqual([
      'Capability',
      'Not linked to Application',
    ]);
    expect(describeFilter({ attribute: 'criticality', op: 'in', value: ['HIGH', 'MISSION_CRITICAL'] })).toBe('Criticality HIGH or MISSION_CRITICAL');
    expect(describeFilter({ attribute: 'targetDate', op: 'gte', value: '2027-01-01' })).toBe('Target date at least 2027-01-01');
  });

  it('turn into a search; quick filters only narrow', () => {
    const quick = [{ attribute: 'ownerId', op: 'eq' as const, value: 'cdo', label: 'Owner cdo' }];
    expect(lensSearch(mastered, quick, ' client ')).toEqual({
      types: ['DataProduct'],
      name: 'client',
      attributes: [
        { attribute: 'lifecycle', op: 'eq', value: 'LIVE' },
        { attribute: 'ownerId', op: 'eq', value: 'cdo' },
      ],
      facets: mastered.facets,
      match: 'all',
    });
    // Not sure yet: every type.
    expect(lensSearch(null, [], 'pay')).toEqual({ types: undefined, name: 'pay', attributes: [], facets: [], match: 'all' });
  });

  it('from a catalog query: the query gives the roots, the smart bar overrides its parameter values', () => {
    const byQuery: Lens = { ...mastered, query: { id: 'q1', params: { owner: 'cdo', days: 30 } } };
    expect(lensNote(byQuery)).toBe('DataProduct · catalog query');
    expect(lensChips(byQuery)).toEqual(['DataProduct from a catalog query', 'Lifecycle LIVE']);
    expect(lensSearch(byQuery, [], '', { days: 7 })).toEqual({
      types: ['DataProduct'],
      name: undefined,
      attributes: [{ attribute: 'lifecycle', op: 'eq', value: 'LIVE' }],
      facets: [],
      match: 'all',
      query: { id: 'q1', params: { owner: 'cdo', days: 7 } },
    });
    expect(lensSearch({ ...byQuery, query: { id: 'q1', version: 3 } }, [], '').query).toEqual({ id: 'q1', version: 3, params: {} });
  });
});

describe('lens spec (D85)', () => {
  const old: Lens = { id: 'x', name: 'Old', contour: { type: 'Application' }, facets: [], match: 'all', depth: 3, layout: 'hier', view: 'graph' };
  it('fills in what an older lens implies: any relationship both ways, opened to its depth', () => {
    expect(lensSpec(old)).toEqual({ shape: 'ego', steps: [{ direction: 'both', repeat: true }], disclosure: { budget: 150, initialDepth: 3, perNodeCap: 12 } });
    expect(lensSpec({ ...old, shape: 'tree', steps: [{ kind: 'containment', direction: 'down', repeat: true }], disclosure: { budget: 999 } }).disclosure).toEqual({ budget: 350, initialDepth: 1, perNodeCap: 12 });
  });
  it('steps run out unless the last repeats', () => {
    const steps = [{ kind: 'ownership' as const, direction: 'down' as const }, { direction: 'both' as const }];
    expect(stepAt(steps, 1)).toBe(steps[1]);
    expect(stepAt(steps, 2)).toBeUndefined();
    expect(stepAt([{ direction: 'up', repeat: true }], 5)).toEqual({ direction: 'up', repeat: true });
  });
  it('names groups', () => {
    expect(groupLabel({ count: 14, type: 'DataStore', offset: 0 })).toBe('▸ 14 data stores');
    expect(groupLabel({ count: 3, type: 'CreditFacility', offset: 12 })).toBe('▸ 3 more credit facilities');
    expect(groupLabel({ count: 1, type: 'Drawdown', offset: 0 })).toBe('▸ 1 drawdown');
  });
});

describe('flow columns (D88)', () => {
  it('runs left to right, or right to left when every step goes up', () => {
    expect(flowRank([{ direction: 'down', repeat: true }], 2)).toBe(2);
    expect(flowRank([{ direction: 'up', repeat: true }], 2)).toBe(-2);
    expect(flowRank([{ direction: 'up' }, { direction: 'down' }], 1)).toBe(1);
  });

  it('names a column by its stage, else its types, else its level', () => {
    const steps = [{ direction: 'down' as const, stage: 'Apps' }, { direction: 'down' as const, types: ['DataSet', 'DataStore'] }, { direction: 'down' as const }];
    expect([0, 1, 2, 3, 4].map((l) => flowStage(steps, l))).toEqual(['Start', 'Apps', 'DataSet or DataStore', 'Level 3', 'Level 4']);
  });
});

describe('search phrases (D92)', () => {
  const impact: Lens = { ...mastered, id: 'impact', phrases: ['impact of $application', 'what breaks if $application goes', 'bad phrase'] };
  it('end in one slot', () => {
    expect(['impact of $application', 'lineage of $report'].every((p) => LENS_PHRASE.test(p))).toBe(true);
    expect(['$application', 'impact of', 'impact of $a and $b', 'impact $of x'].some((p) => LENS_PHRASE.test(p))).toBe(false);
  });
  it('fill the slot with what follows their words, and offer themselves while the words are typed', () => {
    expect(matchPhrases([impact], 'Impact of  Pay').map((m) => [m.phrase, m.rest])).toEqual([['impact of $application', 'Pay']]);
    expect(matchPhrases([impact], 'imp').map((m) => [m.words, m.rest])).toEqual([['impact of', '']]);
    expect(matchPhrases([impact], 'i')).toEqual([]);
    expect(matchPhrases([impact], 'payments')).toEqual([]);
  });
});

describe('lens layers (D95)', () => {
  const types = { Business: ['Capability', 'Process'], Application: ['Application'] } as Record<string, string[]>;
  const inLayers = (layers: readonly string[], t?: readonly string[]) => layers.flatMap((l) => types[l] ?? []).filter((x) => !t?.length || t.includes(x));
  const lens: Lens = { id: 'l', name: 'L', contour: { type: 'Capability' }, facets: [], match: 'all', depth: 2, layout: 'hier', view: 'graph' };
  it('keep each step to the types of the layers, and end the chain at a step that reaches none', () => {
    const steps = [{ direction: 'down' as const, types: ['Application'] }, { direction: 'down' as const, types: ['Process'] }];
    expect(lensSpec({ ...lens, steps, layers: ['Business'] }, inLayers).steps).toEqual([{ direction: 'both', repeat: true, types: ['Capability', 'Process'] }]);
    expect(lensSpec({ ...lens, steps, layers: ['Application'] }, inLayers).steps).toEqual([{ direction: 'down', types: ['Application'] }]);
    expect(lensSpec({ ...lens, layers: ['Business'] }, inLayers).steps).toEqual([{ direction: 'both', repeat: true, types: ['Capability', 'Process'] }]);
    expect(lensSpec({ ...lens, steps, layers: ['Business'] }).steps).toBe(steps);
  });
});

describe('time slices (D97)', () => {
  const y2027 = { from: '2027-01-01', to: '2028-01-01' };
  it('fade what is not valid in the range, and mark what starts or ends inside it', () => {
    expect(timeMark({ validFrom: null, validTo: null }, y2027)).toBeNull();
    expect(timeMark({ validTo: '2026-06-30' }, y2027)).toEqual({ kind: 'outside', label: 'Outside' });
    expect(timeMark({ validFrom: '2028-01-01' }, y2027)).toEqual({ kind: 'outside', label: 'Outside' });
    expect(timeMark({ validTo: '2027-09-30' }, y2027)).toEqual({ kind: 'ends', label: 'Ends 2027-09' });
    expect(timeMark({ validFrom: '2027-03-01' }, y2027)).toEqual({ kind: 'starts', label: 'Starts 2027-03' });
    expect(timeMark({ validFrom: '2027-03-01', validTo: '2027-09-30' }, y2027)).toMatchObject({ kind: 'ends' });
  });
  it('are no slice without a range', () => {
    expect(timeMark({ validTo: '2020-01-01' }, undefined)).toBeNull();
    expect(timeMark({ validTo: '2020-01-01' }, {})).toBeNull();
  });
});

describe('changes since an instant (D98)', () => {
  const ev = (type: string, subjectId: string, at: string, data: Record<string, unknown> = {}) => ({ type, subjectId, actor: `u-${at}`, occurredAt: at, data });
  it('fold into one change per item: added, changed with its fields, removed; created and removed is left out', () => {
    const events = [
      ev('ElementUpdated', 'a', 't1', { changes: { 'attrs.owner': {}, validTo: {} } }),
      ev('ElementCreated', 'b', 't2'),
      ev('ElementUpdated', 'b', 't3', { changes: { 'attrs.name': {} } }),
      ev('RelationshipDeleted', 'r', 't4'),
      ev('ElementCreated', 'c', 't5'),
      ev('ElementDeleted', 'c', 't6'),
      ev('ElementUpdated', 'a', 't7', { changes: { 'attrs.owner': {}, 'attrs.cost': {} } }),
    ];
    expect(changesSince(events)).toEqual([
      { id: 'a', change: 'changed', fields: ['owner', 'validTo', 'cost'], by: 'u-t7', at: 't7' },
      { id: 'b', change: 'added', fields: [], by: 'u-t3', at: 't3' },
      { id: 'r', change: 'removed', fields: [], by: 'u-t4', at: 't4' },
    ]);
  });
});
