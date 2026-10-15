# ADR 0002: Users run curated Cypher, never ad-hoc Cypher

**Status:** Accepted, 2026-10-15

## Context
Cypher is the mandatory query language. Community Edition has no fine-grained database security, so any Cypher that reaches the database runs with full rights.

## Decision
- End users run only **published Query Catalog entries**: versioned, hashed, parameterised, and granted to roles.
- Only users with the `query-author` role write Cypher, and only in the Query Studio.
- `query-steward` users review, publish and assign queries to roles.
- Safety checks (read/write classification via `EXPLAIN`, a procedure allow-list, a cost estimate) run when a query is published.
- At run time the service also enforces a READ session, a timeout, a row cap and a hash check.

## Consequences
- The catalog service is the security boundary for reads.
- Write-class catalog entries go through the audited command pipeline and need admin approval.
