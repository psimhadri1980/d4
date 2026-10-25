# D4 — Design-to-Delivery Graph Platform

Capture, decide, plan, develop and deliver design elements as a connected graph. Users can then visualise, query (through a curated Cypher Query Catalog) and export roadmaps and dependencies.

Stack: TypeScript end to end, Neo4j 5 Community (one instance per tenant), PostgreSQL control plane, Redis, S3, Keycloak.

For how to use the product see the **[User Manual](user-manual/README.md)**. For low-level details (architecture, request flows, recipes, testing, pitfalls) see **[docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)**.

## Layout

```
apps/api              NestJS API: OIDC auth, workspace access, REST commands + GraphQL reads
apps/worker           Background job worker: exports and spreadsheet imports from the Redis queue
apps/renderer         Renders roadmaps and graphs to PNG/PDF with headless Chromium (render queue)
apps/web              React app: explorer, queries, roadmap, compare, matrices, decisions, import, jobs
apps/e2e              Playwright browser tests against the running stack
packages/metamodel    Metamodel schema, validator, registry, starter.yaml (~125 node types)
packages/core         Domain model: elements, relationships, lifecycle, rules, ModelService
packages/cypher       Cypher utilities: schema DDL generated from the metamodel
packages/db           Postgres control plane: Drizzle schema, migrations, stores, local seed
packages/graph        Neo4j adapter: ModelRepository and read queries (list/search, neighbourhood)
packages/codecs       Model-as-code documents, CSV/Excel import, export formats (CSV, Excel, Mermaid, ArchiMate, Cypher)
packages/render       SVG pictures: roadmap Gantt and graph neighbourhood (shared with the web chart)
packages/jobs         Job queue, S3 artefacts, tenant graph routing and the work shared by api and worker
packages/cli          `d4` command line: validate, import, export, workspaces
samples/              Example models, e.g. ubs-banking.yaml (illustrative)
deploy/               compose files, env files, dev-infra/dev-deploy/dev/test scripts, Keycloak realm
docs/adr/             Architecture decision records
```

## Local stack (Podman only, no Node needed)

Prerequisite: rootless Podman 5 with `podman compose`, and `systemctl --user enable --now podman.socket`. `deploy/dev-infra.sh doctor` checks the setup. Settings are in `deploy/env/`.

```bash
deploy/dev-infra.sh up            # data stores, Keycloak, S3/SMTP mocks; migrations and Neo4j schema
deploy/dev-deploy.sh              # build and start api, worker, renderer, web (or name one: dev-deploy.sh api)
deploy/test.sh smoke              # health checks + Keycloak login + /v1/me
deploy/test.sh static             # typecheck, lint, knip
deploy/test.sh integration        # unit + integration tests inside a container
deploy/test.sh e2e                # Playwright browser tests against the running stack (report: apps/e2e/results/report)
deploy/dev-infra.sh up --obs      # also start OTel collector, Tempo, Prometheus, Grafana
deploy/dev-infra.sh status | logs <svc> | down | reset   # reset also deletes all volumes
```

| Component | Purpose | Memory cap |
|---|---|---|
| neo4j 5.26 Community + APOC + GDS | Tenant graph (`t_local`) | 1.8 GB |
| postgres 16 | Control plane (tenants, events) | 256 MB |
| redis 7 | Queue / cache | 128 MB |
| s3 (mocks/s3, file-backed) | S3 API on :8333, buckets `d4-exports`, `d4-attachments`, `d4-backups` | 256 MB |
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
| `dev-steward` | query-steward, viewer | Review, publish, grant and deprecate catalog queries |

Run `deploy/dev.sh sample` first to get something to explore. Every screen, feature and end-to-end journey is described, with screenshots, in the **[User Manual](user-manual/README.md)**.

### Look and feel

The UI follows IBM Carbon design principles: a dark shell header, layered greys, field-style inputs, contained tabs, and an accessible palette for metamodel layers. The header has a **Theme** picker (System, Light, Dark); the choice is remembered per browser.

Typography uses **Source Sans 3** (SIL Open Font License) as an open stand-in for the licensed UBS brand typeface, and IBM Plex Mono for Cypher. Both are bundled from npm, so nothing loads from external font services. To use the licensed font, add it with `@font-face` (e.g. in `apps/web/src/fonts.css`) and put its family first in `--font-sans` in `apps/web/src/styles.css`.

### Browser tests

