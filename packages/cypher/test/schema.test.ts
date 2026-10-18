import { describe, expect, it } from 'vitest';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { applySchema, awaitSchemaOnline, relationshipIdIndexName, schemaStatements, type CypherRunner } from '../src';

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

  const neoError = (code: string) => Object.assign(new Error(code), { code });
  const noSleep = async () => {};

  it('treats rules created by a concurrent applier as done and retries lock contention', async () => {
    const tries = new Map<string, number>();
    const runner: CypherRunner = {
      run: async (s) => {
        tries.set(s, (tries.get(s) ?? 0) + 1);
        if (s === stmts[0]) throw neoError('Neo.ClientError.Schema.EquivalentSchemaRuleAlreadyExists');
        if (s === stmts[1] && tries.get(s)! < 3) throw neoError('Neo.TransientError.Transaction.DeadlockDetected');
        return undefined;
      },
    };
    await expect(applySchema(runner, reg, { sleep: noSleep })).resolves.toBe(stmts.length);
    expect(tries.get(stmts[0]!)).toBe(1);
    expect(tries.get(stmts[1]!)).toBe(3);
  });

  it('gives up on persistent transient errors and never hides other errors', async () => {
    const lock: CypherRunner = { run: async () => { throw neoError('Neo.TransientError.Transaction.LockClientStopped'); } };
    await expect(applySchema(lock, reg, { sleep: noSleep, attempts: 2 })).rejects.toThrow(/LockClientStopped/);
    const syntax: CypherRunner = { run: async () => { throw neoError('Neo.ClientError.Statement.SyntaxError'); } };
    await expect(applySchema(syntax, reg, { sleep: noSleep })).rejects.toThrow(/SyntaxError/);
  });
});

describe('awaitSchemaOnline', () => {
  const rows = (list: [string, string][]) => ({ records: list.map(([name, state]) => ({ get: (k: string) => (k === 'name' ? name : state) })) });

  it('polls in short queries until every index is online', async () => {
    const answers = [rows([['a', 'POPULATING'], ['b', 'ONLINE']]), rows([['a', 'POPULATING']]), rows([])];
    const ran: string[] = [];
    let sleeps = 0;
    await awaitSchemaOnline({ run: async (s) => (ran.push(s), answers.shift()) }, { sleep: async () => void sleeps++ });
    expect(ran).toHaveLength(3);
    expect(ran[0]).toMatch(/^SHOW INDEXES/);
    expect(sleeps).toBe(2);
  });

  it('fails on a FAILED index and after the deadline', async () => {
    await expect(awaitSchemaOnline({ run: async () => rows([['bad', 'FAILED']]) })).rejects.toThrow(/failed to build: bad/);
    let t = 0;
    await expect(
      awaitSchemaOnline({ run: async () => rows([['slow', 'POPULATING']]) }, { timeoutMs: 1000, sleep: async () => void (t += 600), now: () => t }),
    ).rejects.toThrow(/still populating after 1 s: slow/);
  });
});
