import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { DomainError } from '@d4/core';
import { TenantStore, type Db } from '@d4/db';
import type { SessionProvider } from '@d4/graph';

export interface GraphConfig {
  user: string;
  /** For `env:NEO4J_PASSWORD` secret refs (the local tenant). */
  password: string;
  /** Legacy local override: every tenant's bolt URI is replaced by this one. Ignored when `hosts` is set. */
  uriOverride?: string;
  /**
   * Where processes outside the container network reach tenant instances: host name in the
   * registered bolt URI → host:port (e.g. `neo4j` → `localhost:7687`). Unlisted hosts are used as is.
   */
  hosts?: Record<string, string>;
  /** Directory holding `file:` secrets (one file per secret, as Kubernetes mounts them). */
  secretsDir?: string;
}

/** Parses `NEO4J_HOSTS` (`neo4j=localhost:7687,d4-neo4j-t_acme=localhost:7701`). */
export function parseHosts(spec: string | undefined): Record<string, string> | undefined {
  if (!spec?.trim()) return undefined;
  return Object.fromEntries(
    spec.split(',').map((pair) => {
      const [host, target] = pair.split('=').map((x) => x.trim());
      if (!host || !target || !/^[\w.-]+:\d+$/.test(target)) throw new Error(`NEO4J_HOSTS: '${pair}' is not host=host:port`);
      return [host, target];
    }),
  );
}

/** The URI a process should dial for a registered bolt URI. */
export function routeUri(boltUri: string, config: Pick<GraphConfig, 'uriOverride' | 'hosts'>): string {
  if (!config.hosts) return config.uriOverride ?? boltUri;
  const url = new URL(boltUri);
  const target = config.hosts[url.hostname];
  return target ? `${url.protocol}//${target}` : boltUri;
}

/** Resolves a secret reference: `env:NEO4J_PASSWORD`, or `file:<name>` under the secrets directory. */
export function resolveSecret(ref: string, config: Pick<GraphConfig, 'password' | 'secretsDir'>): string {
  if (ref === 'env:NEO4J_PASSWORD') return config.password;
  const file = /^file:([A-Za-z0-9_.-]+)$/.exec(ref)?.[1];
  if (file && config.secretsDir) return readFileSync(join(config.secretsDir, file), 'utf8').trim();
  throw new Error(`Unsupported secret reference '${ref}'${file ? ' (no secrets directory configured)' : ''}`);
}

/**
 * Checks, and on first use records, which tenant a Neo4j database belongs to. A database marked
 * for another tenant is refused, so a wrong registry entry or host mapping can never route one
 * tenant's requests to another tenant's graph.
 */
export async function claimDatabase(driver: Driver, tenantId: string): Promise<void> {
  const res = await driver.executeQuery(
    'MERGE (m:D4Tenant {singleton: true}) ON CREATE SET m.tenantId = $tenant, m.claimedAt = datetime() RETURN m.tenantId AS owner',
    { tenant: tenantId },
  );
  const owner = res.records[0]?.get('owner') as string | undefined;
  if (owner !== tenantId) throw new DomainError('NOT_FOUND', `The graph database registered for tenant '${tenantId}' belongs to another tenant`);
}

/**
 * Routes each tenant to its own Neo4j Community instance (ADR 0001). Drivers are created lazily
 * and cached; failures are not cached, so the next call retries. Used by the API and the worker.
 */
export class TenantGraphs {
  private readonly drivers = new Map<string, Promise<Driver>>();

  constructor(
    private readonly db: Db,
    private readonly config: GraphConfig,
  ) {}

  async session(tenantId: string, mode: 'READ' | 'WRITE' = 'READ'): Promise<Session> {
    const driver = await this.driver(tenantId);
    return driver.session({ defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE });
  }

  sessions(tenantId: string): SessionProvider {
    return (mode) => this.session(tenantId, mode);
  }

  async ping(tenantId: string): Promise<void> {
    await (await this.driver(tenantId)).verifyConnectivity();
  }

  /** Drops a tenant's cached driver (after suspension, or when its instance moved). */
  async forget(tenantId: string): Promise<void> {
    const d = this.drivers.get(tenantId);
    this.drivers.delete(tenantId);
    await d?.then((x) => x.close()).catch(() => undefined);
  }

  private driver(tenantId: string): Promise<Driver> {
    let d = this.drivers.get(tenantId);
    if (!d) {
      d = this.createDriver(tenantId);
      d.catch(() => this.drivers.delete(tenantId));
      this.drivers.set(tenantId, d);
    }
    return d;
  }

  private async createDriver(tenantId: string): Promise<Driver> {
    const inst = await new TenantStore(this.db).readyDbInstance(tenantId);
    if (!inst) throw new DomainError('NOT_FOUND', `No ready graph database for tenant '${tenantId}'`);
    const driver = neo4j.driver(routeUri(inst.boltUri, this.config), neo4j.auth.basic(this.config.user, resolveSecret(inst.secretRef, this.config)), {
      // Plain JS numbers instead of neo4j Integer objects.
      disableLosslessIntegers: true,
    });
    try {
      await claimDatabase(driver, tenantId);
    } catch (e) {
      await driver.close();
      throw e;
    }
    return driver;
  }

  async close(): Promise<void> {
    const drivers = await Promise.allSettled(this.drivers.values());
    await Promise.all(drivers.flatMap((d) => (d.status === 'fulfilled' ? [d.value.close()] : [])));
    this.drivers.clear();
  }
}

/** The Neo4j settings every service reads from its environment. */
export interface GraphEnv {
  NEO4J_USER: string;
  NEO4J_PASSWORD: string;
  NEO4J_URI?: string | undefined;
  NEO4J_HOSTS?: string | undefined;
  NEO4J_SECRETS_DIR?: string | undefined;
}

export function graphConfig(env: GraphEnv): GraphConfig {
  const hosts = parseHosts(env.NEO4J_HOSTS);
  return {
    user: env.NEO4J_USER,
    password: env.NEO4J_PASSWORD,
    ...(env.NEO4J_URI && { uriOverride: env.NEO4J_URI }),
    ...(hosts && { hosts }),
    ...(env.NEO4J_SECRETS_DIR && { secretsDir: env.NEO4J_SECRETS_DIR }),
  };
}
