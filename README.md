# D4 — Design-to-Delivery Graph Platform

Capture, decide, plan, develop and deliver design elements as a connected graph. Users can then visualise, query (through a curated Cypher Query Catalog) and export roadmaps and dependencies.

Stack: TypeScript end to end, Neo4j 5 Community (one instance per tenant), PostgreSQL control plane, Redis, S3, Keycloak.

## Layout

```
apps/api              NestJS API: OIDC auth, workspace access, REST commands + GraphQL reads
apps/web              React explorer: Keycloak login, search, graph canvas, metamodel-driven forms
apps/e2e              Playwright browser tests against the running stack
packages/metamodel    Metamodel schema, validator, registry, starter.yaml (~125 node types)
packages/core         Domain model: elements, relationships, lifecycle, rules, ModelService
packages/cypher       Cypher utilities: schema DDL generated from the metamodel
packages/db           Postgres control plane: Drizzle schema, migrations, stores, local seed
packages/graph        Neo4j adapter: ModelRepository and read queries (list/search, neighbourhood)
packages/codecs       Model-as-code documents (YAML/JSON): parse, import input, export
packages/cli          `d4` command line: validate, import, export, workspaces
samples/              Example models, e.g. ubs-banking.yaml (illustrative)
deploy/               docker-compose for local infra, Keycloak realm, Postgres bootstrap
docs/adr/             Architecture decision records
```

## Local stack (Docker only, no Node needed)

Prerequisite: Docker Desktop running. On an 8 GB machine, give it at least 4 GB of memory under Settings → Resources.

```bash
deploy/dev.sh up        # build the API image, start the core stack, apply the Neo4j schema, create buckets
deploy/dev.sh smoke     # health checks + Keycloak login + /v1/me
deploy/dev.sh test      # unit + integration tests inside a container
deploy/dev.sh e2e       # Playwright browser tests against the running stack (report: apps/e2e/results/report)
deploy/dev.sh up-obs    # also start OTel collector, Tempo, Prometheus, Grafana
deploy/dev.sh status | logs <svc> | down | reset   # reset also deletes all volumes
```

| Component | Purpose | Memory cap |
|---|---|---|
| neo4j 5.26 Community + APOC + GDS | Tenant graph (`t_local`) | 1.8 GB |
| postgres 16 | Control plane (tenants, events) | 256 MB |
| redis 7 | Queue / cache | 128 MB |
| s3 (SeaweedFS) | S3 API on :8333, buckets `d4-exports`, `d4-attachments`, `d4-backups` | 256 MB |
| keycloak 25 | OIDC realm `d4`, roles, dev users | 768 MB |
| db-migrate, neo4j-schema, s3-init | One-shot jobs: Postgres migrations + local seed, Neo4j schema, S3 buckets | — |
| api | D4 API on :3000 | 384 MB |
| web | D4 Explorer on http://localhost:5173 (nginx, static build) | 64 MB |
| otel-collector, tempo, prometheus, grafana (:3001) | Observability profile (optional) | ~1 GB |

## Web app

Open http://localhost:5173 and sign in with one of the local dev users (password `d4-local-dev` for all; local only):

| User | Roles | Use it to |
|---|---|---|
| `dev-admin` | admin, query-author, query-steward | Everything |
| `dev-viewer` | viewer | Browse and run granted catalog queries (read-only) |
| `dev-author` | query-author, viewer | Write catalog queries in the Query Studio and submit them |
| `dev-steward` | query-steward, viewer | Review, publish, grant and deprecate catalog queries | Run `deploy/dev.sh sample` first to get something to explore.

- **Left:** search names and descriptions, filter by layer and type.
- **Centre:** the selected element's neighbourhood (depth 1–3), coloured by layer. Double-click a node to expand it; dashed edges are not valid yet (e.g. a planned hand-over).
- **Right:** attributes, relationships (add or remove; only types the metamodel allows are offered), and change history.
- **New element / Edit:** forms come from the metamodel. Lifecycle offers only the allowed moves, and the same validation as the server runs in the browser.

### Browser tests

`deploy/dev.sh e2e` runs 20 Playwright tests in Chromium against the live stack:
- sign-in and sign-out through Keycloak
- search, filters, graph depth, details and navigation (on the UBS sample)
- metamodel-driven create and edit, lifecycle rules, validation, history, delete
- relationships: allowed types only, add with role and validity, remove, rule violation
- a read-only viewer being refused

Setup imports the sample if it's missing. Everything a run creates is prefixed `e2erun…` and deleted afterwards. Extra arguments go to Playwright, e.g. `deploy/dev.sh e2e --grep relationships`. Failures keep a trace and screenshot in `apps/e2e/results/`.

The stack needs about 3.3 GB, and the browser tests add about 1 GB. On a 4 GB Docker VM it fits, but only just; 6 GB under Docker Desktop → Settings → Resources is more comfortable.

## API

| Interface | Where | Use |
|---|---|---|
| REST | `/v1/...`, OpenAPI at http://localhost:3000/v1/openapi.json | Create, update and delete elements and relationships; list, search, neighbourhood, history |
| GraphQL | `POST /graphql` | Graph-shaped reads: workspace → elements → connections → … (read-only) |

All endpoints except `/healthz`, `/readyz` and `/v1/openapi.json` need a Keycloak bearer token (see `deploy/dev.sh smoke`). Writes need the contributor, planner, architect or admin role, either from Keycloak or from a workspace role binding. Updates and deletes take `expectedVersion` (optimistic concurrency).

## Query Catalog

Users don't write Cypher; they run published catalog queries (ADR 0002).

| Endpoint | Who | Purpose |
|---|---|---|
| `GET /v1/catalog?q=&tag=` | everyone | Queries you can run (authors and stewards see all) |
| `GET /v1/catalog/:id` | everyone | Detail, versions; grants for authors and stewards |
| `POST /v1/workspaces/:ws/catalog/:id/run` | granted roles | Run with `{ params, version? }`; table results, capped and logged |
| `POST /v1/catalog`, `PUT /v1/catalog/:id/draft`, `POST …/submit` | query-author | Create, draft (checks recorded), submit |
| `POST …/review`, `POST …/versions/:v/status`, `PUT …/grants`, `PATCH …` | query-steward | Publish or send back, deprecate or retire, grant, certify |
| `GET …/executions` | steward or owning author | Run history |

The system pack (`packages/cypher/packs/system`) is installed into each tenant on first use.

## Model as code

Models can be written as YAML (`apiVersion: d4/v1`, `kind: Model`) and imported. Elements get a `key` that relationships refer to. Imports are idempotent: items are matched by id, then `externalKey`, then type + name. The whole resulting model is validated before anything is written, and nothing is ever deleted by an import.

```bash
deploy/dev.sh sample                                    # import samples/ubs-banking.yaml into "default"
deploy/dev.sh cli validate samples/ubs-banking.yaml     # offline check against the starter metamodel
deploy/dev.sh cli import my-model.yaml -w default --dry-run
deploy/dev.sh cli export -w default -o exports/default.yaml
```

`samples/ubs-banking.yaml` is **illustrative**. Its legal entity and divisions follow UBS's public reporting structure, but all systems, data stores, processes, decisions and plans are invented.

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
