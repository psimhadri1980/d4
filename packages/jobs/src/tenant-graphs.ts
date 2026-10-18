import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { DomainError } from '@d4/core';
import { TenantStore, type Db } from '@d4/db';
import type { SessionProvider } from '@d4/graph';

export interface GraphConfig {
  user: string;
  password: string;
  /** Overrides tenant bolt URIs in local dev, where the registry stores in-cluster hostnames. */
  uriOverride?: string;
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
    return neo4j.driver(this.config.uriOverride ?? inst.boltUri, neo4j.auth.basic(this.config.user, this.resolveSecret(inst.secretRef)), {
      // Plain JS numbers instead of neo4j Integer objects.
      disableLosslessIntegers: true,
    });
  }

  /** Supports `env:` refs only for now; Phase 5 adds Kubernetes/Vault secret refs. */
  private resolveSecret(ref: string): string {
    if (ref === 'env:NEO4J_PASSWORD') return this.config.password;
    throw new Error(`Unsupported secret reference '${ref}'`);
  }

  async close(): Promise<void> {
    const drivers = await Promise.allSettled(this.drivers.values());
    await Promise.all(drivers.flatMap((d) => (d.status === 'fulfilled' ? [d.value.close()] : [])));
    this.drivers.clear();
  }
}
