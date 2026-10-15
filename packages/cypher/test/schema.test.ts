import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { applySchema, schemaStatements } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());

describe('schemaStatements', () => {
  const stmts = schemaStatements(reg);

  it('is idempotent and unique', () => {
    expect(stmts.every((s) => s.includes('IF NOT EXISTS'))).toBe(true);
    const names = stmts.map((s) => s.split(' ')[2] === 'INDEX' ? s.split(' ')[3] : s.split(' ')[2]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('includes id uniqueness, search, layer and relationship indexes', () => {
    expect(stmts).toContain(
      'CREATE CONSTRAINT element_id_unique IF NOT EXISTS FOR (n:Element) REQUIRE n.id IS UNIQUE',
    );
    expect(stmts.some((s) => s.startsWith('CREATE FULLTEXT INDEX element_search'))).toBe(true);
    expect(stmts).toContain(
      'CREATE INDEX data_layer_workspace IF NOT EXISTS FOR (n:DataLayer) ON (n.workspaceId)',
    );
    expect(stmts).toContain('CREATE INDEX rel_holds_id IF NOT EXISTS FOR ()-[r:HOLDS]-() ON (r.id)');
  });

  it('applies each statement through the runner', async () => {
    const ran: string[] = [];
    const n = await applySchema({ run: async (s) => void ran.push(s) }, reg);
    expect(n).toBe(stmts.length);
    expect(ran).toEqual(stmts);
  });
});
