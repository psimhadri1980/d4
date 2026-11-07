import { describe, expect, it } from 'vitest';
import { composePack, describeMetamodelPacks, loadMetamodelPack, loadStarterMetamodel, type Metamodel, MetamodelError, MetamodelRegistry, parsePack, upgradeIssues } from '../src';

describe('industry packs', () => {
  it('compose into complete, valid metamodels with their own id', () => {
    for (const id of ['d4-banking', 'd4-insurance', 'd4-credit-graph'] as const) {
      const mm = loadMetamodelPack(id);
      expect(mm.id).toBe(id);
      expect(mm.nodeTypes.length).toBeGreaterThan(loadStarterMetamodel().nodeTypes.length);
    }
    expect(describeMetamodelPacks().map((p) => p.id)).toEqual(['d4-starter', 'd4-banking', 'd4-insurance', 'd4-credit-graph']);
  });

  it('pack types inherit from starter types and connect as the pack says', () => {
    const reg = new MetamodelRegistry(loadMetamodelPack('d4-banking'));
    expect(reg.lineage('RegulatoryReport')).toEqual(['RegulatoryReport', 'Report']);
    // Inherited from Report: a regulatory report consumes data products.
    expect(reg.canConnect('CONSUMES', 'RegulatoryReport', 'DataProduct')).toBe(true);
    expect(reg.canConnect('SOURCED_FROM', 'RegulatoryReport', 'CriticalDataElement')).toBe(true);
    // extendRelationships: a division can own a service domain.
    expect(reg.canConnect('OWNS', 'Division', 'ServiceDomain')).toBe(true);
    expect(reg.validateNodeAttributes('RegulatoryReport', { name: 'COREP', regime: 'BASEL_III', frequency: 'QUARTERLY' })).toEqual([]);
    expect(reg.validateNodeAttributes('RegulatoryReport', { name: 'x', regime: 'NOPE' })[0]).toMatch(/must be one of/);

    const ins = new MetamodelRegistry(loadMetamodelPack('d4-insurance'));
    expect(ins.canConnect('HANDLES_CLAIMS_FOR', 'ClaimsProcess', 'Coverage')).toBe(true);
    expect(ins.canConnect('SUPPORTS', 'ClaimsProcess', 'Capability')).toBe(true); // inherited from BusinessProcess
    // Packs are independent: banking types are not in the insurance metamodel.
    expect(ins.nodeType('ServiceDomain')).toBeUndefined();
  });

  it('refuses packs that redefine or reference what does not exist', () => {
    const starter = loadStarterMetamodel();
    const base = { id: 'd4-test', version: '0.0.1', extends: 'd4-starter', description: 't' };
    expect(() => composePack(starter, parsePack(JSON.stringify({ ...base, nodeTypes: [{ name: 'Application', layer: 'Application' }] })))).toThrow(
      /node type 'Application' already exists/,
    );
    expect(() => composePack(starter, parsePack(JSON.stringify({ ...base, relationshipTypes: [{ name: 'X_TO', from: ['Nope'], to: ['*'] }] })))).toThrow(MetamodelError);
    expect(() => composePack(starter, parsePack(JSON.stringify({ ...base, extendRelationships: [{ name: 'NOPE', to: ['Application'] }] })))).toThrow(/unknown 'NOPE'/);
    expect(() => parsePack(JSON.stringify({ ...base, extends: 'other' }))).toThrow(MetamodelError);
  });

  it('the credit graph pack composes on the starter, with lens roles, and connects collateral to facilities', () => {
    const mm = loadMetamodelPack('d4-credit-graph');
    const reg = new MetamodelRegistry(mm);
    expect(mm.id).toBe('d4-credit-graph');
    // Roles from the pack; a starter type the pack does not touch keeps the starter's (both).
    expect(Object.fromEntries(['CreditFacility', 'Issuer', 'Client', 'Person'].map((t) => [t, reg.roleOf(t)]))).toEqual({ CreditFacility: 'contour', Issuer: 'facet', Client: 'both', Person: 'both' });
    expect(reg.lineage('Property')).toEqual(['Property', 'CollateralAsset']);
    expect(reg.canConnect('SECURED_BY', 'CreditFacility', 'CollateralAgreement')).toBe(true);
    expect(reg.canConnect('PLEDGES', 'CollateralAgreement', 'Property')).toBe(true); // Property is also a CollateralAsset
    expect(reg.canConnect('DECIDES', 'CreditApproval', 'CreditFacility')).toBe(true); // inherited from Decision
    expect(reg.validateNodeAttributes('CreditFacility', { name: 'F', status: 'NOPE' })[0]).toMatch(/must be one of/);
  });
});

describe('lens semantics (D85)', () => {
  it('relationship kinds and direction, and node importance through extends', () => {
    const reg = new MetamodelRegistry(loadMetamodelPack('d4-credit-graph'));
    expect(reg.kindOf('PART_OF')).toBe('containment');
    expect(reg.forwardOf('PART_OF')).toBe('in');
    expect(reg.forwardOf('HAS_DRAWDOWN')).toBe('out');
    expect(reg.kindOf('RELATED_TO')).toBe('association');
    expect(reg.relationshipsOfKind('containment')).toContain('MEMBER_OF_GROUP');
    expect(reg.importanceOf('Application')).toEqual({ attribute: 'criticality', order: ['MISSION_CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
    expect(reg.importanceOf('Covenant')).toBeUndefined();
  });
});

describe('workspace upgrades', () => {
  const next = (mm: Metamodel, change: (m: Metamodel) => void = () => {}) => {
    const m = structuredClone(mm);
    m.version = '9.9.9';
    change(m);
    return m;
  };
  const credit = loadMetamodelPack('d4-credit-graph');

  it('allow additions and lens semantics', () => {
    expect(
      upgradeIssues(
        credit,
        next(credit, (m) => {
          m.nodeTypes.push({ name: 'Extra', layer: m.layers[0]!, attributes: [{ name: 'note', type: 'string', required: false }], internal: false });
          m.relationshipTypes[0]!.kind = 'association';
          m.relationshipTypes[0]!.attributes.push({ name: 'since', type: 'date', required: false });
          m.enums[Object.keys(m.enums)[0]!]!.push('NEW_VALUE');
        }),
      ),
    ).toEqual([]);
  });

  it('refuse what existing data relies on', () => {
    const rel = credit.relationshipTypes.find((r) => !r.from.includes('*'))!;
    const [enumName, values] = Object.entries(credit.enums)[0]!;
    const issues = upgradeIssues(
      credit,
      next(credit, (m) => {
        m.nodeTypes = m.nodeTypes.filter((t) => t.name !== 'Covenant');
        m.relationshipTypes.find((r) => r.name === rel.name)!.from = rel.from.slice(1).length ? rel.from.slice(1) : ['Covenant'];
        m.enums[enumName] = values.slice(1);
        m.nodeTypes.find((t) => t.name === 'Client')!.attributes.push({ name: 'mustHave', type: 'string', required: true });
      }),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        "node type 'Covenant' is removed",
        `relationship type '${rel.name}' no longer allows '${rel.from[0]}' as 'from'`,
        `enum '${enumName}' drops value '${values[0]}'`,
        "node type 'Client': new attribute 'mustHave' is required",
      ]),
    );
    expect(upgradeIssues(credit, credit)).toEqual(['already on d4-credit-graph@' + credit.version]);
    expect(upgradeIssues(credit, loadMetamodelPack('d4-banking'))[0]).toMatch(/is not a version of/);
  });
});
