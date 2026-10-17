# D4 — Design-to-Delivery Graph Platform

Capture, decide, plan, develop and deliver design elements as a connected graph. Users can then visualise, query (through a curated Cypher Query Catalog) and export roadmaps and dependencies.

Stack: TypeScript end to end, Neo4j 5 Community (one instance per tenant), PostgreSQL control plane, Redis, S3, Keycloak.

## Layout

```
apps/api              NestJS API: OIDC auth, tenant → Neo4j routing, health
packages/metamodel    Metamodel schema, validator, registry, starter.yaml (~125 node types)
packages/core         Domain model: elements, relationships, lifecycle, rules, ModelService
packages/cypher       Cypher utilities: schema DDL generated from the metamodel
packages/db           Postgres control plane: Drizzle schema, migrations, stores, local seed
deploy/               docker-compose for local infra, Keycloak realm, Postgres bootstrap
docs/adr/             Architecture decision records
```

## Local stack (Docker only, no Node needed)

Prerequisite: Docker Desktop running. On an 8 GB machine, give it at least 4 GB of memory under Settings → Resources.

```bash
deploy/dev.sh up        # build the API image, start the core stack, apply the Neo4j schema, create buckets
deploy/dev.sh smoke     # health checks + Keycloak login + /v1/me
deploy/dev.sh test      # run the whole test suite inside a container
deploy/dev.sh up-obs    # also start OTel collector, Tempo, Prometheus, Grafana
deploy/dev.sh status | logs <svc> | down | reset   # reset also deletes all volumes
```

| Component | Purpose | Memory cap |
|---|---|---|
| neo4j 5.26 Community + APOC + GDS | Tenant graph (`t_local`) | 1.4 GB |
| postgres 16 | Control plane (tenants, events) | 256 MB |
| redis 7 | Queue / cache | 128 MB |
| s3 (SeaweedFS) | S3 API on :8333, buckets `d4-exports`, `d4-attachments`, `d4-backups` | 256 MB |
| keycloak 25 | OIDC realm `d4`, roles, dev users | 768 MB |
| db-migrate, neo4j-schema, s3-init | One-shot jobs: Postgres migrations + local seed, Neo4j schema, S3 buckets | — |
| api | D4 API on :3000 | 384 MB |
| otel-collector, tempo, prometheus, grafana (:3001) | Observability profile (optional) | ~1 GB |

## Developing with Node locally (optional)

Requires Node.js ≥ 20.11 and pnpm 9 (`corepack enable`).

```bash
cp .env.example .env && pnpm install && pnpm build && pnpm test
pnpm --filter @d4/api dev    # with the data stores from deploy/dev.sh up
```

Local consoles:

| Service | URL |
|---|---|
| Neo4j Browser | http://localhost:7474 (neo4j / d4-local-dev) |
| Keycloak | http://localhost:8080 (admin / d4-local-dev) |
| S3 API (SeaweedFS) | http://localhost:8333 (access key d4 / d4-local-dev) |
| Grafana | http://localhost:3001 (admin / d4-local-dev) |

All of these are local development credentials only.
