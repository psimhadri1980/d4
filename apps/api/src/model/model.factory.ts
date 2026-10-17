import { Inject, Injectable } from '@nestjs/common';
import { ModelService } from '@d4/core';
import { EventStore } from '@d4/db';
import { GraphQueries, Neo4jModelRepository, type EventSink } from '@d4/graph';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import type { WorkspaceScope } from './workspace-access.service';

export interface ModelHandles {
  service: ModelService;
  queries: GraphQueries;
  events: EventStore;
}

/** Builds the per-request domain objects for one tenant workspace. */
@Injectable()
export class ModelFactory {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
  ) {}

  for(scope: WorkspaceScope): ModelHandles {
    const sessions = this.graph.sessions(scope.tenantId);
    const repo = new Neo4jModelRepository(scope.registry, sessions, this.eventSink(scope.tenantId));
    return {
      service: new ModelService(scope.registry, repo),
      queries: new GraphQueries(scope.registry, sessions),
      events: new EventStore(this.database.db),
    };
  }

  /**
   * Events and graph writes live in different databases. The events are inserted inside an open
   * Postgres transaction, the Neo4j write commits, then Postgres commits. A Neo4j failure rolls
   * the events back; the remaining gap (Postgres commit failing after Neo4j committed) is
   * detectable by comparing node versions with the log and is reconciled by a later job.
   */
  private eventSink(tenantId: string): EventSink {
    return {
      withEvents: (events, write) =>
        this.database.db.transaction(async (tx) => {
          await new EventStore(tx).append(tenantId, events);
          await write();
        }),
    };
  }
}
