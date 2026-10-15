# ADR 0001: One Neo4j Community instance per tenant

**Status:** Accepted, 2026-10-15

## Context
Neo4j Community Edition is mandated. It allows one user database per server and has no clustering, no role-based database security and no online backup. D4 is multi-tenant SaaS.

## Decision
Each tenant gets its own Neo4j Community instance (a Kubernetes StatefulSet in production, a compose service locally). The control plane in Postgres (`tenant_db_instances`) maps each tenant to its Bolt URI and secret reference. Only `TenantGraphService` in the API opens connections, and it always routes by the signed `tenant` token claim.

## Consequences
- Tenants are isolated at the process and storage level. Nodes carry no `tenantId`.
- Scaling is vertical per tenant. Backups use `neo4j-admin database dump` plus rebuilds from the Postgres event log.
- The Tenant Provisioner (Phase 5) must automate the instance lifecycle.
