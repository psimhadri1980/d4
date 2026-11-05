# D4 — Design-to-Delivery Graph Platform

Capture, decide, plan, develop and deliver design elements as a connected graph. Users can then visualise, query (through a curated Cypher Query Catalog) and export roadmaps and dependencies.

Stack: TypeScript end to end, Neo4j 5 Community (one instance per tenant), PostgreSQL control plane, Redis, S3, Keycloak.

For how to use the product see the **[User Manual](user-manual/README.md)**. For low-level details (architecture, request flows, recipes, testing, pitfalls) see **[docs/DEVELOPER_GUIDE.md](docs/DEVELOPER_GUIDE.md)**.

## Layout

Every component (app, web module, service, tool, infra) has a `component.yaml` beside it: how it builds, runs, is checked and tested (see [run/README.md](run/README.md)).

```
apps/api              NestJS API: OIDC auth, workspace access, REST commands + GraphQL reads
apps/worker           Background jobs from the Redis queue: exports, imports, schedules, syncs, webhooks, backups
apps/renderer         Renders roadmaps and graphs to PNG/PDF with headless Chromium (render queue)
apps/web              The web shell: sign-in, layout, menu, search, the module loader
apps/web-<name>       The six lifecycle web modules: explore, queries, plan, data, reporting, admin
apps/web-hello        A plain JavaScript module (contract example)
apps/ui-modules       The image that serves the web modules under /mfe/<name>/
apps/ops              d4-ops: migrations and seed, Neo4j schema, tenants, quotas (run as hooks and ops:exec)
apps/e2e              Playwright browser tests through the gateway
packages/metamodel    Metamodel schema, validator, registry, starter.yaml, industry packs
packages/core         Domain model: elements, relationships, lifecycle, rules, ModelService
packages/cypher       Schema DDL from the metamodel, Query Catalog checks, system query packs
packages/db           Postgres control plane: Drizzle schema, migrations, stores, local seed
packages/graph        Neo4j adapter: ModelRepository, read queries, catalog runner
packages/codecs       Model-as-code documents, CSV/Excel import, export formats (CSV, Excel, Mermaid, ArchiMate, Cypher)
packages/render       SVG pictures: roadmap Gantt and graph neighbourhood (shared with the web chart)
packages/connectors   Connector framework: record mapping, HTTP/JSON and Git sources, sync planning
packages/infra        Adapters: job queue, S3 artefacts, mailer, tenant graph routing and provisioning, usage and quotas
packages/jobs         Job handlers shared by api, worker and renderer
packages/runtime      Process plumbing for every service: JSON logs (pino), tracing, the queue service loop
packages/config       Settings for every service: zod fragments, NAME_FILE secrets, derived URLs
packages/sdk          Typed REST client generated from the OpenAPI document (see its README)
packages/web-platform What every web module shares: sign-in, API client, the module contract (see its README)
packages/ui-kit       Shared React components and design tokens (see its README)
packages/cli          `d4` command line: validate, import, export, workspaces
mocks/                Sources of the development S3 and SMTP mocks (run as infra/s3, infra/smtp)
infra/                One folder per infra component (see infra/README.md)
run/                  run.sh, its orchestrator, shared settings, the component.yaml schema (see run/README.md)
host.conf             The one browser-facing entry point (scheme, host, port, bind address)
samples/              Example models, e.g. ubs-banking.yaml (illustrative)
docs/                 PLAN.md (decision log), ADRs, the developer guide, the run.sh cheat sheet
user-manual/          How to use D4, with screenshots
```

## Initial setup

One-time, on a Linux machine (or a Podman machine on macOS/Windows) with about 4 GB of free memory.

1. **Install the prerequisites:** rootless Podman 4.4 or later, git, and Node.js 24 (`.node-version`). With nvm: `nvm install 24`. `run.sh` uses nvm's Node 24 even when your shell's default differs. You don't need pnpm, corepack, compose or a Podman socket: `run.sh` installs the pinned pnpm into `run/.run/tools` itself.
2. **Clone the repository:**
   ```bash
   git clone https://github.com/psimhadri1980/d4.git && cd d4
   ```
