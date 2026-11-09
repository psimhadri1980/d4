import { describe, expect, it } from 'vitest';
import { loadRoadmapMetamodel, MetamodelRegistry, RESERVED_ATTRIBUTE_NAMES } from '../src';

const mm = loadRoadmapMetamodel();
const reg = new MetamodelRegistry(mm);

describe('roadmap metamodel', () => {
  it('loads, passes reference checks and keeps off reserved attribute names', () => {
    expect(mm.id).toBe('d4-roadmap');
    for (const t of mm.nodeTypes) for (const a of t.attributes) expect(RESERVED_ATTRIBUTE_NAMES.has(a.name), `${t.name}.${a.name}`).toBe(false);
  });

  it('keeps current and target in one element registry', () => {
    for (const t of ['ApplicationElement', 'DataPlatform', 'DataSet', 'DataProduct', 'OutputPort']) {
      expect(reg.lineage(t)).toContain('Element');
    }
    // Lifecycle and dates are inherited, so one element carries both its current and its planned state.
    expect(reg.validateNodeAttributes('DataProduct', { name: 'Customer 360', level: 'AGGREGATE', lifecycle: 'PLANNED', liveFrom: '2027-03-01' })).toEqual([]);
    expect(reg.validateNodeAttributes('DataProduct', { name: 'x', lifecycle: 'TARGET' })[0]).toMatch(/must be one of/);
  });

  it('separates the dependency families and their endpoints', () => {
    expect(reg.canConnect('CONSUMES', 'ApplicationElement', 'OutputPort')).toBe(true);
    expect(reg.canConnect('CONSUMES', 'ApplicationElement', 'DataProduct')).toBe(false); // consumers depend on a port, not the whole product
    expect(reg.canConnect('DELIVERS', 'Milestone', 'DataProduct')).toBe(true);
    expect(reg.canConnect('BUILT_ON', 'ApplicationElement', 'Technology')).toBe(true);
    expect(reg.canConnect('BUILT_ON', 'ApplicationElement', 'ApplicationElement')).toBe(true); // a shared platform is an element
    expect(reg.canConnect('DERIVED_FROM', 'DataProduct', 'DataSet')).toBe(true);
    expect(reg.canConnect('DERIVED_FROM', 'ApplicationElement', 'DataSet')).toBe(false); // lineage is data to data only
    expect(reg.canConnect('GATED_BY', 'Milestone', 'ExternalConstraint')).toBe(true);
  });

  it('lets a use case have several categories and a blueprint be a set of typed rules', () => {
    expect(reg.canConnect('IN_CATEGORY', 'UseCase', 'UseCaseCategory')).toBe(true);
    expect(reg.canConnect('GOVERNED_BY', 'UseCaseCategory', 'Blueprint')).toBe(true);
    expect(reg.canConnect('HAS_RULE', 'Blueprint', 'BlueprintRule')).toBe(true);
    expect(reg.canConnect('RULE_TARGETS', 'BlueprintRule', 'Technology')).toBe(true);
    expect(reg.validateNodeAttributes('BlueprintRule', { name: 'r', ruleType: 'MUST_USE' })).toEqual([]);
    expect(reg.validateNodeAttributes('BlueprintRule', { name: 'r' })[0]).toMatch(/required/i);
  });

  it('keeps ownership and domain independent', () => {
    expect(reg.canConnect('OWNED_BY', 'DataProduct', 'OrgUnit')).toBe(true);
    expect(reg.canConnect('IN_DOMAIN', 'DataProduct', 'Domain')).toBe(true);
    expect(reg.canConnect('ALIGNS_WITH', 'Domain', 'OrgUnit')).toBe(true);
  });

  it('records debt with a kind, status and exception expiry', () => {
    expect(reg.validateNodeAttributes('DebtItem', { name: 'd', kind: 'TECHNOLOGY', status: 'ACCEPTED', expiry: '2027-06-30' })).toEqual([]);
    expect(reg.canConnect('AFFECTS', 'DebtItem', 'ApplicationElement')).toBe(true);
    expect(reg.canConnect('ADDRESSES', 'Initiative', 'DebtItem')).toBe(true);
  });
});
