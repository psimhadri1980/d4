import { describe, expect, it } from 'vitest';
import {
  bindParams,
  checkCatalogQuery,
  checkReadOnly,
  contentHash,
  maskCypher,
  paramDefIssues,
  type QueryParamDef,
} from '../src';

const defs: QueryParamDef[] = [
  { name: 'element', type: 'element', required: true },
  { name: 'depth', type: 'integer', required: false, default: 2 },
  { name: 'role', type: 'enum', required: false, values: ['MASTER', 'GOLDEN_COPY'] },
];

const GOOD = `
  MATCH (s:DataStore)-[h:HOLDS]->(p:DataProduct {id: $element})
  WHERE p.workspaceId = $workspace AND h.deleted = false AND ($role IS NULL OR h.role = $role)
  // depth is used for the variable-length part below
  OPTIONAL MATCH path = (p)<-[:DERIVED_FROM*1..3]-(d) WHERE size(relationships(path)) <= $depth
  RETURN s.name AS store, h.role AS role, collect(d.name) AS derived
  LIMIT 100`;

describe('parameter definitions', () => {
  it('accepts valid definitions and reports problems', () => {
    expect(paramDefIssues(defs).issues).toEqual([]);
    const bad = paramDefIssues([
      { name: 'x', type: 'enum' },
      { name: 'x', type: 'string' },
      { name: 'workspace', type: 'string' },
      { name: 'n', type: 'integer', default: 1.5 },
    ]).issues;
    expect(bad).toEqual(
      expect.arrayContaining([
        "enum parameter 'x' needs values",
        "parameter 'x' is declared twice",
        "parameter 'workspace' is supplied by the platform and cannot be declared",
        "default of 'n' must be an integer",
      ]),
    );
    expect(paramDefIssues([{ name: 'Bad-Name', type: 'string' }]).issues[0]).toMatch(/camelCase/);
  });

  it('binds run-time values with defaults and conversions', () => {
    const ok = bindParams(defs, { element: '01M55H69QB6DW04HJM23564S16', depth: '3' });
    expect(ok).toEqual({ values: { element: '01M55H69QB6DW04HJM23564S16', depth: 3, role: null }, issues: [] });
    expect(bindParams(defs, { element: '01M55H69QB6DW04HJM23564S16' }).values['depth']).toBe(2);

    const bad = bindParams(defs, { depth: 'x', role: 'OWNER', extra: 1 }).issues;
    expect(bad).toEqual(
      expect.arrayContaining([
        "unknown parameter 'extra'",
        "parameter 'element' is required",
        "parameter 'depth' must be an integer",
        "parameter 'role' must be one of MASTER, GOLDEN_COPY",
      ]),
    );
    expect(bindParams(defs, { element: 'not-an-id' }).issues).toEqual(["parameter 'element' must be an element id"]);
  });
});

describe('maskCypher', () => {
  it('blanks comments, strings and quoted names but keeps length', () => {
    const src = `MATCH (n {name: 'CREATE x'}) // DELETE\nRETURN n /* SET */ AS \`DROP\``;
    const masked = maskCypher(src);
    expect(masked).toHaveLength(src.length);
    expect(masked).not.toMatch(/CREATE|DELETE|SET|DROP/);
    expect(masked).toContain('MATCH');
    expect(masked).toContain('RETURN');
  });
});

