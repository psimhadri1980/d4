/**
 * Applies Neo4j constraints and indexes for the starter metamodel to one tenant database.
 * Usage: pnpm db:schema [tenantId]   (defaults to the local dev tenant `t_local`)
 */
import neo4j from 'neo4j-driver';
import { applySchema } from '@d4/cypher';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { loadConfig } from '../config';
import { ControlPlaneService } from '../control-plane.service';

async function main() {
  const tenantId = process.argv[2] ?? 't_local';
  const config = loadConfig();
  const cp = new ControlPlaneService(config);
  try {
    const inst = await cp.tenantDb(tenantId);
    if (!inst) throw new Error(`tenant '${tenantId}' has no ready graph database`);
    const driver = neo4j.driver(
      config.NEO4J_URI ?? inst.boltUri,
      neo4j.auth.basic(config.NEO4J_USER, config.NEO4J_PASSWORD),
    );
    const session = driver.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      const n = await applySchema(session, new MetamodelRegistry(loadStarterMetamodel()));
      console.log(`Applied ${n} schema statements to tenant '${tenantId}'.`);
    } finally {
      await session.close();
      await driver.close();
    }
  } finally {
    await cp.onModuleDestroy();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