`deploy/test.sh e2e` runs the Playwright suite in Chromium against the live stack:
- sign-in and sign-out through Keycloak
- search, filters, graph depth, details and navigation (on the UBS sample)
- metamodel-driven create and edit, lifecycle rules, validation, history, delete
- relationships: allowed types only, add with role and validity, remove, rule violation
- a read-only viewer being refused
- graph readability: for each layout and depth, no overlapping nodes, minimum node spacing, at most 2% of label pairs colliding, and the graph spread across the canvas
- time and scenarios: as-of views, a scenario overlay, Compare between dates and against a scenario
- administration (workspace lifecycle, granting and removing a role; no Admin page for viewers)
- scheduled reports (schedule from the Roadmap page, run now, download, change, pause, delete)
- pictures (a roadmap PDF and a graph PNG from the renderer)
- background jobs (an export downloaded from Jobs, an import run in the background)
- spreadsheet import (mapping, row problems, check then import)
- exports (Mermaid of the graph on screen, ArchiMate of the workspace, CSV as of a date)
- matrices (CRUD-I, data store roles over time, capability × application, lifecycle) and the decision log
- the Roadmap Studio: scope, lanes, zoom, conflicts, item details, reload and Mermaid export
- the Query Catalog end to end: viewer runs a system query; author drafts (checks shown), fixes and submits; steward publishes and grants; viewer runs the new query; steward deprecates and retires it

Setup imports the sample if it's missing. Everything a run creates is prefixed `e2erun…` and deleted afterwards. Extra arguments go to Playwright, e.g. `deploy/test.sh e2e --grep relationships`. Failures keep a trace and screenshot in `apps/e2e/results/`.

The stack needs about 3.3 GB, and the browser tests add about 1 GB. Rootless Podman runs containers directly on the host, so keep about 4–5 GB free.

## API

| Interface | Where | Use |
|---|---|---|
| REST | `/v1/...`, OpenAPI at http://localhost:3000/v1/openapi.json | Create, update and delete elements and relationships; list, search, neighbourhood, history; `GET /v1/workspaces/{ws}/roadmap?scope=<ids>&lanes=initiative|division|status|type|milestone|none` for a scheduled roadmap; `asOf` and `scenario` on reads; `GET /v1/workspaces/{ws}/diff?fromAsOf=&fromScenario=&toAsOf=&toScenario=`; `GET /v1/workspaces/{ws}/matrix/{crud|capability-application|data-store-roles|lifecycle}` and `/decisions` |
| GraphQL | `POST /graphql` | Graph-shaped reads: workspace → elements → connections → … (read-only) |

All endpoints except `/healthz`, `/readyz` and `/v1/openapi.json` need a Keycloak bearer token (see `deploy/test.sh smoke`). Writes need the contributor, planner, architect or admin role, either from Keycloak or from a workspace role binding. Updates and deletes take `expectedVersion` (optimistic concurrency).

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
deploy/dev.sh cli export -w default --format archimate -o exports/default.archimate.xml
deploy/dev.sh cli export -w default --format mermaid --as-of 2027-08-01 -o exports/default.mmd
```

Export formats: `yaml`, `json`, `elements-csv`, `relationships-csv`, `xlsx` (web/API only; binary), `mermaid`, `archimate` (Open Exchange 3.1, opens in Archi), `cypher` (a re-runnable `MERGE` script). `--as-of`, `--scenario` and `--scope <ids> --depth <n>` narrow what is exported.

`samples/ubs-banking.yaml` is **illustrative**. Its legal entity and divisions follow UBS's public reporting structure, but all systems, data stores, processes, decisions and plans are invented.

## Developing with Node locally (optional)

For the web app, the quickest loop is `deploy/dev.sh web` (Vite with hot reload on :5173, using the API and Keycloak in containers), then `deploy/test.sh web --local` and `test.sh e2e --web-local`; after committing, `deploy/dev-deploy.sh web` updates the container. See the developer guide, §3.

For everything else: Node.js 24 and pnpm 9 (`corepack enable`). `deploy/dev.sh api|worker|renderer` run the services on local Node with the settings from `deploy/env/host.env`; `deploy/test.sh <suite> --local` runs tests there.

```bash
pnpm install && pnpm build && deploy/test.sh unit --local
```

Local consoles:

| Service | URL |
|---|---|
| Neo4j Browser | http://localhost:7474 (neo4j / d4-local-dev) |
| Keycloak | http://localhost:8080 (admin / d4-local-dev) |
| S3 API (mocks/s3) | http://localhost:8333 (access key d4 / d4-local-dev) |
| Grafana | http://localhost:3001 (admin / d4-local-dev) |

All of these are local development credentials only.
