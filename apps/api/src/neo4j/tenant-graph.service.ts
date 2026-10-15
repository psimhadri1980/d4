import { Inject, Injectable, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import { APP_CONFIG, type AppConfig } from '../config';
import { ControlPlaneService } from '../control-plane.service';

/**
 * Routes each tenant to its own Neo4j Community instance. Drivers are created lazily and
 * cached; nothing outside this service ever chooses a database connection.
 */
@Injectable()
export class TenantGraphService implements OnModuleDestroy {
  private readonly drivers = new Map<string, Promise<Driver>>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ControlPlaneService) private readonly controlPlane: ControlPlaneService,
  ) {}

  async session(tenantId: string, mode: 'READ' | 'WRITE' = 'READ'): Promise<Session> {
    const driver = await this.driver(tenantId);
    return driver.session({
      defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
    });
  }

  async ping(tenantId: string): Promise<void> {
    await (await this.driver(tenantId)).verifyConnectivity();
  }

  private driver(tenantId: string): Promise<Driver> {
    let d = this.drivers.get(tenantId);
    if (!d) {
      d = this.createDriver(tenantId);
      // Don't cache failures; the next request retries.
      d.catch(() => this.drivers.delete(tenantId));
      this.drivers.set(tenantId, d);
    }
    return d;
  }

  private async createDriver(tenantId: string): Promise<Driver> {
    const inst = await this.controlPlane.tenantDb(tenantId);
    if (!inst) throw new NotFoundException(`No ready graph database for tenant '${tenantId}'`);
    const uri = this.config.NEO4J_URI ?? inst.boltUri;
    return neo4j.driver(uri, neo4j.auth.basic(this.config.NEO4J_USER, this.resolveSecret(inst.secretRef)));
  }

  /** Phase 0 supports `env:` refs only; Phase 5 adds Kubernetes/Vault secret refs. */
  private resolveSecret(ref: string): string {
    if (ref === 'env:NEO4J_PASSWORD') return this.config.NEO4J_PASSWORD;
    throw new Error(`Unsupported secret reference '${ref}'`);
  }

  async onModuleDestroy() {
    const drivers = await Promise.allSettled(this.drivers.values());
    await Promise.all(
      drivers.flatMap((d) => (d.status === 'fulfilled' ? [d.value.close()] : [])),
    );
  }
}
