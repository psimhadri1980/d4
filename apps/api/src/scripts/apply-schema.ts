/**
 * Applies Neo4j constraints and indexes for the starter metamodel to one tenant database.
 * Usage: node dist/scripts/apply-schema.js [tenantId]   (defaults to the local dev tenant `t_local`)
 */
import neo4j from 'neo4j-driver';
import { applySchema, awaitSchemaOnline, relationshipIdIndexName } from '@d4/cypher';
import { createDb, MetamodelStore, TenantStore } from '@d4/db';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { loadConfig } from '../config';

async function main() {
  const tenantId = process.argv[2] ?? 't_local';
  const config = loadConfig();
  const handle = createDb(config.POSTGRES_URL, 1);
  try {
    const inst = await new TenantStore(handle.db).readyDbInstance(tenantId);
    if (!inst) throw new Error(`tenant '${tenantId}' has no ready graph database`);
    const driver = neo4j.driver(
      config.NEO4J_URI ?? inst.boltUri,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
    );
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      // Every metamodel a workspace uses keeps its relationship-id index; only orphans are dropped.
      const inUse = await new MetamodelStore(handle.db).inUse(tenantId);
      const keep = inUse.map((mm) => relationshipIdIndexName(new MetamodelRegistry(mm)));
      for (const mm of inUse) await applySchema(session, new MetamodelRegistry(mm));
      const n = await applySchema(session, new MetamodelRegistry(loadStarterMetamodel()), { keepRelationshipIndexes: keep });
      await awaitSchemaOnline(session);
      console.log(`Applied ${n} schema statements to tenant '${tenantId}'.`);
    } finally {
      await session.close();
      await driver.close();
    }
  } finally {
    await handle.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
