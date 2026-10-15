import { MetamodelRegistry, layerLabel } from '@d4/metamodel';

/**
 * Schema DDL for one tenant database. Every statement is idempotent (`IF NOT EXISTS`) and
 * uses only features available in Neo4j 5 Community Edition.
 */
export function schemaStatements(reg: MetamodelRegistry): string[] {
  const stmts = [
    // Every node carries :Element, so one constraint guarantees global id uniqueness.
    'CREATE CONSTRAINT element_id_unique IF NOT EXISTS FOR (n:Element) REQUIRE n.id IS UNIQUE',
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
  return stmts;
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** Minimal runner contract so DDL can be applied via the Neo4j driver or a test double. */
export interface CypherRunner {
  run(statement: string, params?: Record<string, unknown>): PromiseLike<unknown>;
}

export async function applySchema(runner: CypherRunner, reg: MetamodelRegistry): Promise<number> {
  const stmts = schemaStatements(reg);
  // Schema statements cannot share a transaction with each other in Neo4j; run them one by one.
  for (const s of stmts) await runner.run(s);
  return stmts.length;
}