describe('checkCatalogQuery', () => {
  it('passes a well-formed read query', () => {
    expect(checkCatalogQuery(GOOD, defs)).toEqual({ errors: [], warnings: [] });
  });

  it('ignores keywords inside strings and comments', () => {
    const q = `MATCH (n) WHERE n.workspaceId = $workspace AND n.name = 'DELETE me; CREATE x' // SET y\nRETURN n LIMIT 5`;
    expect(checkCatalogQuery(q, []).errors).toEqual([]);
  });

  it.each([
    ['MATCH (n) WHERE n.workspaceId = $workspace SET n.x = 1 RETURN n', 'SET'],
    ['MATCH (n) WHERE n.workspaceId = $workspace DETACH DELETE n RETURN 1', 'DELETE'],
    ['MERGE (n:Element {id: $workspace}) RETURN n', 'MERGE'],
    ["LOAD CSV FROM 'http://x' AS r WITH r WHERE $workspace IS NOT NULL RETURN r", 'LOAD CSV'],
    ['MATCH (n) WHERE n.workspaceId = $workspace CALL { WITH n RETURN 1 AS x } IN TRANSACTIONS RETURN n', 'IN TRANSACTIONS'],
    ['SHOW USERS', 'SHOW'],
  ])('rejects writes and admin commands: %s', (q, word) => {
    expect(checkCatalogQuery(q, []).errors.join(' ')).toContain(word);
  });

  it.each([
    "CALL apoc.load.json('http://169.254.169.254/') YIELD value WHERE $workspace IS NOT NULL RETURN value",
    "CALL apoc.cypher.run('MATCH (n) DETACH DELETE n', {}) YIELD value WHERE $workspace IS NOT NULL RETURN value",
    'CALL dbms.listConfig() YIELD name WHERE $workspace IS NOT NULL RETURN name',
    "CALL apoc . load . json('http://x') YIELD value WHERE $workspace IS NOT NULL RETURN value",
    "CALL `apoc.load.json`('http://x') YIELD value WHERE $workspace IS NOT NULL RETURN value",
    'CALL apoc.periodic.iterate("MATCH (n) RETURN n", "SET n.x = 1", {}) YIELD batches WHERE $workspace IS NOT NULL RETURN batches',
  ])('rejects calls outside the allow-list: %s', (q) => {
    expect(checkCatalogQuery(q, []).errors.length).toBeGreaterThan(0);
  });

  it('allows listed procedures and functions', () => {
    const q = `CALL db.index.fulltext.queryNodes('element_search', 'client') YIELD node
               WHERE node.workspaceId = $workspace RETURN apoc.coll.toSet(node.tags) AS tags LIMIT 10`;
    expect(checkCatalogQuery(q, []).errors).toEqual([]);
  });

  it('requires workspace scoping, declared params and a RETURN', () => {
    const errors = checkCatalogQuery('MATCH (n {id: $other})', []).errors;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/must filter by \$workspace/),
        '$other is used but not declared',
        'the query must RETURN something',
      ]),
    );
  });

  it('warns about unused params and missing LIMIT', () => {
    const r = checkCatalogQuery('MATCH (n) WHERE n.workspaceId = $workspace RETURN n', defs);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/'element' is declared but not used/), expect.stringMatching(/no LIMIT/)]),
    );
  });
});

describe('checkReadOnly', () => {
  it('trusts Neo4j classification and reports syntax errors', async () => {
    const read = await checkReadOnly({ explain: async () => 'r' }, GOOD, {});
    expect(read.errors).toEqual([]);
    const write = await checkReadOnly({ explain: async () => 'rw' }, GOOD, {});
    expect(write.errors[0]).toMatch(/'rw', not read-only/);
    const broken = await checkReadOnly(
      {
        explain: async () => {
          throw new Error('Invalid input "MATC"\n  at line 1');
        },
      },
      'MATC (n)',
      {},
    );
    expect(broken.errors[0]).toBe('Neo4j rejected the query: Invalid input "MATC"');
  });
});

describe('contentHash', () => {
  it('changes with any executable part', () => {
    const base = { cypher: GOOD, params: defs, resultShape: 'table', kind: 'read' };
    const h = contentHash(base);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(contentHash({ ...base })).toBe(h);
    expect(contentHash({ ...base, cypher: `${GOOD} ` })).not.toBe(h);
    expect(contentHash({ ...base, resultShape: 'graph' })).not.toBe(h);
  });

  it('ignores key order, so a jsonb round-trip keeps the same fingerprint', () => {
    const a = { cypher: 'RETURN 1', params: [{ name: 'x', type: 'string', required: false }], resultShape: 'table', kind: 'read' };
    const b = { kind: 'read', resultShape: 'table', params: [{ required: false, type: 'string', name: 'x' }], cypher: 'RETURN 1' };
    expect(contentHash(b)).toBe(contentHash(a));
  });
});
