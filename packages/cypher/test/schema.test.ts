import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { applySchema, relationshipIdIndexName, schemaStatements } from '../src';

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

  it('indexes relationship ids across all types with an exact-match full-text index', () => {
    const name = relationshipIdIndexName(reg);
    expect(name).toMatch(/^relationship_ids_[0-9a-f]{8}$/);
    const ddl = stmts.find((s) => s.includes(name))!;
    expect(ddl).toMatch(/FOR \(\)-\[r:[A-Z_|]+\]-\(\) ON EACH \[r\.id\]/);
    expect(ddl).toContain('HOLDS|');
    expect(ddl).toContain("'keyword'");
  });

  it('applies each statement and drops outdated relationship-id indexes', async () => {
    const ran: string[] = [];
    const n = await applySchema(
      {
        run: async (s) => {
          ran.push(s);
          return s.startsWith('SHOW INDEXES') ? { records: [{ get: () => 'relationship_ids_deadbeef' }] } : undefined;
        },
      },
      reg,
    );
    expect(n).toBe(stmts.length);
    expect(ran.slice(0, stmts.length)).toEqual(stmts);
    expect(ran.at(-1)).toBe('DROP INDEX relationship_ids_deadbeef IF EXISTS');
  });
});
