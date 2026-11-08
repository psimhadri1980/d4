import { describe, expect, it } from 'vitest';
import { formatLensText, parseLensText } from '../src';

const ok = (t: string) => {
  const r = parseLensText(t);
  if ('error' in r) throw new Error(r.error);
  return r.lens;
};
const error = (t: string) => (parseLensText(t) as { error: string }).error;

describe('lens text form (D93)', () => {
  it('reads levels, relationships, target types, filters and shape', () => {
    expect(ok('2+Application+2 via dependency where lifecycle=LIVE,criticality=HIGH|MISSION_CRITICAL as flow')).toEqual({
      contour: {
        type: 'Application',
        attributes: [
          { attribute: 'lifecycle', op: 'eq', value: 'LIVE' },
          { attribute: 'criticality', op: 'in', value: ['HIGH', 'MISSION_CRITICAL'] },
        ],
      },
      steps: [{ direction: 'both', repeat: true, kind: 'dependency' }],
      depth: 2,
      shape: 'flow',
    });
    expect(ok('DataStore+3 via USES,READS to Application').steps).toEqual([{ direction: 'down', repeat: true, relationships: ['USES', 'READS'], types: ['Application'] }]);
    expect(ok('1+DataProduct').steps).toEqual([{ direction: 'up', repeat: true }]);
    expect(ok('CreditFacility where limitAmount>=10000000,name~Swiss')).toMatchObject({ depth: 1, contour: { attributes: [{ op: 'gte', value: 10000000 }, { op: 'contains', value: 'Swiss' }] } });
  });

  it('says what is wrong', () => {
    expect(error('')).toMatch(/Start with a node type/);
    expect(error('application')).toMatch(/is not a node type/);
    expect(error('1+Application+2')).toMatch(/same number of levels/);
    expect(error('Application+9')).toMatch(/At most 6/);
    expect(error('Application via flow')).toMatch(/needs levels/);
    expect(error('Application+1 via sideways')).toMatch(/not a relationship kind/);
    expect(error('Application where lifecycle')).toMatch(/not a filter/);
    expect(error('Application as pie')).toMatch(/not a shape/);
    expect(error('Application as tree as flow')).toMatch(/given twice/);
    expect(error('Application with x')).toMatch(/not via, to, where or as/);
  });

  it('writes a lens back, the same text it was read from, or null when the form cannot say it', () => {
    for (const t of ['2+Application+2 via dependency where lifecycle=LIVE,criticality=HIGH|MISSION_CRITICAL as flow', 'DataStore+3 via USES,READS to Application', 'Capability', 'CreditFacility where limitAmount>=10000000'])
      expect(formatLensText({ ...ok(t), facets: [] })).toBe(t);
    const base = { contour: { type: 'DataProduct' }, depth: 1, facets: [] };
    expect(formatLensText({ ...base, facets: [{ types: ['DataStore'], direction: 'IN', link: 'has' }] })).toBeNull();
    expect(formatLensText({ ...base, steps: [{ direction: 'down' }, { direction: 'down' }] })).toBeNull();
    expect(formatLensText({ ...base, steps: [{ direction: 'down', stage: 'Apps', repeat: true }] })).toBeNull();
    expect(formatLensText({ ...base, contour: { type: 'DataProduct', attributes: [{ attribute: 'name', op: 'contains', value: 'two words' }] } })).toBeNull();
  });
});
