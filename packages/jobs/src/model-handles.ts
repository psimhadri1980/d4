import { ModelService } from '@d4/core';
import { EventStore, type Db } from '@d4/db';
import { GraphQueries, Neo4jModelRepository, type EventSink, type SessionProvider } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';

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
export function eventSink(db: Db, tenantId: string): EventSink {
  return {
    withEvents: (events, write) =>
      db.transaction(async (tx) => {
        await new EventStore(tx).append(tenantId, events);
        await write();
      }),
  };
}

/** The domain objects for one tenant workspace (same in the API and the worker). */
export function modelHandles(db: Db, registry: MetamodelRegistry, sessions: SessionProvider, tenantId: string): ModelHandles {
  const repository = new Neo4jModelRepository(registry, sessions, eventSink(db, tenantId));
  return {
    service: new ModelService(registry, repository),
    repository,
    queries: new GraphQueries(registry, sessions),
    events: new EventStore(db),
  };
}
