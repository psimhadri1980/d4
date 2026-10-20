import { describe, expect, it } from 'vitest';
import { composePack, describeMetamodelPacks, loadMetamodelPack, loadStarterMetamodel, MetamodelError, MetamodelRegistry, parsePack } from '../src';

describe('industry packs', () => {
  it('compose into complete, valid metamodels with their own id', () => {
    for (const id of ['d4-banking', 'd4-insurance'] as const) {
      const mm = loadMetamodelPack(id);
      expect(mm.id).toBe(id);
      expect(mm.nodeTypes.length).toBeGreaterThan(loadStarterMetamodel().nodeTypes.length);
    }
    expect(describeMetamodelPacks().map((p) => p.id)).toEqual(['d4-starter', 'd4-banking', 'd4-insurance']);
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
});
