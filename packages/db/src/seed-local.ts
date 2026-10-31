import { loadStarterMetamodel } from '@d4/metamodel';
import type { Db } from './client';
import { tenantDbInstances, tenants } from './schema';
import { MetamodelStore, WorkspaceStore } from './stores';
import { WebModuleStore } from './web-modules';

export const LOCAL_TENANT = 't_local';
export const LOCAL_WORKSPACE_SLUG = 'default';

/** The modules the dev stack's web-admin container serves under /mfe/ (P6 spike, D64). */
const LOCAL_WEB_MODULES = [
  { name: 'admin', title: 'Administration', description: 'Workspaces, people and roles, webhooks, usage', owner: 'platform', entry: '/mfe/admin/admin.js', version: '0.1.0', contract: 2, framework: 'react', enabled: true },
  { name: 'reporting', title: 'Reporting', description: 'Scheduled reports and background jobs', owner: 'platform', entry: '/mfe/reporting/reporting.js', version: '0.1.0', contract: 2, framework: 'react', enabled: true },
  { name: 'hello', title: 'Hello', description: 'A plain JavaScript module (contract example)', owner: 'platform', entry: '/mfe/hello/hello.js', version: '0.1.0', contract: 2, framework: 'vanilla', enabled: true },
];

/**
 * Idempotent local-development seed: tenant `t_local` pointing at the compose Neo4j, the starter
 * metamodel (active), a `default` workspace and the web modules the dev stack serves.
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

    const modules = new WebModuleStore(tx);
    for (const m of LOCAL_WEB_MODULES) await modules.putIfAbsent(LOCAL_TENANT, m.name, m, 'seed');

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
