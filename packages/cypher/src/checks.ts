import { createHash } from 'node:crypto';
import { SYSTEM_PARAMS, type QueryParamDef } from './params';

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

export const MAX_QUERY_LENGTH = 20_000;

/**
 * Procedures and functions catalog queries may call. Matching is by exact name or by a prefix
 * ending in '.'. Everything else in a namespace (dbms.*, apoc.periodic.*, apoc.cypher.*,
 * apoc.load.*, gds.*, …) is refused.
 */
export const ALLOWED_CALLABLES = [
  'db.index.fulltext.queryNodes',
  'db.index.fulltext.queryRelationships',
  'db.labels',
  'db.relationshipTypes',
  'apoc.path.expandConfig',
  'apoc.path.subgraphAll',
  'apoc.path.subgraphNodes',
  'apoc.path.spanningTree',
  'apoc.coll.',
  'apoc.text.',
  'apoc.map.',
  'apoc.date.',
];

/** Clauses that change data or the database; a read-only catalog query may not contain them. */
const FORBIDDEN = [
  ['CREATE', /\bCREATE\b/i],
  ['MERGE', /\bMERGE\b/i],
  ['DELETE', /\bDELETE\b/i],
  ['DETACH', /\bDETACH\b/i],
  ['SET', /\bSET\b/i],
  ['REMOVE', /\bREMOVE\b/i],
  ['FOREACH', /\bFOREACH\b/i],
  ['LOAD CSV', /\bLOAD\s+CSV\b/i],
  ['IN TRANSACTIONS', /\bIN\s+(?:\d+\s+)?(?:CONCURRENT\s+)?TRANSACTIONS\b/i],
  ['USE', /^\s*USE\b|\bUSE\s+[A-Za-z`]/i],
  ['DROP', /\bDROP\b/i],
  ['ALTER', /\bALTER\b/i],
  ['GRANT/DENY/REVOKE', /\b(GRANT|DENY|REVOKE)\b/i],
  ['SHOW', /\bSHOW\b/i],
  ['TERMINATE', /\bTERMINATE\b/i],
  ['START/STOP DATABASE', /\b(START|STOP)\s+DATABASE\b/i],
] as const;

/**
 * Blanks out comments, string literals and backtick-quoted names (keeping offsets), so keyword
 * and parameter scans only see real Cypher tokens.
 */
export function maskCypher(text: string): string {
  const out: string[] = [];
  let i = 0;
  const blank = (ch: string) => out.push(ch === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        blank(text[i]!);
        i++;
      }
    } else if (c === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close === -1 ? text.length : close + 2;
      for (; i < stop; i++) blank(text[i]!);
    } else if (c === "'" || c === '"' || c === '`') {
      out.push(c);
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === '\\' && c !== '`' && i + 1 < text.length) {
          blank(text[i]!);
          i++;
        }
        blank(text[i]!);
        i++;
      }
      if (i < text.length) {
        out.push(c);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

const allowed = (name: string) =>
  ALLOWED_CALLABLES.some((a) => (a.endsWith('.') ? name.startsWith(a) : name === a));

/** Static safety and hygiene checks for a read-only catalog query. */
export function checkCatalogQuery(cypher: string, defs: QueryParamDef[]): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!cypher.trim()) return { errors: ['the query is empty'], warnings };
  if (cypher.length > MAX_QUERY_LENGTH) errors.push(`the query is longer than ${MAX_QUERY_LENGTH} characters`);

  const code = maskCypher(cypher);
  for (const [name, re] of FORBIDDEN) if (re.test(code)) errors.push(`${name} is not allowed in a read-only query`);

  // Namespaced calls: `CALL a.b.c(` procedures and `a.b(` functions, tolerating spaces around dots.
  const NAME = '[A-Za-z_][A-Za-z0-9_]*';
  for (const m of code.matchAll(new RegExp(`\\b(${NAME}(?:\\s*\\.\\s*${NAME})+)\\s*\\(`, 'g'))) {
    const name = m[1]!.replace(/\s+/g, '');
    if (!allowed(name)) errors.push(`${name}() is not on the allow-list`);
  }
  // Backtick-quoted names would hide a procedure or function from the allow-list check.
  if (/`\s*\(|`\s*\.|\.\s*`/.test(code)) {
    errors.push('quoted names are not allowed in procedure or function calls');
  }
  if (/\bCALL\s*\{/i.test(code)) warnings.push('subqueries (CALL { … }) are allowed but check their cost');

  const used = new Set([...code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!));
  if (/\$`|\$\{/.test(code)) errors.push('quoted or dynamic parameter names are not allowed');
  if (!used.has('workspace')) {
    errors.push('the query must filter by $workspace (e.g. WHERE n.workspaceId = $workspace)');
  }
  const declared = new Set<string>([...defs.map((d) => d.name), ...SYSTEM_PARAMS]);
  for (const p of used) if (!declared.has(p)) errors.push(`$${p} is used but not declared`);
  for (const d of defs) if (!used.has(d.name)) warnings.push(`parameter '${d.name}' is declared but not used`);

  if (!/\bRETURN\b/i.test(code)) errors.push('the query must RETURN something');
  if (!/\bLIMIT\b/i.test(code)) warnings.push('no LIMIT: results will be cut at the platform row cap');

  return { errors: [...new Set(errors)], warnings };
}

/** Neo4j's own read/write classification, via EXPLAIN (nothing is executed). */
export interface Explainer {
  /** Returns the query type from the EXPLAIN summary: 'r', 'rw', 'w' or 's'. */
  explain(cypher: string, params: Record<string, unknown>): Promise<string>;
}

/** Authoritative check that a query only reads; also surfaces syntax errors. */
export async function checkReadOnly(explainer: Explainer, cypher: string, params: Record<string, unknown>): Promise<CheckResult> {
  try {
    const type = await explainer.explain(cypher, params);
    return type === 'r'
      ? { errors: [], warnings: [] }
      : { errors: [`Neo4j classifies this query as '${type}', not read-only`], warnings: [] };
  } catch (e) {
    return { errors: [`Neo4j rejected the query: ${(e as Error).message.split('\n')[0]}`], warnings: [] };
  }
}

/** Fingerprint of a version's executable content; verified before every run. */
export function contentHash(v: { cypher: string; params: unknown; resultShape: string; kind: string }): string {
  const canonical = JSON.stringify({ cypher: v.cypher, params: v.params, resultShape: v.resultShape, kind: v.kind });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
