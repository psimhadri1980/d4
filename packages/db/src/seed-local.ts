import { loadStarterMetamodel } from '@d4/metamodel';
import { createDb, type Db } from './client';
import { runMigrations } from './migrate';
import { tenantDbInstances, tenants } from './schema';
import { MetamodelStore, WorkspaceStore } from './stores';

export const LOCAL_TENANT = 't_local';
export const LOCAL_WORKSPACE_SLUG = 'default';

/**
 * Idempotent local-development seed: tenant `t_local` pointing at the compose Neo4j, the starter
 * metamodel (active) and a `default` workspace.
 */
export async function seedLocal(db: Db): Promise<{ workspaceId: string; metamodelId: string }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(tenants)
      .values({ id: LOCAL_TENANT, slug: 'local', name: 'Local Dev' })
      .onConflictDoNothing();
    await tx
      .insert(tenantDbInstances)
      .values({
        tenantId: LOCAL_TENANT,
        boltUri: 'bolt://neo4j:7687',
        secretRef: 'env:NEO4J_PASSWORD',
        neo4jVersion: '5.26',
      })
      .onConflictDoNothing();

    const mmStore = new MetamodelStore(tx);
    const metamodelId = await mmStore.register(LOCAL_TENANT, loadStarterMetamodel(), 'seed');
    await mmStore.activate(LOCAL_TENANT, metamodelId);

    const wsStore = new WorkspaceStore(tx);
    const existing = await wsStore.bySlug(LOCAL_TENANT, LOCAL_WORKSPACE_SLUG);
    if (existing) {
      // Local dev follows the starter metamodel as it evolves.
      if (existing.metamodelId !== metamodelId) {
        await wsStore.setMetamodel(LOCAL_TENANT, existing.id, metamodelId);
      }
      return { workspaceId: existing.id, metamodelId };
    }
    const ws = await wsStore.create(LOCAL_TENANT, {
      slug: LOCAL_WORKSPACE_SLUG,
      name: 'Default',
      description: 'Local development workspace',
      metamodelId,
    });
    return { workspaceId: ws.id, metamodelId };
  });
}

if (require.main === module) {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error('POSTGRES_URL is required');
  const handle = createDb(url, 1);
  runMigrations(handle.db)
    .then(() => seedLocal(handle.db))
    .then((r) => console.log(`Migrated and seeded tenant '${LOCAL_TENANT}':`, r))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => handle.close());
}
