# D4 — Design-to-Delivery Graph Platform

Capture, decide, plan, develop and deliver design elements as a connected graph. Users can then visualise, query (through a curated Cypher Query Catalog) and export roadmaps and dependencies.

Stack: TypeScript end to end, Neo4j 5 Community (one instance per tenant), PostgreSQL control plane, Redis, S3, Keycloak.

## Layout

```
apps/api              NestJS API: OIDC auth, tenant → Neo4j routing, health
packages/metamodel    Metamodel schema, validator, registry, starter.yaml (~125 node types)
packages/cypher       Cypher utilities: schema DDL generated from the metamodel
deploy/               docker-compose for local infra, Keycloak realm, Postgres bootstrap
docs/adr/             Architecture decision records
```

## Prerequisites

- Node.js ≥ 20.11 and pnpm 9 (`corepack enable`)
- Docker Desktop (or another Docker engine with Compose)

## Getting started

```bash
cp .env.example .env
pnpm install
pnpm infra:up          # neo4j, postgres, redis, minio, keycloak, otel-collector
pnpm build && pnpm test
pnpm db:schema         # apply Neo4j constraints/indexes to the local tenant
pnpm --filter @d4/api dev
```

Smoke test:

```bash
curl localhost:3000/healthz
TOKEN=$(curl -s -d client_id=d4-web -d grant_type=password -d username=dev-admin -d password=d4-local-dev \
  localhost:8080/realms/d4/protocol/openid-connect/token | jq -r .access_token)
curl -H "Authorization: Bearer $TOKEN" localhost:3000/v1/me   # → tenant t_local, roles, graph: ok
```

Local consoles:

| Service | URL |
|---|---|
| Neo4j Browser | http://localhost:7474 (neo4j / d4-local-dev) |
| Keycloak | http://localhost:8080 (admin / d4-local-dev) |
| MinIO | http://localhost:9001 (d4 / d4-local-dev) |

All of these are local development credentials only.
