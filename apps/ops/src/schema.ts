import neo4j from 'neo4j-driver';
import { applySchema, awaitSchemaOnline, relationshipIdIndexName } from '@d4/cypher';
import { createDb, MetamodelStore, TenantStore } from '@d4/db';
import { parseHosts, routeUri } from '@d4/infra';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { loadConfig, neo4j as neo4jEnv, postgres } from '@d4/config';

/**
 * `d4-ops schema [tenant]`: Neo4j constraints and indexes for the starter metamodel (and every
 * metamodel a workspace uses) on one tenant database; defaults to the local dev tenant `t_local`.
 */
export async function schema(args: string[]) {
  const tenantId = args[0] ?? 't_local';
  const config = loadConfig({ ...postgres, ...neo4jEnv });
  const handle = createDb(config.POSTGRES_URL, 1);
  try {
    const inst = await new TenantStore(handle.db).readyDbInstance(tenantId);
    if (!inst) throw new Error(`tenant '${tenantId}' has no ready graph database`);
    const driver = neo4j.driver(
      // The registered URI names a host (bolt://neo4j:7687); NEO4J_HOSTS says where it listens.
      routeUri(inst.boltUri, { uriOverride: config.NEO4J_URI, hosts: parseHosts(config.NEO4J_HOSTS) }),
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
