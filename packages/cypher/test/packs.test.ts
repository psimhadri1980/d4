import { describe, expect, it } from 'vitest';
import { loadPack, parsePackQuery } from '../src';

describe('system query pack', () => {
  const pack = loadPack();

  it('loads every query, all passing the authoring checks without warnings', () => {
    expect(pack.map((q) => q.slug)).toEqual([
      'data-product-holders',
      'data-product-lineage-graph',
      'data-products-without-master',
      'impact-of-retirement',
      'lifecycle-risk',
      'org-unit-roadmap',
      'orphan-elements',
      'process-crud-matrix',
    ]);
    for (const q of pack) {
      expect(q.warnings, q.slug).toEqual([]);
      expect(q.contentHash).toMatch(/^sha256:/);
      expect(q.defaultRoles).toContain('viewer');
    }
  });

  it('refuses a pack query that fails the checks', () => {
    const bad = `slug: bad\ntitle: Bad\nresultShape: table\ncypher: MATCH (n) DETACH DELETE n RETURN 1`;
    expect(() => parsePackQuery(bad, 'test/bad.yaml')).toThrow(/test\/bad\.yaml: .*DELETE.*\$workspace/);
  });
});
