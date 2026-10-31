import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { attrsFromForm, diffAttrs, fromFormValue, relationshipOptions, toFormValue, typesByLayer } from '../src/model';

const reg = new MetamodelRegistry(loadStarterMetamodel());

describe('form conversion', () => {
  const defs = reg.attributesFor('DataProduct');

  it('turns form fields into typed attributes and drops empty ones', () => {
    const attrs = attrsFromForm(defs, { name: ' Client ', qualityScore: '0.97', tags: 'core, pii ,', sla: '' });
    expect(attrs).toEqual({ name: 'Client', qualityScore: 0.97, tags: ['core', 'pii'] });
  });

  it('round-trips values through the form', () => {
    const tags = defs.find((d) => d.name === 'tags')!;
    expect(fromFormValue(tags, toFormValue(tags, ['a', 'b']))).toEqual(['a', 'b']);
    const score = defs.find((d) => d.name === 'qualityScore')!;
    expect(fromFormValue(score, 'abc')).toBe('abc'); // left for the validator to reject
  });

  it('computes PATCH changes', () => {
    expect(diffAttrs({ name: 'A', sla: 'x', tags: ['t'] }, { name: 'B', tags: ['t'] })).toEqual({
      set: { name: 'B' },
      unset: ['sla'],
    });
  });
});

describe('metamodel helpers', () => {
  it('groups visible types by layer in metamodel order', () => {
    const groups = typesByLayer(reg);
    expect(groups[0]![0]).toBe('Strategy');
    expect(groups.flatMap(([, t]) => t)).not.toContain('Tag');
  });

  it('offers only relationships the metamodel allows, with partner types', () => {
    const opts = relationshipOptions(reg, 'DataProduct');
    const heldBy = opts.find((o) => o.type === 'HOLDS' && o.direction === 'IN');
    expect(heldBy?.partnerTypes).toEqual(['DataStore']);
    expect(opts.some((o) => o.type === 'HOLDS' && o.direction === 'OUT')).toBe(false);
    const owners = opts.find((o) => o.type === 'OWNS' && o.direction === 'IN')!.partnerTypes;
    expect(owners).toEqual(expect.arrayContaining(['Division', 'Team']));
  });
});