3. **Optional, behind a corporate network:** create `run/env/local.env` (git-ignored). Overrides there win over the shared files.
   ```bash
   # npm mirror for every install (flat KEY=value lines; comments on their own lines)
   NPM_REGISTRY=https://your-registry.example.com/npm/
   # your internal CA, trusted by builds, services, Keycloak and the renderer
   ORG_CA_FILE=/etc/pki/org/ca-bundle.crt
   ```
   For HTTPS at the gateway, set `GATEWAY_TLS_CERT_FILE` and `GATEWAY_TLS_KEY_FILE` the same way (see [run/certs/README.md](run/certs/README.md)).
4. **Optional, another address:** the browser-facing origin is in [`host.conf`](host.conf), by default `http://localhost:5173`. Change `D4_HOST`, `D4_PORT` or `D4_BIND` (`0.0.0.0` to serve other machines) there or in `local.env`.
5. **Check the machine:**
   ```bash
   run/run.sh doctor
   ```
   It checks Podman, Node 24, cgroup delegation (for memory and CPU limits), every `component.yaml`, and that D4's ports are free. Warnings about limits can be ignored on a laptop. The first run of any `run.sh` command installs the workspace dependencies.
6. **Build and start everything:**
   ```bash
   run/run.sh podman:stack:deploy
   ```
   The first run pulls the base images and builds every image, which takes a few minutes. After that, only what changed is rebuilt (a no-change run takes about 20 s). It starts every component in dependency order, waits until each is healthy, and runs the database migrations, local seed and graph schema (see [Databases](#databases-initialization-seed-and-migrations)).
7. **Load the sample model:**
   ```bash
   run/run.sh cli:exec -- import samples/ubs-banking.yaml -w default
   ```
8. **Open http://localhost:5173** and sign in as `dev-admin`, password `d4-local-dev` (other users: `dev-viewer`, `dev-author`, `dev-steward`; local only).
9. **Confirm everything is running:**
   ```bash
   run/run.sh status
   run/run.sh stack:test smoke
   ```
   `status` should show every component as `healthy`. `stack:test smoke` checks health, a sign-in and `/api/v1/me`.

**After a reboot:** rootless Podman brings containers back only when the user service is enabled: run `systemctl --user enable --now podman-restart.service` once (`doctor` warns when it isn't). Otherwise run `run/run.sh podman:stack:start` after booting. Tools start what they need themselves: `ops:exec` starts Postgres and Neo4j, `cli:exec` starts the API, and their dependencies.

If a step fails, it prints the failing command, its output and a hint; the full logs are in `run/.run/logs/`. Rerunning is safe: `deploy` continues from where things are. Moving from the old `deploy/` scripts: the first `podman:stack:deploy` replaces the old compose containers and keeps their data volumes.

### Databases: initialization, seed and migrations

No separate init step is needed. `deploy` and `start` take care of it through the hooks in `infra/postgres/component.yaml` and `infra/neo4j/component.yaml`:

| When | What runs | What it does |
|---|---|---|
| Postgres first starts on an empty volume (`d4_pg-data`) | the `postgres` image | Creates database `d4` and user `d4` (`POSTGRES_*` in `run/env`). |
| Postgres is healthy | hook `ops seed` | 1. Applies every pending migration in `packages/db/drizzle/` (`0000_init.sql`, …), each exactly once, in order. 2. Runs the idempotent local seed: tenant `t_local` and its graph (`bolt://neo4j:7687`), the starter metamodel (active), the `default` workspace, the web module registry. |
| Neo4j is healthy | hook `ops schema t_local` | Creates the graph constraints and indexes for the starter metamodel and every metamodel a workspace uses. |

The hooks run again whenever Postgres or Neo4j is (re)started, and whenever the `ops` image changes, for example after pulling a new migration. So after `git pull`, `run/run.sh podman:stack:deploy` applies new migrations by itself. To run them by hand:

```bash
run/run.sh ops:exec -- migrate          # pending migrations only
run/run.sh ops:exec -- seed             # migrations, then the local seed (safe to repeat)
run/run.sh ops:exec -- schema t_local   # graph constraints and indexes for a tenant
```

**Adding a migration:**
1. Change `packages/db/src/schema.ts`.
2. Generate the SQL with `npx pnpm@9.12.0 --filter @d4/db run generate`. It writes the next `packages/db/drizzle/NNNN_*.sql`; review it and commit it with the schema change.
3. Apply it with `run/run.sh podman:stack:deploy`, which rebuilds the `ops` image, so the hook runs.
4. Test it with `run/run.sh stack:test integration`. Integration tests create and drop their own throwaway databases.

**Data lifetime:** data lives in named volumes (`d4_pg-data`, `d4_neo4j-data`, `d4_redis-data`, `d4_s3-mock-data`, and `d4-neo4j-<tenant>-data` for extra tenants). It survives `stop`, `deploy` and image rebuilds.
- `run/run.sh podman:postgres:reset --yes` deletes the Postgres data; the next `deploy` recreates it, migrates and seeds.
- `run/run.sh stack:reset --yes` deletes everything.

**Moving data from the old `deploy/` setup:** the volumes have the same names, so the first `podman:stack:deploy` picks up the existing data. It also removes the old `d4-*-1` containers. Copy over what was git-ignored, then recreate any extra tenant graphs:

```bash
cp deploy/env/local.env run/env/local.env 2>/dev/null; cp deploy/secrets/neo4j-* run/secrets/ 2>/dev/null
run/run.sh ops:exec -- tenant create t_acme "Acme Ltd"   # per extra tenant: reuses volume d4-neo4j-t_acme-data
```

## Local stack

Day to day ([docs/run-cheatsheet.pdf](docs/run-cheatsheet.pdf) lists every command on one page). Every component (app, web module, service, tool, infra) has a `component.yaml` next to it; shared settings are in `run/env/`, the entry point in `host.conf`.

```bash
run/run.sh podman:stack:deploy        # build what changed, start everything in dependency order, wait until healthy
run/run.sh status                     # where each component runs (podman or local), health, route, image
run/run.sh local:api:deploy           # move one component to local Node (hot reload) behind the same gateway
run/run.sh podman:api:deploy          # and back
run/run.sh api:test                   # unit tests of what changed in the API's packages (integration, static, e2e, smoke)
run/run.sh stack:test e2e             # Playwright browser tests through the gateway (report: apps/e2e/results/report)
run/run.sh podman:observability:deploy   # OTel collector, Tempo, Prometheus, Grafana
run/run.sh stack:stop | stack:reset   # reset also deletes all volumes
run/run.sh help                       # the grammar: [<runtime>:]<component>:<command>
```

| Component | Purpose | Memory cap |
|---|---|---|
| neo4j 5.26 Community + APOC | Tenant graph (`t_local`) | 1.4 GB |
| postgres 16 | Control plane (tenants, events) | 256 MB |
| redis 7 | Queue / cache | 128 MB |
| s3 (mocks/s3, file-backed) | S3 API on :8333, buckets `d4-exports`, `d4-attachments`, `d4-backups` | 256 MB |
| keycloak 25 | OIDC realm `d4`, roles, dev users (at `/auth`) | 768 MB |
| gateway (nginx, always Podman) | The one browser-facing origin from `host.conf` (http://localhost:5173): web `/`, API `/api`, Keycloak `/auth`, modules `/mfe/`, inbox `/mail/`; every component behind it at 127.0.0.1:<port> on the host network, in Podman or on local Node | 64 MB |
| ops (hooks) | After postgres and neo4j start: migrations + local seed, Neo4j schema | — |
| api | D4 API at http://localhost:5173/api | 384 MB |
| web | The D4 shell on http://localhost:5173 (nginx, static build): sign-in, layout, menu, module loader | 64 MB |
| web-modules | The six web modules (explore, queries, plan, data, reporting, admin) under `/mfe/<name>/`; uploaded releases are served from S3 under `/mfe/_r/` | 64 MB |
| otel-collector, tempo, prometheus, grafana (`/grafana/`) | Observability profile (optional) | ~1 GB |

## Web app

Open http://localhost:5173 and sign in with one of the local dev users (password `d4-local-dev` for all; local only):

| User | Roles | Use it to |
|---|---|---|
| `dev-admin` | admin, query-author, query-steward | Everything |
| `dev-viewer` | viewer | Browse and run granted catalog queries (read-only) |
| `dev-author` | query-author, viewer | Write catalog queries in the Query Studio and submit them |
| `dev-steward` | query-steward, viewer | Review, publish, grant and deprecate catalog queries |

Run `run/run.sh cli:exec -- import samples/ubs-banking.yaml -w default` first to get something to explore. Every screen, feature and end-to-end journey is described, with screenshots, in the **[User Manual](user-manual/README.md)**.

### Look and feel

The UI follows IBM Carbon design principles: a dark shell header, layered greys, field-style inputs, contained tabs, and an accessible palette for metamodel layers. The header has a **Theme** picker (System, Light, Dark); the choice is remembered per browser.

Typography uses **Source Sans 3** (SIL Open Font License) as an open stand-in for the licensed UBS brand typeface, and IBM Plex Mono for Cypher. Both are bundled from npm, so nothing loads from external font services. To use the licensed font, add it with `@font-face` (e.g. in `apps/web/src/fonts.css`) and put its family first in `--font-sans` in `apps/web/src/styles.css`.

### Browser tests

`run/run.sh stack:test e2e` runs the Playwright suite (`<component>:test e2e` only the specs covering that component) in Chromium against the live stack:
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

Setup imports the sample if it's missing. Everything a run creates is prefixed `e2erun…` and deleted afterwards. Extra arguments go to Playwright, e.g. `run/run.sh stack:test e2e -- --grep relationships`. Failures keep a trace and screenshot in `apps/e2e/results/`.

The stack needs about 3.3 GB, and the browser tests add about 1 GB. Rootless Podman runs containers directly on the host, so keep about 4–5 GB free.

## API

| Interface | Where | Use |
|---|---|---|
| REST | `/v1/...`, OpenAPI at http://localhost:5173/api/v1/openapi.json | Create, update and delete elements and relationships; list, search, neighbourhood, history; `GET /v1/workspaces/{ws}/roadmap?scope=<ids>&lanes=initiative|division|status|type|milestone|none` for a scheduled roadmap; `asOf` and `scenario` on reads; `GET /v1/workspaces/{ws}/diff?fromAsOf=&fromScenario=&toAsOf=&toScenario=`; `GET /v1/workspaces/{ws}/matrix/{crud|capability-application|data-store-roles|lifecycle}` and `/decisions` |
| GraphQL | `POST /api/graphql` | Graph-shaped reads: workspace → elements → connections → … (read-only) |

All endpoints except `/healthz`, `/readyz` and `/v1/openapi.json` need a Keycloak bearer token (`run/run.sh keycloak:exec -- token` prints one; `run/run.sh stack:test smoke` uses it). Writes need the contributor, planner, architect or admin role, either from Keycloak or from a workspace role binding. Updates and deletes take `expectedVersion` (optimistic concurrency).

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
run/run.sh cli:exec -- import samples/ubs-banking.yaml -w default   # the sample into "default"
run/run.sh cli:exec -- validate samples/ubs-banking.yaml           # offline check against the starter metamodel
run/run.sh cli:exec -- import my-model.yaml -w default --dry-run
run/run.sh cli:exec -- export -w default -o exports/default.yaml
run/run.sh cli:exec -- export -w default --format archimate -o exports/default.archimate.xml
run/run.sh cli:exec -- export -w default --format mermaid --as-of 2027-08-01 -o exports/default.mmd
```

Export formats: `yaml`, `json`, `elements-csv`, `relationships-csv`, `xlsx` (web/API only; binary), `mermaid`, `archimate` (Open Exchange 3.1, opens in Archi), `cypher` (a re-runnable `MERGE` script). `--as-of`, `--scenario` and `--scope <ids> --depth <n>` narrow what is exported.

`samples/ubs-banking.yaml` is **illustrative**. Its legal entity and divisions follow UBS's public reporting structure, but all systems, data stores, processes, decisions and plans are invented.

## Developing with Node locally

Any app or web module can run on local Node behind the same gateway, at the same address as its container (`run/run.sh local:web:deploy`, `local:api:deploy`, `local:web-plan:deploy`); the container is stopped first, and `podman:<name>:deploy` moves it back. Tests run on local Node by default and only for what changed. See the developer guide, §3 and §7.

Local consoles:

| Service | URL |
|---|---|
| Neo4j Browser | http://localhost:7474 (neo4j / d4-local-dev) |
| Keycloak | http://localhost:5173/auth (admin / d4-local-dev) |
| Mail inbox (mocks/smtp) | http://localhost:5173/mail/ |
| S3 API (mocks/s3) | http://localhost:8333 (access key d4 / d4-local-dev) |
| Grafana | http://localhost:5173/grafana/ (admin / d4-local-dev; `podman:observability:deploy`) |

All of these are local development credentials only.
