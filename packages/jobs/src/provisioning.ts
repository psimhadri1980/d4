import neo4j, { type Driver } from 'neo4j-driver';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { MetamodelStore, TenantStore, WorkspaceStore, type Db } from '@d4/db';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { claimDatabase, resolveSecret, routeUri, type GraphConfig } from './tenant-graphs';

/** Where a tenant's Neo4j instance is, once something has started it. */
export interface InstanceLocation {
  boltUri: string;
  secretRef: string;
  neo4jVersion: string;
}

/**
 * Starts and stops tenant graph instances. The manual driver is used locally: the operator starts
 * the container (`deploy/dev.sh tenant-create`), so no service needs access to the Docker daemon.
 * A Kubernetes driver (StatefulSet, volume and Secret per tenant) implements the same interface.
 */
export interface InstanceDriver {
  readonly name: string;
  /** Makes sure the tenant has an instance and says where it is. */
  ensure(tenantId: string): Promise<InstanceLocation>;
  /** Stops the instance; data is kept unless the driver documents otherwise. */
  stop(tenantId: string): Promise<void>;
}

/** The operator has already started the instance and says where it is. */
export class ManualInstanceDriver implements InstanceDriver {
  readonly name = 'manual';
  constructor(private readonly location: InstanceLocation) {}
  async ensure(): Promise<InstanceLocation> {
    return this.location;
  }
  async stop(): Promise<void> {
    // Nothing to do: the operator stops the container.
  }
}

export const TENANT_ID = /^t_[a-z0-9][a-z0-9_]{1,30}$/;

export interface ProvisionRequest {
  tenantId: string;
  slug: string;
  name: string;
}

export interface ProvisionOptions {
  graph: GraphConfig;
  /** How long to wait for a freshly started instance to accept connections. */
  waitMs?: number;
  log?: (step: string) => void;
}

/**
 * Brings a tenant to a usable state; safe to run again (for example after a failure part-way).
 *
 * 1. Tenant row (kept suspended until the end, so nobody uses a half-made tenant).
 * 2. Instance registered as `provisioning`; the driver says where it is.
 * 3. Wait until it accepts connections; claim the database for this tenant (refused if it
 *    belongs to another tenant).
 * 4. Constraints and indexes for the starter metamodel; wait until they are online.
 * 5. Starter metamodel registered and active; a `default` workspace.
 * 6. Instance `ready`, tenant `active`.
 */
export async function provisionTenant(db: Db, driver: InstanceDriver, req: ProvisionRequest, opts: ProvisionOptions): Promise<{ tenantId: string; workspaceId: string; boltUri: string }> {
  const log = opts.log ?? (() => undefined);
  if (!TENANT_ID.test(req.tenantId)) throw new Error(`Tenant id '${req.tenantId}' must look like t_acme (lowercase letters, digits, underscores)`);
  const tenants = new TenantStore(db);
  const existing = await tenants.get(req.tenantId);
  // A tenant an operator suspended stays suspended when provisioning is re-run; only an unfinished one is activated.
  const finishedBefore = existing && (await tenants.instance(req.tenantId))?.status === 'ready';
  if (existing?.status === 'deleted') throw new Error(`Tenant '${req.tenantId}' was deleted; use a new id`);
  if (!existing) {
    await tenants.ensure({ id: req.tenantId, slug: req.slug, name: req.name });
    await tenants.setStatus(req.tenantId, 'suspended');
  }
  log('tenant recorded');

  const location = await driver.ensure(req.tenantId);
  await tenants.upsertInstance({ tenantId: req.tenantId, ...location, status: 'provisioning' });
  log(`instance registered at ${location.boltUri} (${driver.name} driver)`);

  const neo = neo4j.driver(routeUri(location.boltUri, opts.graph), neo4j.auth.basic(opts.graph.user, resolveSecret(location.secretRef, opts.graph)), { disableLosslessIntegers: true });
  try {
    await waitForConnection(neo, opts.waitMs ?? 120_000);
    log('instance reachable');
    await claimDatabase(neo, req.tenantId);
    log('database claimed for this tenant');
    const registry = new MetamodelRegistry(loadStarterMetamodel());
    const session = neo.session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      const n = await applySchema(session, registry);
      await awaitSchemaOnline(session);
      log(`${n} schema statements applied`);
    } finally {
      await session.close();
    }
  } catch (e) {
    await tenants.setInstanceStatus(req.tenantId, 'failed');
    throw e;
  } finally {
    await neo.close();
  }

  const workspaceId = await db.transaction(async (tx) => {
    const mm = new MetamodelStore(tx);
    const metamodelId = await mm.register(req.tenantId, loadStarterMetamodel(), 'provisioning');
    await mm.activate(req.tenantId, metamodelId);
    const ws = new WorkspaceStore(tx);
    const found = await ws.bySlug(req.tenantId, 'default');
    return found?.id ?? (await ws.create(req.tenantId, { slug: 'default', name: 'Default', description: 'First workspace', metamodelId })).id;
  });
  log('starter metamodel and default workspace ready');

  await tenants.setInstanceStatus(req.tenantId, 'ready');
  if (!finishedBefore) await tenants.setStatus(req.tenantId, 'active');
  log('tenant active');
  return { tenantId: req.tenantId, workspaceId, boltUri: location.boltUri };
}

async function waitForConnection(driver: Driver, waitMs: number): Promise<void> {
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      await driver.verifyConnectivity();
      return;
    } catch (e) {
      if (Date.now() > until) throw new Error(`The instance did not accept connections within ${Math.round(waitMs / 1000)} s: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** Health of one tenant's instance, for operators. */
export async function checkTenant(db: Db, tenantId: string, graph: GraphConfig): Promise<{ ok: boolean; detail: string }> {
  const inst = await new TenantStore(db).instance(tenantId);
  if (!inst) return { ok: false, detail: 'no instance registered' };
  const neo = neo4j.driver(routeUri(inst.boltUri, graph), neo4j.auth.basic(graph.user, resolveSecret(inst.secretRef, graph)), { disableLosslessIntegers: true });
  try {
    const res = await neo.executeQuery('MATCH (m:D4Tenant) RETURN m.tenantId AS owner', {}, { routing: neo4j.routing.READ });
    const owner = res.records[0]?.get('owner');
    if (owner !== tenantId) return { ok: false, detail: owner ? `database belongs to '${owner}'` : 'database not claimed yet' };
    const n = await neo.executeQuery('MATCH (n:Element) RETURN count(n) AS n', {}, { routing: neo4j.routing.READ });
    return { ok: true, detail: `${inst.status}; ${Number(n.records[0]!.get('n'))} elements` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await neo.close();
  }
}
