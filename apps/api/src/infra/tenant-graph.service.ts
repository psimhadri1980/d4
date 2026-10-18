import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Session } from 'neo4j-driver';
import type { SessionProvider } from '@d4/graph';
import { TenantGraphs } from '@d4/jobs';
import { APP_CONFIG, type AppConfig } from '../config';
import { Database } from './database.service';

/**
 * Routes each tenant to its own Neo4j Community instance (ADR 0001); the routing itself is in
 * `@d4/jobs` so the worker uses the same code. Nothing else opens graph connections.
 */
@Injectable()
export class TenantGraphService implements OnModuleDestroy {
  readonly graphs: TenantGraphs;

  constructor(@Inject(APP_CONFIG) config: AppConfig, @Inject(Database) database: Database) {
    this.graphs = new TenantGraphs(database.db, {
      user: config.NEO4J_USER,
      password: config.NEO4J_PASSWORD,
      ...(config.NEO4J_URI && { uriOverride: config.NEO4J_URI }),
    });
  }

  session(tenantId: string, mode: 'READ' | 'WRITE' = 'READ'): Promise<Session> {
    return this.graphs.session(tenantId, mode);
  }

  sessions(tenantId: string): SessionProvider {
    return this.graphs.sessions(tenantId);
  }

  ping(tenantId: string): Promise<void> {
    return this.graphs.ping(tenantId);
  }

  onModuleDestroy() {
    return this.graphs.close();
  }
}
