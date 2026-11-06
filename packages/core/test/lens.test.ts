import { describe, expect, it } from 'vitest';
import { describeFilter, lensChips, lensNote, lensSearch, type Lens } from '../src';

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
});
