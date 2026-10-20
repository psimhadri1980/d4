import { ModelService } from '@d4/core';
import { EventStore, type Db } from '@d4/db';
import { GraphQueries, Neo4jModelRepository, type EventSink, type SessionProvider } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { GraphQuotaGuard } from './usage';

export interface ModelHandles {
  service: ModelService;
  /** For whole-change-set writes (imports); single commands go through `service`. */
  repository: Neo4jModelRepository;
  queries: GraphQueries;
  events: EventStore;
}

/**
 * Events and graph writes live in different databases. The events are inserted inside an open
 * Postgres transaction, the Neo4j write commits, then Postgres commits. A Neo4j failure rolls
 * the events back; the remaining gap (Postgres commit failing after Neo4j committed) is
 * detectable by comparing node versions with the log and is reconciled by a later job.
 */
export function eventSink(db: Db, tenantId: string, quota?: { guard: GraphQuotaGuard; sessions: SessionProvider }): EventSink {
  return {
    withEvents: async (events, write) => {
      // Every model write (commands, imports, approved proposals) passes here, so quotas hold everywhere.
      const counted = quota ? await quota.guard.check(tenantId, quota.sessions, events) : undefined;
      await db.transaction(async (tx) => {
        await new EventStore(tx).append(tenantId, events);
        await write();
      });
      counted?.();
    },
  };
}

/**
 * The domain objects for one tenant workspace (same in the API and the worker). With a quota
 * guard, writes that would grow the graph past the tenant's limits are refused.
 */
export function modelHandles(db: Db, registry: MetamodelRegistry, sessions: SessionProvider, tenantId: string, guard?: GraphQuotaGuard): ModelHandles {
  const repository = new Neo4jModelRepository(registry, sessions, eventSink(db, tenantId, guard && { guard, sessions }));
  return {
    service: new ModelService(registry, repository),
    repository,
    queries: new GraphQueries(registry, sessions),
    events: new EventStore(db),
  };
}
