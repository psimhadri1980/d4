import { MetamodelRegistry, layerLabel } from '@d4/metamodel';

/**
 * Schema DDL for one tenant database. Every statement is idempotent (`IF NOT EXISTS`) and
 * uses only features available in Neo4j 5 Community Edition.
 */
export function schemaStatements(reg: MetamodelRegistry): string[] {
  const stmts = [
    // Every node carries :Element, so one constraint guarantees global id uniqueness.
    'CREATE CONSTRAINT element_id_unique IF NOT EXISTS FOR (n:Element) REQUIRE n.id IS UNIQUE',
    'CREATE INDEX element_workspace IF NOT EXISTS FOR (n:Element) ON (n.workspaceId)',
    'CREATE INDEX element_workspace_type IF NOT EXISTS FOR (n:Element) ON (n.workspaceId, n.type)',
    'CREATE INDEX element_lifecycle IF NOT EXISTS FOR (n:Element) ON (n.lifecycle)',
    'CREATE INDEX element_scenario IF NOT EXISTS FOR (n:Element) ON (n.scenarioId)',
    'CREATE INDEX element_external_key IF NOT EXISTS FOR (n:Element) ON (n.externalKey)',
    'CREATE FULLTEXT INDEX element_search IF NOT EXISTS FOR (n:Element) ON EACH [n.name, n.description]',
  ];

  for (const layer of new Set(reg.nodeTypes().map((n) => n.layer))) {
    const label = layerLabel(layer);
    stmts.push(
      `CREATE INDEX ${snake(label)}_workspace IF NOT EXISTS FOR (n:${label}) ON (n.workspaceId)`,
    );
  }

  for (const rel of reg.relationshipTypes()) {
    stmts.push(
      `CREATE INDEX rel_${rel.name.toLowerCase()}_id IF NOT EXISTS FOR ()-[r:${rel.name}]-() ON (r.id)`,
    );
  }

  // Range indexes are per relationship type, so finding a relationship by id alone would need one
  // seek per type. A single full-text index over every type (keyword analyzer = exact ids) makes
  // that one lookup. Its name encodes the type list, so metamodel changes produce a new index.
  const types = relationshipTypeNames(reg);
  if (types.length) {
    stmts.push(
      `CREATE FULLTEXT INDEX ${relationshipIdIndexName(reg)} IF NOT EXISTS FOR ()-[r:${types.join('|')}]-() ` +
        "ON EACH [r.id] OPTIONS { indexConfig: { `fulltext.analyzer`: 'keyword' } }",
    );
  }
  return stmts;
}

const relationshipTypeNames = (reg: MetamodelRegistry) => reg.relationshipTypes().map((r) => r.name).sort();

export const RELATIONSHIP_ID_INDEX_PREFIX = 'relationship_ids_';

/** Name of the cross-type relationship id index for this metamodel's relationship types. */
export function relationshipIdIndexName(reg: MetamodelRegistry): string {
  return `${RELATIONSHIP_ID_INDEX_PREFIX}${fnv1a(relationshipTypeNames(reg).join('|'))}`;
}

/** 32-bit FNV-1a as 8 hex chars; enough to tell type lists apart. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Minimal runner contract so DDL can be applied via the Neo4j driver or a test double. */
export interface CypherRunner {
  run(
    statement: string,
    params?: Record<string, unknown>,
  ): PromiseLike<{ records: { get(key: string): unknown }[] } | undefined | void>;
}

export interface SchemaOptions {
  /** Attempts per statement for transient errors (lock contention with a concurrent applier). */
  attempts?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => String((e as { code?: unknown } | null)?.code ?? '');

/** Another process created the same rule first: the end state is what we wanted. */
const ALREADY_EXISTS = /Schema\.(EquivalentSchemaRuleAlreadyExists|IndexAlreadyExists|ConstraintAlreadyExists)$/;
const TRANSIENT = /^Neo\.TransientError\./;

async function runDdl(runner: CypherRunner, stmt: string, opts: Required<SchemaOptions>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runner.run(stmt);
    } catch (e) {
      const code = codeOf(e);
      if (ALREADY_EXISTS.test(code)) return undefined;
      if (!TRANSIENT.test(code) || attempt >= opts.attempts) throw e;
      await opts.sleep(100 * 2 ** (attempt - 1));
    }
  }
}

/**
 * Applies all schema statements and drops relationship-id indexes for outdated type lists.
 * Safe to run from several processes at once (tests, API start-up, the schema job): rules a
 * concurrent applier created first count as success, and lock contention is retried.
 */
export async function applySchema(runner: CypherRunner, reg: MetamodelRegistry, options: SchemaOptions = {}): Promise<number> {
  const opts = { attempts: options.attempts ?? 6, sleep: options.sleep ?? wait };
  const stmts = schemaStatements(reg);
  // Schema statements cannot share a transaction with each other in Neo4j; run them one by one.
  for (const s of stmts) await runDdl(runner, s, opts);

  const res = await runner.run(
    'SHOW INDEXES YIELD name WHERE name STARTS WITH $prefix AND name <> $current RETURN name',
    { prefix: RELATIONSHIP_ID_INDEX_PREFIX, current: relationshipIdIndexName(reg) },
  );
  for (const rec of res?.records ?? []) {
    await runDdl(runner, `DROP INDEX ${String(rec.get('name')).replace(/[^a-z0-9_]/g, '')} IF EXISTS`, opts);
  }
  return stmts.length;
}

/**
 * Waits until every index is ONLINE. Polls in short transactions instead of one long
 * `db.awaitIndexes` call, which the server's transaction timeout (30 s locally) would kill while
 * a fresh database populates its indexes.
 */
export async function awaitSchemaOnline(
  runner: CypherRunner,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<void> {
  const { timeoutMs = 300_000, pollMs = 500, sleep = wait, now = Date.now } = options;
  const deadline = now() + timeoutMs;
  for (;;) {
    const res = await runner.run("SHOW INDEXES YIELD name, state WHERE state <> 'ONLINE' RETURN name, state");
    const pending = (res?.records ?? []).map((r) => ({ name: String(r.get('name')), state: String(r.get('state')) }));
    const failed = pending.filter((p) => p.state === 'FAILED');
    if (failed.length) throw new Error(`Neo4j indexes failed to build: ${failed.map((f) => f.name).join(', ')}`);
    if (!pending.length) return;
    if (now() >= deadline) {
      throw new Error(`Neo4j indexes still populating after ${timeoutMs / 1000} s: ${pending.map((p) => p.name).join(', ')}`);
    }
    await sleep(pollMs);
  }
}
