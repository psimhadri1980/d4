import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from './config';

export interface TenantDbInstance {
  tenantId: string;
  boltUri: string;
  secretRef: string;
}

/** Read access to the Postgres control plane (tenants and their Neo4j instances). */
@Injectable()
export class ControlPlaneService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.POSTGRES_URL, max: 10 });
  }

  async tenantDb(tenantId: string): Promise<TenantDbInstance | undefined> {
    const { rows } = await this.pool.query(
      `SELECT i.tenant_id, i.bolt_uri, i.secret_ref
         FROM tenant_db_instances i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.tenant_id = $1 AND t.status = 'active' AND i.status = 'ready'`,
      [tenantId],
    );
    const r = rows[0];
    return r && { tenantId: r.tenant_id, boltUri: r.bolt_uri, secretRef: r.secret_ref };
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
