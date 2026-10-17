# ADR 0004: Writing the graph and the event log together

**Status:** Accepted, 2026-10-17

## Context
Every model change updates the tenant's Neo4j graph and appends domain events to the Postgres event log. The two databases cannot share a transaction.

## Decision
`ModelService` produces a ChangeSet: the new state plus its events. The Neo4j repository applies it through an `EventSink`:

1. Open a Postgres transaction and insert the events.
2. Run the Neo4j write transaction. Every update matches on `version = expected - 1`, so a concurrent change fails with `VERSION_CONFLICT` and nothing is written.
3. Commit Postgres.

If Neo4j fails, the events roll back. The only remaining gap is Postgres failing to commit after Neo4j has committed. That leaves the graph one version ahead of the log for that item.

## Consequences
- In the normal path, the log and the graph agree, and failures are surfaced to the caller.
- The gap is detectable, because node versions are higher than the last logged version. A reconciliation job (Phase 4 Worker) will report and repair it.
- The event log stays append-only (migration 0001), so it remains a trustworthy audit trail.
