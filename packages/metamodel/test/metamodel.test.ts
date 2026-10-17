import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelError, MetamodelRegistry, parseMetamodel } from '../src';

const starter = loadStarterMetamodel();
const reg = new MetamodelRegistry(starter);

describe('starter metamodel', () => {
  it('loads and passes reference checks', () => {
    expect(starter.nodeTypes.length).toBeGreaterThan(90);
    expect(reg.nodeType('DataProduct')?.layer).toBe('Data');
  });

  it('builds labels with a non-colliding layer label and ancestors', () => {
    expect(reg.labelsFor('Application')).toEqual(['Element', 'ApplicationLayer', 'Application']);
    expect(reg.labelsFor('Division')).toEqual(['Element', 'OrganisationLayer', 'Division', 'OrgUnit']);
  });

  it('merges common, inherited and own attributes', () => {
    const names = reg.attributesFor('Table').map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['name', 'lifecycle', 'format', 'rowCount']));
  });

  it('validates data-store roles on HOLDS', () => {
    expect(reg.validateRelationship('HOLDS', 'DataStore', 'DataProduct', { role: 'GOLDEN_COPY' })).toEqual([]);
    expect(reg.validateRelationship('HOLDS', 'DataStore', 'DataProduct', {})).toContain('HOLDS.role is required');
    expect(reg.validateRelationship('HOLDS', 'Application', 'DataProduct', { role: 'MASTER' })[0]).toMatch(
      /not allowed/,
    );
  });

  it('allows connections through inheritance and wildcards', () => {
    expect(reg.canConnect('OWNS', 'Division', 'DataProduct')).toBe(true);
    expect(reg.canConnect('DECIDES', 'Decision', 'Platform')).toBe(true);
    expect(reg.canConnect('ACTS_ON', 'Application', 'DataProduct')).toBe(false);
  });

  it('validates node attribute values', () => {
    expect(reg.validateNodeAttributes('DataProduct', { name: 'Customer', classification: 'RESTRICTED' })).toEqual([]);
    const issues = reg.validateNodeAttributes('DataProduct', { classification: 'SECRET', bogus: 1 });
    expect(issues).toEqual(
      expect.arrayContaining([
        'DataProduct.name is required',
        expect.stringMatching(/classification must be one of/),
        'DataProduct.bogus is not a defined attribute',
      ]),
    );
  });
});

describe('parseMetamodel', () => {
  it('rejects attributes that clash with system fields', () => {
    const doc = `
id: x
version: '1'
layers: [Data]
nodeTypes:
  - { name: A, layer: Data, attributes: [{ name: version, type: string }] }
`;
    expect(() => parseMetamodel(doc)).toThrow(/'version' is reserved/);
  });

  it('reports broken references', () => {
    const bad = `
id: x
version: '1'
layers: [Data]
nodeTypes:
  - { name: A, layer: Nope }
relationshipTypes:
  - { name: LINKS, from: [A], to: [Missing] }
`;
    expect(() => parseMetamodel(bad)).toThrow(MetamodelError);
    try {
      parseMetamodel(bad);
    } catch (e) {
      expect((e as MetamodelError).issues).toEqual(
        expect.arrayContaining(["A: unknown layer 'Nope'", "LINKS: unknown endpoint 'Missing'"]),
      );
    }
  });
});
