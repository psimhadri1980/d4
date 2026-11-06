# D4 Developer Guide

Low-level reference for working in this repository: where things live, how a request flows, how to make common changes, how to test, and the pitfalls already hit.

Related documents:
- [`PLAN.md`](PLAN.md): product plan, decision log (D1–D30) and status.
- [`adr/`](adr): architecture decisions.
- [`../README.md`](../README.md): quick start.
- [`../user-manual/`](../user-manual/README.md): end-user documentation with screenshots.

---

## 1. Ground rules

These are non-negotiable unless the decision log is changed first.

| # | Rule | Where it is enforced |
|---|---|---|
| 1 | **One Neo4j Community instance per tenant.** Only `TenantGraphService` opens graph connections, routed by the signed `tenant` token claim. | `apps/api/src/infra/tenant-graph.service.ts`, ADR 0001 |
| 2 | **Users never send Cypher.** They run published Query Catalog versions; only `query-author` writes Cypher, only `query-steward` publishes. | `apps/api/src/catalog/*`, ADR 0002 |
| 3 | **Every model write is a command** (`ModelService` or `planImport`) producing a `ChangeSet` of new state plus domain events, applied in one unit of work with the event log. | `packages/core`, `packages/graph/src/repository.ts`, ADR 0004 |
| 4 | **Optimistic concurrency everywhere:** updates and deletes carry `expectedVersion`; the graph write matches `version = expected - 1`. | `ModelService`, `Neo4jModelRepository` |
| 5 | **Soft delete only** for model data (`deleted = true`); the event log is append-only (DB trigger). | migration 0001 |
| 6 | **Published query versions are immutable** (DB trigger) and are verified by a canonical-JSON SHA-256 fingerprint before publishing and before every run. | migration 0003, `contentHash` |
| 7 | **The metamodel is the source of truth** for types, attributes, allowed connections and rules, on both server and browser. Never hard-code type lists. | `packages/metamodel` |
| 8 | **One entry point, two runtimes.** Everything is built, run and tested with `run/run.sh <runtime>:<component>:<command>`; each component's contract is its `component.yaml`. Podman runs the stack (the gateway always); local Node runs any app or module behind the same gateway for fast iteration. | `run/`, `*/component.yaml`, `run/schema/component.schema.json` |
| 9 | Ids are **ULIDs** (26 chars, Crockford base32). | `packages/core/src/ids.ts` |
| 10 | Cypher identifiers (labels, relationship types) are **never interpolated unchecked**; they pass `ident()` and come from the metamodel. | `packages/graph/src/mapping.ts` |

---

## 2. Repository map

```
apps/
  api/        NestJS (Fastify) API: REST + read-only GraphQL, auth, catalog, jobs
  worker/     Background job worker (BullMQ consumer): exports and spreadsheet imports
  renderer/   Render queue consumer: PNG/PDF via headless Chromium (Playwright image)
  web/        React + Vite SPA shell, served by nginx: sign-in, layout, menu, search, module loader (src/lifecycle.ts); no screens
  web-<name>/ the six web modules (explore, queries, plan, data, reporting, admin), each a lifecycle module of its own (ADR 0008)
  web-hello/  a plain JavaScript lifecycle module (contract example)
  ui-modules/ the image serving the six web modules and web-hello under /mfe/<name>/
  ops/        migrations, seeds, Neo4j schema, tenants and quotas (hooks and ops:exec)
  e2e/        Playwright browser tests (run in a container against the live stack)
packages/
  metamodel/  Metamodel schema (zod), loader, registry; starter.yaml; industry packs in packs/
  core/       IO-free domain: types, ULIDs, lifecycle, validity, ModelService, rules,
              planImport, validateModel, InMemoryModelRepository
  cypher/     Schema DDL, catalog checks (params, static checks, EXPLAIN contract,
              content hash), system query packs (packs/system/*.yaml)
  graph/      Neo4j adapter: Neo4jModelRepository, GraphQueries, EXPLAIN explainer,
              catalog runner
  db/         Postgres control plane: Drizzle schema, migrations, stores, local seed
  codecs/     Model-as-code documents (d4/v1), CSV/Excel tables and mappings, export
              formats (CSV, Excel, Mermaid, ArchiMate, Cypher)
  render/     SVG pictures (Gantt geometry shared with web, radial graph layout, page wrapper)
  jobs/       Shared by api and worker: tenant graph routing, model handles, export and
              tabular-import work, S3 artefact store, BullMQ queue, processJob
  cli/        `d4` command: validate, workspaces, import, export
  sdk/        typed REST client generated from the OpenAPI document (`openapi.json` + `src/schema.ts` are generated)
  connectors/ connector framework: record mapping, HTTP/JSON and Git sources, sync planning
  config/     environment settings for every service: zod fragments, NAME_FILE secrets, derived URLs
  ui-kit/     React components shared by the web app and embedders (Gantt, CytoscapeGraph, ResultTable, element list and details, forms, view bar), styles.css, base.css (tokens, element defaults) and app.css (controls, panes, lists, forms, shared component styles)
  web-platform/ what every web module shares: sign-in, typed API client, query keys, current user and view, the lifecycle contract (`lifecycleProblems`), `ModuleRoot`, and `/shared` (the shared-package list for build configs)
  infra/      tenant graphs, queue, S3 artefact store, mail, usage (api, worker, renderer, ops)
  runtime/    process start-up for the backend apps: telemetry, queue service
samples/      ubs-banking.yaml, credit-graph.yaml (illustrative sample models; the second needs the d4-credit-graph pack and goes in a workspace of its own)
infra/        one folder per infra component (component.yaml + its config): gateway (nginx, one origin),
              postgres, neo4j, redis, s3, smtp, keycloak (realm), otel-collector, tempo, prometheus, grafana
run/          run.sh and its orchestrator, the component.yaml schema, shared settings (env/),
              certs/ and secrets/ (git-ignored), .run/ (state and logs, git-ignored)
host.conf     the one browser-facing entry point (scheme, host, port, bind address)
mocks/        sources of the development-only S3 (file-backed, S3 REST + SigV4) and SMTP (Mailpit-compatible inbox API)
docs/         PLAN.md, ADRs, this guide
```

### Package dependency graph

```
metamodel ◄── core ◄── codecs ◄── cli
    ▲          ▲  ▲
    │          │  └──────────── db (uses ulid, DomainEvent)
  cypher ◄── graph (+ core, metamodel)
    ▲          ▲
    │          ▲
    │        jobs ── db, codecs, core, metamodel (+ bullmq, S3 client, neo4j-driver)
    │          ▲
    └──── api ─┴── worker, renderer (jobs, db, infra, runtime)
sdk ◄── web-platform ◄── ui-kit ◄── web (shell), web-<module>
web-<module> ──► core, metamodel, codecs (bundled into the module)
web-platform, ui-kit, react, react-router-dom, react-query: shared from the shell's import map
```

- **Module format:** all packages except `web` and `e2e` are **CommonJS** TypeScript (`tsconfig.base.json` uses `NodeNext`), and import each other through `dist/`. Turbo builds dependencies first (`dependsOn: ["^build"]`). The packages the browser uses (`core`, `metamodel`, `render`, `ui-kit`, `sdk`, `codecs`, `web-platform`) also build an ESM copy with tsup (`dist/*.mjs`), exported under the `browser` condition; Vite picks it, Node and vitest keep the CommonJS files.
- **Browser use of `@d4/metamodel`:** its `browser` entry (`src/browser.ts`) leaves out the file loaders in `load.ts` and `packs.ts`. Importing one of them from web code builds a bundle that fails with "is not exported by \"__vite-browser-external\"".

### Key files by concern

| Concern | File |
|---|---|
| Metamodel schema and rules | `packages/metamodel/src/schema.ts`, `load.ts` (reserved names, reference checks), `registry.ts` |
| Starter metamodel | `packages/metamodel/starter.yaml` (bump `version` on change) |
| Lifecycle transitions | `packages/core/src/lifecycle.ts` |
| Commands | `packages/core/src/model-service.ts` |
| Rules (uniqueness, acyclic) | `packages/core/src/rules.ts`, `validate-model.ts` |
| Import planner | `packages/core/src/import.ts` |
| Neo4j DDL | `packages/cypher/src/schema.ts` |
| Catalog param defs / binding | `packages/cypher/src/params.ts` |
| Catalog static checks, hash | `packages/cypher/src/checks.ts` |
| System pack loader | `packages/cypher/src/packs.ts` |
| Graph writes and reads | `packages/graph/src/repository.ts`, `queries.ts`, `mapping.ts` |
| Catalog runner (owner-written) | `packages/graph/src/catalog-runner.ts` |
| Postgres schema | `packages/db/src/schema.ts`; migrations in `packages/db/drizzle/` |
| Control-plane stores | `packages/db/src/stores.ts`, `catalog.ts` |
| API wiring | `apps/api/src/app.module.ts` imports one module per feature: `infra` (global: settings, pool, stores, graphs, queues), `auth`, `workspaces` (global: access, model handles), `model`, `catalog`, `jobs`, `integrations`, `admin`; `app.setup.ts` (GraphQL plugin) |
| Auth | `apps/api/src/auth/identity.ts`, `auth.service.ts`, `auth.guard.ts` |
| Workspace access | `apps/api/src/workspaces/workspace-access.service.ts`; `@Workspace('read'\|'write'\|'review')` (`workspace.decorator.ts`) in handlers; `@Roles('admin')` (`auth/auth.guard.ts`) |
| Error → HTTP mapping | `apps/api/src/http/errors.ts` |
| Request schemas + OpenAPI | `apps/api/src/model/model.schemas.ts`, `http/zod.ts` (z, ErrorSchema), `http/zod.pipe.ts` (`@ValidBody`, `@ValidQuery`); paths per feature in `<feature>/<feature>.openapi.ts`; every feature (Nest module and its paths) is one entry in `apps/api/src/features.ts`, read by `app.module.ts` and `http/openapi.ts` |
| Catalog API | `apps/api/src/catalog/*` |
| Web modules and routes | `apps/web-<name>/src/index.tsx` (manifest: menu, owned `paths`, `home`; routes under `/w/:ws`; lifecycles); the shell loads them from the registry (`apps/web/src/lifecycle.ts`), routes every workspace page through `components/ModuleOutlet.tsx` and builds the menu in `nav.tsx` (icon names in `ICONS`) |
| Web API client | `packages/web-platform/src/api.ts` (shared calls over the typed `@d4/sdk` client), `apps/web-<name>/src/api.ts` (a module's own calls) |
| Design tokens / themes | `packages/ui-kit/base.css` (tokens, element defaults) and `app.css` (controls and shared components), `apps/web/src/shell.css`, each module's `<module>.css`; `apps/web/src/theme.ts` |

---

## 3. Running locally

**Prerequisites:** Podman 4.4+ (rootless) and Node 24 (`.node-version`; `run.sh` picks it from nvm when the shell's node differs). About 4 GB of free memory for the stack. `run/run.sh doctor` checks the setup. No Podman networks, no compose and no host names inside the stack are needed.

Everything goes through one command (D78); [`docs/run-cheatsheet.pdf`](run-cheatsheet.pdf) (source `run-cheatsheet.html`) lists every combination on one page:

```
run/run.sh [<runtime>:]<component>:<command> [args] [--verbose] [--yes]
run/run.sh ls | status | doctor | help [component]
```

- **runtime:** `local` (a process on local Node) or `podman` (a container). Optional: each component has a default (`ls` marks it). Infra and the gateway only run on `podman`; a selection that includes them uses Podman for those and says so.
- **component:** a name (`api`, `web-plan`, `postgres`), a category (`ui`, `service`, `infra`, `tool`), a group (`observability`), `stack` (everything except tools and optional components) or a list (`api,worker`).
- **command:** `build`, `deploy`, `start`, `stop`, `reset`, `status`, `logs`, `test`, `exec`, `shell`.

| Command | What it does |
|---|---|
| `build` | Compiles the selected packages in one turbo run (shared cache: only changed packages rebuild), then for `podman` packages a thin image per component, tagged with a hash of its inputs. An unchanged component is not repackaged or rebuilt (a no-change build of the whole stack takes about 3 s). |
| `deploy` | `build`, then for each component in dependency order: stop it on the other runtime if it runs there, start it here, wait until healthy, run its hooks. Dependencies and the gateway that are not running are started too (not rebuilt). A container is recreated only when its image or settings changed. |
| `start` / `stop` | Start without building (only what was never built is built) / stop, in reverse dependency order, wherever it runs (or only on the runtime given). |
| `reset` | Stop, then delete the container **and its volumes** (podman) or its `dist/` (local); asks first unless `--yes`. `stack:reset` also removes every `localhost/d4-*` image and `run/.run` state. |
| `status` | One row per component: where it runs (`podman`, `local`, or a red `conflict` when both), state, live health, route, address, image hash (`stale` when the source changed since), uptime. Exits non-zero on a conflict, an `orphan` (pid file without a process) or an unhealthy component; `--json` for scripts. |
| `logs` | Follows the output (`-n N`, `--no-follow`): `podman logs`, or `run/.run/logs/<name>.local.log`. |
| `test` | `unit` (default), `integration`, `static`, `e2e` or `smoke`; see [Testing](#7-testing). |
| `exec -- <cmd>` | Runs a command in the running component (its container, or on the host with its settings); for tools (`cli`, `ops`, `e2e`) runs the tool once. |
| `shell` | A shell in the container, or on the host with the component's settings loaded. |

Common ones:

| Command | |
|---|---|
| `run/run.sh podman:stack:deploy` | The whole stack in Podman (first run builds every image, a few minutes; afterwards only what changed). |
| `run/run.sh local:api:deploy` | The API on local Node (tsx watch) behind the gateway; the API container is stopped first. `podman:api:deploy` moves it back. |
| `run/run.sh local:web:deploy` | The shell with Vite hot reload behind the gateway (HMR through `D4_PORT`). |
| `run/run.sh local:web-plan:deploy` | One web module rebuilt on every change and served under `/mfe/plan/` while it runs; the gateway falls back to the module image when it stops. No `localStorage` override is needed. |
| `run/run.sh podman:observability:deploy` | OTel collector, Tempo, Prometheus and Grafana (`/grafana/`); set `D4_OTEL_ENDPOINT=http://127.0.0.1:4318` in `run/env/local.env` to trace the services. |
| `run/run.sh keycloak:exec -- token [user]` | An access token (default `dev-admin`). |
| `run/run.sh keycloak:exec -- tenant-user t_acme acme-admin [role …]` | Local Keycloak user for a tenant (password `DEV_USER_PASSWORD`, default role admin). |
| `run/run.sh ops:exec -- tenant create t_acme "Acme Ltd"` | A tenant with its own Neo4j container `d4-neo4j-t_acme` on the host network (bolt 127.0.0.1:7701+, password in `run/secrets/`), registered, schema applied, seeded. `tenant remove t_acme` stops it (the volume stays). Other `d4-ops` commands pass through: `tenant list`, `quota <tenant> [metric=value …]`, `seed`, `schema <tenant>`. |
| `run/run.sh cli:exec -- import samples/ubs-banking.yaml -w default` | The `d4` CLI, signed in as `dev-admin`; paths relative to the repository root. |
| `run/run.sh web-<name>:exec -- publish <version> [--activate] [--keep N]` | Upload the module's `dist/` as an immutable release, activate it, delete inactive versions beyond the newest N (D70); `--dist -` with an older version rolls back. |

**Output:** every step prints what it does and the command it runs, with a heartbeat every 10 s on long steps; image builds show their `STEP` lines, health waits their progress. A failure prints the failing command, its exit code, the last 40 lines of its output, the log file and a hint. Logs: `run/.run/logs/` (`run.log` for the session, one file per build, image and component). `--verbose` streams every subprocess's output.

**Gateway:** always a Podman container, the only browser-facing port, one origin set in `host.conf` (`D4_SCHEME`, `D4_HOST`, `D4_PORT`, `D4_TLS_PORT`, `D4_BIND`); every URL is derived from it (`D4_PUBLIC_URL`, the API at `/api`, `OIDC_ISSUER`, Keycloak's redirect URIs, Grafana's root URL). The web app at `/`, the API at `/api` (prefix stripped, so the API keeps `/v1/...`, `/graphql`, `/healthz`), Keycloak at `/auth`, web modules at `/mfe/<name>/`, module releases at `/mfe/_r/`, and in development the mail inbox at `/mail/` and Grafana at `/grafana/`. No CORS. It adds a baseline CSP header (not under `/auth` or `/grafana`) and timeouts, and serves HTTPS on `D4_TLS_PORT` when `run/certs/gateway.crt` and `gateway.key` exist.

**Host network:** every container runs with `--network host` and every component listens on `127.0.0.1:<port>` (its `ports` in `component.yaml`), the **same address on both runtimes**. So the gateway's upstreams never change: moving a component between runtimes is stop on one, start on the other. Nothing uses service names, `host.containers.internal` or Podman networks (some target environments allow none). Containers are named `d4-<name>` and labelled `d4.component`, `d4.hash`.

**Health checks:** some Podman setups never run health checks on their own, so `run.sh` runs `podman healthcheck run d4-<name>` every 5 s after starting a container until it passes (local processes: an HTTP probe every 2 s), and starts dependents only then. A container that exits while starting fails the run at once with its last log lines. `status` runs the checks live (reusing a result under 30 s old).

**Hooks:** `postgres` runs `ops seed` (migrations and the local seed) after it starts, `neo4j` runs `ops schema t_local`. They run again whenever their component restarts or the `ops` image changes, so a new migration is applied by the next deploy.

**Moving from the old setup:** the first `podman:stack:deploy` removes the containers of the old compose project (`d4-<service>-1`) and the `d4` network; the named volumes (`d4_pg-data`, `d4_neo4j-data`, …) are reused, so data is kept. Tenant graphs created by the old scripts must be recreated with `ops:exec -- tenant create` (their volumes are kept).

### Components (`component.yaml`)

Each component carries its own contract next to its code: `apps/<name>/component.yaml` (ui, services, tools), `packages/cli/component.yaml`, `infra/<name>/component.yaml` (with its config files: Keycloak realm, gateway templates, OTel configs). The schema is `run/schema/component.schema.json` (editors validate against it through the `yaml-language-server` comment); `run/orchestrator/components.ts` enforces the same rules on every run and in CI. The main keys:

| Key | Meaning |
|---|---|
| `name`, `category`, `description`, `group`, `optional` | Identity and how selectors pick it (`optional`: not in `stack`). |
| `source` | The workspace package (`@d4/api`); turbo builds it and its dependencies. |
| `dependsOn` | Started first; their `provides` flow into this component's settings. |
| `ports` | `127.0.0.1` ports, the same on both runtimes; unique across components (checked). The first (or `health.port`) is its address, `PORT_<NAME>` in interpolation. |
| `health` | `http` (path; probed locally, `wget` in the container), or `cmd` (a shell command in the container), `timeout` in seconds. |
| `route` | Its path behind the gateway (shown by `status`). |
| `provides` / `env` | `common`, `local`, `podman` maps; values interpolate `${VAR}`, `${VAR:-default}`, `${VAR:?message}`. |
| `runtimes.local` | `command` (run from the repository root, detached) and `build: deps` (default: compile dependencies; the dev server compiles the package) or `full`. |
| `runtimes.podman` | `image` (published, pinned in `images.env`), `build` (`containerfile`, `artifact`: `node` = `pnpm deploy --prod`, `static` = `dist/`, `modules`, `files`, `none`), or `via` (served by another component's container: the web modules by `ui-modules`); plus `command`, `readOnly`, `tmpfs`, `mounts`, `volumes`, `memory`, `cpus`, `shm`, `restart`. |
| `hooks.postStart` | Tools run after it is healthy (`{ component: ops, args: [seed] }`). |
| `test` | `integration.needs` (the services its integration tests need) and `e2e` (the browser specs covering it). |

**Images are thin:** `run.sh` compiles on the host and stages a build context with `app/` (the artifact), `component/` (the component folder without sources) and `certs/` (the organization CA, never keys). The Containerfile only copies them onto the pinned base image, so rebuilding an image takes seconds and only happens when its input hash changes (the turbo hash of its packages, its folder, its build files, the CA and the base images).

### Settings

Shared settings live in `run/env` and `host.conf`; everything specific to a component lives in its `component.yaml`. `run.sh` merges them into `run/.run/env/<runtime>/<component>.env`, the one file both `podman run --env-file` and local processes read, in this order (later wins): `run/env/common.env` (ids, flags), `images.env` (every base and service image, pinned), `host.conf` (and the URLs derived from it), what the component's dependencies `provide` (addresses such as `POSTGRES_HOST`, `REDIS_URL`, `NEO4J_HOSTS`), the component's own `env`, `dev-secrets.env` (local credentials only), then your git-ignored `run/env/local.env`. Infra components get only their own `env` (interpolated from all of the above). A variable set in your shell wins, e.g. `WEBHOOK_INTERVAL_MS=2000 run/run.sh local:worker:deploy`. `D4_PROFILE=prod` uses `run/env/prod.env` instead of the development secrets. Services parse settings with `@d4/config`; `D4_ENV` defaults to `production`, which refuses the dev password. To add a setting: add it to a fragment in `packages/config` (or the app's `config.ts`), put the shared value in `run/env/common.env` or the component's value in its `component.yaml` (secrets in `dev-secrets.env`), and never default a secret in code.

### Ports

All on `127.0.0.1` (host network), the same whether the component runs in Podman or on local Node; `run/run.sh ls` lists them.

| Port | Component |
|---|---|
| 5173 / 5443 | gateway (`D4_PORT` / `D4_TLS_PORT` in `host.conf`), the only browser-facing port |
| 3000 | api |
| 3002 / 3003 | worker / renderer health (`/healthz` liveness, `/readyz` readiness) |
| 8081 / 8082 | web (nginx or Vite) / ui-modules |
| 8091–8096 | web-explore, web-queries, web-plan, web-data, web-reporting, web-admin on local Node |
| 5432 / 6379 / 8333 | postgres / redis / S3 mock |
| 7687 / 7474 | neo4j bolt / http |
| 7701+ (bolt), +100 (http) | tenant Neo4j containers from `ops:exec -- tenant create` |
| 1025 / 8025 | SMTP mock / its inbox (`/mail/`) |
| 8080 / 9000 | keycloak / its management (health) |
| 4317, 4318, 8889 / 3200, 4417, 9095 / 9090 / 3001 | otel-collector / tempo / prometheus / grafana |
| 3199 | the webhook receiver inside the browser tests |

### Local users

The password for all of them is `d4-local-dev`. They exist only in the local realm.

| User | Roles |
|---|---|
| `dev-admin` | admin, query-author, query-steward |
| `dev-viewer` | viewer |
| `dev-author` | query-author, viewer |
| `dev-steward` | query-steward, viewer |

### Development loop

1. `run/run.sh local:<app>:deploy` for what you change (`web`, `api`, `worker`, a `web-<name>`): hot reload behind the same gateway, everything else stays in Podman.
2. Edit. Hot reload covers the package itself; after changing `packages/*`, run `local:<app>:deploy` again (it recompiles the changed packages, and Vite re-bundles with `--force`).
3. `run/run.sh <app>:test` (unit tests of what changed, seconds), `<app>:test integration` when it touches stores or queues, `<app>:test e2e` (only the specs mapped to it).
4. Commit, then `run/run.sh podman:<app>:deploy`: it stops the local process and starts the rebuilt container.

Vite serves the dev build, so React StrictMode runs effects twice. That surfaces bugs the production build hides, such as one-time OIDC callback codes being redeemed twice.

### Browser preview in the Claude desktop app

`.claude/launch.json` has one configuration, `dev`, which attaches to `http://localhost:5173` (the gateway, whatever runs behind it). Start what you need with `run/run.sh` first. Do not let the preview move to another port: sign-in will fail there.

### Changing dependencies

Edit the `package.json`, then update the lockfile on local Node: `npx pnpm@9.12.0 install` (the version pinned in `package.json`). The next `run.sh` command installs from it (`--frozen-lockfile`); a stale lockfile fails the install, not silently at run time.

---

## 4. Data model essentials

### Neo4j (per tenant)

- **Node labels:** every node carries `:Element`, `:<Layer>Layer` (e.g. `:DataLayer`), its type, and all ancestor types (`extends`). Example: `:Element:OrganisationLayer:Division:OrgUnit`.
- **Properties are flat:**
  - system fields: `id, type, workspaceId, version, validFrom, validTo, scenarioId, deleted, createdAt/By, updatedAt/By`
  - plus metamodel attributes (`name`, `lifecycle`, …)
  - attribute names that clash with system fields are rejected (`RESERVED_ATTRIBUTE_NAMES`)
- **Relationships:** `(a)-[r:TYPE]->(b)`, with the same system fields (except `type`) plus attributes. For example, `HOLDS.role` holds MASTER, GOLDEN_COPY, APPROVED_DISTRIBUTOR, REPLICA or CONSUMER_CACHE.
- **Validity:** half-open periods `[validFrom, validTo)`, stored as ISO date strings; `null` means open-ended.
- **Indexes** (from `schemaStatements`):
  - unique `Element.id`
  - `workspaceId`, `(workspaceId, type)`, `lifecycle`, `scenarioId` and `externalKey`
  - per-layer `workspaceId`
  - a per-relationship-type id index
  - full-text `element_search` on name and description
  - **one cross-type full-text index on `r.id`** named `relationship_ids_<hash>`, which makes relationship-by-id lookup a single query

### Postgres (control plane, shared)

| Table | Purpose |
|---|---|
| `tenants`, `tenant_db_instances` | Tenant and its Neo4j location (`bolt_uri`, `secret_ref`) |
| `workspaces` | Pinned to one metamodel version |
| `metamodels` | Versioned documents (`content`, `content_hash`, status) |
| `users`, `groups`, `group_members`, `role_bindings` | JIT users; grants per user or group, tenant-wide or per workspace |
| `events` | Append-only domain event log + outbox (`published_at`) |
| `queries`, `query_versions`, `query_grants`, `query_executions` | Query Catalog |
| `jobs`, `schedules` | Background jobs and report schedules |
| `connectors`, `connector_items` | Source systems synced into a workspace (config, mapping, write-only secret, schedule) and what each sync last wrote per item |
| `graph_backups` | Workspace graph snapshots in object storage: event position, counts, checksum |
| `tenant_quotas`, `usage_daily` | Per-tenant limit overrides (defaults in `@d4/infra` `DEFAULT_LIMITS`) and daily usage readings |
| `change_proposals` | Model changes awaiting review: steps (`operations`), status, author and reviewer |
| `webhooks`, `webhook_deliveries` | Webhook endpoints (with signing secrets) and one row per event sent to each, with retry state |

| Migration | Contents |
|---|---|
| 0000 | init |
| 0001 | event-log guards, role check |
| 0002 | catalog tables |
| 0003 | catalog guards: immutability and lifecycle trigger, one open draft, search index |
| 0004 | `queries.archived_at` |
| 0005 | `jobs` |
| 0006 | `schedules`, `jobs.schedule_id` |
| 0007 | `users.realm_roles`, `schedules.recipients`, `schedules.paused_reason` |
| 0008 | `webhooks`, `webhook_deliveries` |
| 0009 | `change_proposals` |
| 0010 | `tenant_quotas`, `usage_daily`; indexes for per-day job and query-run counts |
| 0011 | `graph_backups`, `workspaces.locked_reason` |
| 0012 | `connectors`, `connector_items` |

---

## 5. How a request flows

### Authentication

1. The SPA gets a Keycloak token (PKCE).
2. The API's `AuthGuard` calls `AuthService.authenticate`, which:
   - verifies the JWT (issuer `OIDC_ISSUER`, keys from `OIDC_JWKS_URI`)
   - takes `tenant` from the token
   - checks the tenant is active
   - provisions the user (`UserStore.upsertFromToken`)
   - merges realm roles with tenant-wide `role_bindings`
   - caches the result for 60 s
3. The guard attaches the result to the request as a `Principal { subject, userId, tenantId, roles }`.

GraphQL authenticates lazily inside resolvers, so auth failures come back as `extensions.code: UNAUTHORIZED`.

### Workspace access

`WorkspaceAccess.resolve(principal, ws, 'read' | 'write' | 'review')` loads the workspace for the principal's tenant, returning 404 for other tenants' ids.
- **Read** needs any role.
- **Write** needs contributor, planner, architect or admin, from token roles or workspace role bindings.
- **Review** (approving or rejecting change proposals) needs architect or admin.

It returns the workspace's `MetamodelRegistry` (cached by metamodel id) and a `CommandContext`.

### Model write path

```
Controller → parse(zod) → WorkspaceAccess.resolve(write) → ModelFactory.for(scope)
  → ModelService.createElement/…  (metamodel + lifecycle + validity + rules)
  → Neo4jModelRepository.apply(ChangeSet)
      → EventSink.withEvents: Postgres tx { insert events; Neo4j executeWrite { version-checked writes } }; commit
```

Imports build one `ChangeSet` with `planImport` (matching by id, then `externalKey`, then type + name) and apply it the same way.

### Catalog run path (`QueryRunService.run`)

The guards run in this order:
1. Workspace read access.
2. Pack installed for the tenant.
3. Entry exists and is not archived.
4. **Grant** to one of the user's roles or groups (stewards bypass).
5. Version is published or deprecated, and `kind = read`.
6. **Fingerprint** matches.
7. Parameters checked and converted (`bindParams`).
8. `runCatalogQuery` with `$workspace` added (READ transaction, timeout, row cap).
9. `query_executions` logged (ok, error or timeout).

Draft **test runs** (`testDraft`) skip the grant and published checks. Instead they require the static checks and Neo4j `EXPLAIN` to pass. They use 100 rows and 10 s, and are not logged.

### Catalog lifecycle (enforced by trigger + service)

`draft → in_review → published → deprecated → retired`. A version in review can go back to draft; a deprecated one can be re-published.
- Authors create, save drafts and submit; submitting re-runs the checks including EXPLAIN.
- Stewards publish or send back. **Nobody can review their own query** except admins.
- Delete removes a never-published entry; otherwise it **archives**. System queries can't be edited or removed.

---

## 6. Recipes

### Add a node or relationship type, or an attribute

1. Edit `packages/metamodel/starter.yaml`:
   - node types: `name` (PascalCase), `layer`, optional `extends`, optional `role` (`contour`, `facet` or `both`: how lens search may use the type; unset means the role of the type it extends, else `both`), and `attributes` (camelCase, not reserved)
   - relationship types: `name` (UPPER_SNAKE), `from`/`to` (types or `*`) and `attributes`
   - enums go under `enums`
2. **Bump `version`.** The local seed registers it and repoints the `default` workspace. Production needs a migration plan.
3. Run `run/run.sh stack:test integration`. `@d4/metamodel` checks references and the reserved names.
4. Run `run/run.sh ops:exec -- schema t_local` (or redeploy `neo4j`: its hook applies the schema). New relationship types change the cross-type id index name; the schema step drops a stale one only when no workspace's metamodel still uses it (`applySchema` drops nothing unless given `keepRelationshipIndexes`).
5. If you added a rule, add a `rules:` entry (`acyclic` or `uniqueValuePerTarget`). Both `assertRelationshipRules` and `validateModel` pick it up automatically.

### Add or change an industry metamodel pack

1. Packs live in `packages/metamodel/packs/*.yaml` with `extends: d4-starter`. They add enums, node types (which may `extends` starter types and so inherit their attributes and relationships), relationship types, `extendRelationships` (more endpoints for starter relationship types) and rules. A pack may never redefine something the starter has; `composePack` refuses it.
2. Register a new pack in `METAMODEL_PACKS` and `PACK_FILES` (`packages/metamodel/src/packs.ts`) and bump its `version` on every change.
3. Admins choose the pack when creating a workspace. The API registers the composed metamodel for the tenant and applies its constraints and indexes to the tenant graph first.

### Add a system catalog query

1. Create `packages/cypher/packs/system/<slug>.yaml`, where the file name equals `slug`. It needs `title`, `description`, `tags`, `resultShape` (table/graph), `defaultRoles`, `params` (see `QueryParamDef`) and `cypher`.
2. The Cypher must:
   - filter by `$workspace`
   - declare every `$param` it uses
   - RETURN something and include a LIMIT
   - use only allow-listed procedures (`ALLOWED_CALLABLES`)
   - include no write or admin clauses
   - avoid reserved words like `end` as aliases
3. Update the slug list in `packages/cypher/test/packs.test.ts`, and add a result test in `packages/graph/test/system-pack.test.ts` against the UBS sample.
4. Update any counts in the API and browser tests (the catalog count is currently 8).
5. It installs into tenants on first catalog use. A changed pack query gets a new published version, and the old one is deprecated.

### Add a REST endpoint

1. Add the zod request schema in the feature's schemas (model: `apps/api/src/model/model.schemas.ts`; import `z` from `http/zod.ts`). In the handler, take it parsed: `@ValidBody(Schema) input: z.output<typeof Schema>` or `@ValidQuery(...)`, and the workspace with `@Workspace('read'|'write'|'review')`.
2. Inject dependencies with **explicit `@Inject(Token)`**; the dev runner emits no decorator metadata.
3. Put access checks and logic in a service. Throw `DomainError` for domain failures and Nest `*Exception`s for HTTP ones; `toErrorResponse` maps both.
4. Register the controller and providers in its feature module (`<feature>/<feature>.module.ts`); stores are injected by class (`infra/stores.ts`).
5. Document the endpoint in the feature's `<feature>.openapi.ts` (helpers in `http/api-doc.ts`), then regenerate the SDK: `pnpm --filter @d4/api build && pnpm --filter @d4/sdk generate`. `apps/api/test/openapi.test.ts` fails when a served route is missing from the document or the SDK's copy is stale.
6. Test it end to end with `apps/api/test/harness.ts` (`startHarness()`), which gives a fresh Postgres database, the real Neo4j and local-signed tokens.

### Add a Postgres table or column

1. Edit `packages/db/src/schema.ts`.
2. Generate the migration in a container:
   ```bash
   podman run --rm -v "$PWD":/src:z docker.io/library/node:24-alpine sh -c 'set -e; corepack enable; corepack prepare pnpm@9.12.0 --activate;
     mkdir /work; cd /src; tar --exclude=node_modules --exclude=.git -cf - . | tar -xf - -C /work;
     cd /work; pnpm install --frozen-lockfile; cd packages/db; pnpm drizzle-kit generate --name <name>;
     cp drizzle/00* /src/packages/db/drizzle/; cp drizzle/meta/* /src/packages/db/drizzle/meta/'
   ```
3. drizzle-kit 0.24 doesn't generate CHECK constraints, triggers or expression indexes. Add them as a `--custom` migration. Index expressions must be **IMMUTABLE**; wrap functions such as `array_to_string`.
4. If the change touches existing local data, check that `db-migrate` still works on the current volume.

### Add a web screen or component

- Use the existing class names and the tokens in `@d4/ui-kit/base.css`. Define colours as tokens with light and dark values, never as literals in components. A screen's own styles go in its module's `<module>.css`; a class used by more than one module, or by a ui-kit component, goes in `app.css`.
- Use `useRegistry(ws)` for metamodel-driven UI. Call the API through `@d4/web-platform` (`api` for calls several modules make, `d4()` for the typed client) or the module's own `api.ts`; a field the typed client lacks means the API's OpenAPI document is incomplete, so fix the `<feature>.openapi.ts` and regenerate the SDK.
- **Give form fields unique ids with `useId()`.** Several query tabs can be mounted at once.
- **List boxes (`select[size]`) need an explicit empty option**, or the browser shows the first option as selected while the value is `''`.
- Graphs: `CytoscapeGraph` (layouts radial, force or hierarchy; `fitSignal`). It reads tokens at render time and listens for `THEME_EVENT`.
- **Modules:** a screen belongs to one module (`apps/web-<name>/`). Add its route under `/w/:ws` in that module's `src/index.tsx` as a lazy page (`lazyPage(() => import('./Page'), 'Page')`), and its first path segment to the manifest's `paths` if new. A module imports only `@d4/web-platform`, `@d4/ui-kit`, `@d4/sdk` and domain packages, never another module or the shell; code two modules need goes into one of those packages. Its contract test (`test/contract.test.ts`) runs `lifecycleProblems()`. Query screens are tabs inside `/w/:ws/queries`, with state in `?tabs=mode:id,…&active=…`.
- **A new module:** copy `apps/web-reporting` (package, configs, contract test), register it (Admin › Modules, the local seed, or `run/run.sh web-<name>:exec -- publish`), and add its `component.yaml` (copy `apps/web-reporting/component.yaml`, a port of its own, `podman: { via: ui-modules }`); the `ui-modules` image packages every component served via it.
- **Navigation:** add the page to its module manifest's `nav` (group and group `order`, an icon name the shell maps in `nav.tsx` `ICONS`, `match` prefixes, optional `sub` items, `requires` a role in `Access`, and `order` when several modules share a group). The sidebar, the breadcrumb and the Ctrl K search all read the menu. A sub-item that sets a query parameter (`matrices?kind=…`) is active when the URL has that parameter, so the page must read it.
- **Admin-only pages** each have their own route and wrap their content in `AdminGate` from `@d4/ui-kit`.

### Add a browser test

- **Location:** `apps/e2e/tests`. Use `signIn(page, 'viewer' | 'author' | 'steward' | 'admin')` and `api()` from `helpers.ts`.
- **Test data:** prefix created data with `RUN` (one token, no hyphens, so full-text search can find it) and clean up with `afterAll` via the API.
- **Navigation:** `openNav(page, 'Admin', 'Usage')` opens an item or, through the icon rail's flyout, a sub-item. Scope link lookups to `getByRole('navigation', { name: 'Main' })`; the breadcrumb repeats page names.
- **Ordering:** for multi-step stories use `test.describe.configure({ mode: 'serial' })`.
- **Selectors:** prefer roles and labels, and use `exact: true` for short names. Playwright name matching is a case-insensitive substring match: "Edit" also matches "Cr*edit* Exposure".
- **Graph assertions:** read geometry through the test hook on the graph's DOM node (`el.__cy`); see `layoutStats` in `explorer.spec.ts`.

### Change the Keycloak realm

1. Edit `infra/keycloak/d4-realm.json`. It's used only on first import into a fresh Keycloak.
2. Apply the same change to the running Keycloak:
   ```bash
   podman exec d4-keycloak-1 /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/auth \
     --realm master --user admin --password "$KEYCLOAK_ADMIN_PASSWORD"
   # then e.g. kcadm.sh create users -r d4 …; set-password; add-roles; update clients/<id> -s 'attributes={…}'
   ```
   `get --fields attributes` doesn't display nested attributes; check with a full `get`.

---

## 7. Testing

| Layer | Where | Count | Runs against |
|---|---|---|---|
| Unit | `packages/*/test`, `apps/web/test` | about 120 | in-memory |
| Integration | `packages/db/test`, `packages/graph/test` | about 40 | Postgres (throwaway database per run), dev Neo4j (throwaway workspace per run) |
| API end to end | `apps/api/test/*.e2e.test.ts`, `e2e.test.ts` | about 45 | real Nest app with harness |
| Browser | `apps/e2e/tests` | 40 | live stack via `run/run.sh <component>:test e2e` |

- **`run/run.sh <component>:test [suite]`:** `unit` (default), `integration` (starts the services in `test.integration.needs` on Podman if they are not running, and sets `D4_TEST_*`), `static` (typecheck and lint; `stack:test static` adds knip), `e2e` (the specs in the component's `test.e2e`, through the gateway, `--retries=0` unless given) and `smoke` (gateway and API health, a sign-in, `/v1/me`). Arguments after `--` go to turbo or Playwright, e.g. `e2e:test e2e -- --grep catalog`.
- **Changed only:** unit, integration and static run only the packages in the component's dependency closure that changed since `--base` (default `HEAD`: uncommitted and untracked work), or depend on one that did. A two-line change in `apps/api` tests `@d4/api` only. A change to root config (`package.json`, `pnpm-lock.yaml`, `tsconfig.base.json`, `turbo.json`, `eslint.config.mjs`) selects everything in scope. `--all` tests every package in scope; `stack:test` scopes to the whole repository.
- **Where:** tests run on local Node by default (`local:` is implied); `podman:<component>:test` runs the same turbo command in the pinned Node image with the repository mounted. Browser tests always run in the Playwright image on the host network.
- **Order:** before committing, test the touched apps on local Node (`local:<app>:deploy`, then `<app>:test`, `<app>:test integration` and `<app>:test e2e`); it takes seconds. Then redeploy only the touched apps on Podman (`podman:<app>:deploy`) and rerun their e2e specs. `stack:test e2e` (all 75 specs, about 4 minutes) and `stack:test integration --all` are optional before a commit (for example before merging a branch). CI runs build, typecheck, lint, tests and knip on affected packages, and the browser suite against the stack.
- **Timeouts:** integration suites use generous timeouts (`vitest.config.ts` in `graph` and `api`), because they share Neo4j and run alongside other suites.
- **Not yet covered:** the catalog runner has no dedicated tests. It's exercised through the API and browser suites (runs, test runs, node, relationship and path conversion), but not for timeouts or the row cap directly.

---

## 8. Error contract

REST and GraphQL use the same codes. REST returns them in the body as `error`; GraphQL in `extensions.code`.

| Code | HTTP | Raised by |
|---|---|---|
| `BAD_REQUEST` | 400 | zod parse, invalid model document (`CodecError`), unknown type in filters (`RangeError`) |
| `UNAUTHORIZED` | 401 | missing or invalid token |
| `FORBIDDEN` | 403 | role or ownership check |
| `NOT_FOUND` | 404 | missing, archived or other-tenant resource |
| `VERSION_CONFLICT` / `CONFLICT` | 409 | stale `expectedVersion`; invalid catalog state; fingerprint mismatch |
| `VALIDATION` | 422 | metamodel or parameter validation (`issues[]`) |
| `INVALID_TRANSITION` | 422 | lifecycle move not allowed |
| `RULE_VIOLATION` | 422 | metamodel rule broken (`ruleId`) |
| `LOCKED` | 423 | the workspace is being restored or rebuilt; writes resume when the job ends |
| `QUOTA_EXCEEDED` | 403 | a tenant limit would be passed (`ruleId` names the metric: `elements`, `jobsPerDay`, …) |
| `INTERNAL` | 500 | anything else (logged) |

---

## 9. Pitfalls already hit (and the fix)

| Symptom | Cause | Fix in place |
|---|---|---|
| Integration tests pass instantly with suites skipped | turbo did not hash the `D4_TEST_*` settings, so it replayed an earlier run without the services | `turbo.json` hashes them (`env`) and lists root config as `globalDependencies` |
| Every image build spent ~50 s before the first step, even when nothing changed, and each image compiled the shared packages again | Each image's build context was the whole repository, and each Containerfile ran its own install and turbo build | Images are thin (D78): `run.sh` compiles once on the host with the shared turbo cache and stages a small context per image; an image is rebuilt only when its input hash changes |
| Signed in but landed on the workspace home instead of the deep link (dev server only) | StrictMode ran the auth effect twice; the second `signinRedirectCallback` reused a spent code | One shared callback redemption per page load (`packages/web-platform/src/auth.tsx`) |
| Docker engine crashed during `up`; Docker Desktop came back empty | Parallel image builds plus Neo4j/Keycloak start-up exceeded the VM's CPUs | CPU caps in each `component.yaml`; `deploy` starts components one at a time, each after its dependencies are healthy |
| Explorer tests opened "Client Master contract v2" | Fresh full-text index scored the longer name higher | Exact name matches rank first; tests pick by exact name |
| Invalid render parameters answered 500 instead of 400 (tests only) | zod 3.25 ships CJS and ESM builds; under vitest, src (ESM) and `@d4/jobs` dist (CJS) saw different `ZodError` classes | The error mapper also recognises zod errors by name and `issues` |
| Graph pictures: edges crossed labels; parallel relationships stacked their labels | Lines drawn after labels; one line per relationship | Labels drawn last with a white halo; one line per element pair with a combined label in time order |
| A job endpoint answered 500 "relation \"jobs\" does not exist" | The dev database had not run migration 0005 | Migrations run as the `postgres` hook whenever the ops image changes (`run/run.sh podman:stack:deploy`); by hand: `run/run.sh ops:exec -- seed` |
| Page blank with "Cannot read properties of undefined" right after changing a package | Vite's pre-bundle of `@d4/core` was stale | `local:web:deploy` runs Vite with `--force`; run it again after changing `packages/*` |
| On Queries, a tall tab made the tab strip scroll instead of the page | The strip (`overflow-x: auto`) sat in a scrolling flex column, so its minimum height was 0 and it shrank | Only the active `.tab-panel` scrolls; the strip is `flex: none` |
| Search for a hyphenated name (e.g. "cut-over") found nothing | The analyzer indexes "cut" and "over"; the escaped prefix query "cut\-over*" is not analyzed | `luceneQuery` splits on hyphens and slashes too |
| The web app is blank after adding or renaming a workspace package, with "does not provide an export named …" | The package has no ESM build, so Vite serves its CommonJS file | Give it a tsup ESM build and a `browser` entry in its `exports` map, like `@d4/render` |
| A new tenant's requests fail with "No ready graph database" or a connection error from a running api or worker | Every process reaches tenant graphs through `NEO4J_HOSTS`, computed when it starts | Restart them after `ops:exec -- tenant create` (`run/run.sh service:stop`, then `service:start`) |
| "The graph database registered for tenant … belongs to another tenant" | The tenant's registered bolt URI (or host mapping) points at a Neo4j already claimed by another tenant (`:D4Tenant` marker) | Fix the registry entry or `NEO4J_HOSTS`; never remove the marker to get past it |
| Neo4j exits with 137 (`OOMKilled`), freezes (`stop-the-world pause` with `gcTime=0` in `debug.log`), or everything times out | The machine is over-committed: the stack, a Docker test build and local servers together exceed RAM, so the Docker VM swaps (seen on an 8 GB Mac with Docker at 6.2 GB: load average above 100) | Neo4j is sized to ~1.2 GB (APOC only, every JVM area capped). On 8 GB: run browser tests against one stack at a time and give macOS room (the VM ≤ 5 GB). `run/run.sh neo4j:start` restarts it |
| `@d4/jobs`, `@d4/infra`, `@d4/graph` or `@d4/db` integration tests time out | Several database-heavy files ran at once (Neo4j's 30 s transaction limit, or Postgres database creation) | These packages run their test files one at a time with longer limits (`vitest.config.ts`); keep it that way |
| Sign-in hangs on "Signing in…"; Keycloak's discovery document names `localhost:8080` | A proxy sent `X-Forwarded-Port` with its own listen port, and Keycloak (`KC_PROXY_HEADERS=xforwarded`) used it | The gateway sends `X-Forwarded-Host` with the public port and no `X-Forwarded-Port` |
| The gateway answers 502 for an app on the host (`could not be resolved` in its log) | nginx's resolver asks DNS only; `host.containers.internal` is in `/etc/hosts` | The gateway's start script replaces `/etc/hosts` names in `UPSTREAM_*` with their address; local servers must listen on all interfaces |
| Background-job browser tests time out | The worker or renderer is not running on either runtime | `run/run.sh status`; start them (`service:start`). Both runtimes share the queues, since a component only ever runs once |
| Names in a list squeezed to one letter | `.items` rows are a grid whose first column is the 10 px layer dot | Lists without a dot override `grid-template-columns` |
| Catalog browser test counted 9 queries instead of 8 | A tenant query had been published in the dev workspace | The test counts what is listed and checks the 8 certified system queries |
| Neo4j and API test suites time out on a brand-new Neo4j | `CALL db.awaitIndexes(120)` is one transaction, killed by the 30 s server timeout while ~100 indexes populate; concurrent appliers also collided | `awaitSchemaOnline` polls `SHOW INDEXES` in short queries; `applySchema` treats "already exists" from a concurrent applier as success and retries transient lock errors |
| Neo4j container exits 137 during tests or builds | Docker VM out of memory | Neo4j heap 640m / page cache 256m / transaction cap 256m, container cap 1.8 GB; test container 1.5 GB with `--concurrency=2`; Docker Desktop at 6 GB |
| Reviews fail with "fingerprint mismatch" | Postgres `jsonb` reorders keys | `canonicalJson` sorts keys before hashing |
| Relationship lookup by id takes ~5 s | One seek per relationship type (UNION of 90+) | Cross-type full-text index on `r.id` |
| Full-text cleanup can't find `e2e-abc…` | Tokenizer splits on hyphens | `RUN` prefix is a single token (`e2erun…`) |
| `MATCH … AS end` fails | `end` is a reserved word | Use other aliases (`plannedEnd`) |
| Static check bypassed via `` `apoc.load.json`( `` | Masking blanked backtick names | Quoted names near calls and spaced dots are errors |
| Element picker "selected" but run says required | `select[size]` with no empty option | Explicit "— none selected —" option and a "Selected:" hint |
| Deep link lost after sign-in | `history.replaceState` doesn't update React Router | `/callback` route navigates to `returnTo` |
| Explorer nav marked current on `/queries` | `NavLink` prefix match | Plain `Link` with computed state |
| Graph unreadable on dense neighbourhoods | Weak force layout, fit-to-screen shrinking | Radial default, stronger force, wide hierarchy, minimum readable zoom (0.7) |
| Preview on port 5174 can't sign in | Keycloak only allows `localhost:5173` | `launch.json` attaches to 5173 (`autoPort: false` for `stack`) |
| Nest provider undefined at run time | No decorator metadata under tsx/esbuild | Always `@Inject(Token)` explicitly |
| `run.sh needs Node.js 24` | No Node 24 on PATH or in nvm | Install Node 24 (`nvm install 24`); `run.sh` installs pnpm and the workspace itself |
| A container never turns healthy under Podman although its service runs | Podman's default OCI image format ignores `HEALTHCHECK` in a Containerfile | Health checks live in `component.yaml` (`health.cmd`), passed to `podman run --health-cmd`; `run.sh` runs them itself (`podman healthcheck run`) |
| A `node -e "…"` health check fails with a syntax error | Podman splits a health-check argument on spaces | Write such one-liners without spaces (see the renderer in `apps/renderer/component.yaml`) |
| A container stays `starting` for ever, or dependents never start | Some Podman setups never run health checks on their own | `run.sh` runs `podman healthcheck run` every 5 s after a start and decides from that, never from Podman's own status |
| `getaddrinfo EAI_AGAIN neo4j` (or any service name) from a container | Nothing resolves service names on the host network | Everything dials `127.0.0.1:<port>`; a registered tenant URI (`bolt://neo4j:7687`) is mapped through `NEO4J_HOSTS` (`routeUri`) |
| `exec: node: not found` in the renderer | A Node binary from the Alpine (musl) image copied into the glibc Playwright image | The renderer's Containerfile takes Node from `NODE_SLIM_IMAGE` |
| Browser tests fail with `EACCES` under `apps/e2e/results` | The folder was created as root by earlier Docker runs; rootless Podman cannot write it | Give it back to your user once (`sudo chown -R "$USER" apps/e2e/results`) |
| On a fresh database the admin test finds no "dev-viewer" to grant a role | People appear in D4 only after their first API call | Browser-test setup calls `/v1/me` as every dev user first |
| MinIO image pull denied | MinIO stopped publishing images | In-repo S3 mock (`mocks/s3`) for local S3 (D59) |

---

## 10. Conventions

- **Code:** TypeScript strict with `noUncheckedIndexedAccess`; Prettier (single quotes, width 100); ESLint `typescript-eslint` recommended (`any` allowed only in tests).
- **Names:**
  - metamodel types: PascalCase
  - relationship types: UPPER_SNAKE
  - attributes and parameters: camelCase
  - catalog slugs: kebab-case
- **Comments:** explain *why* (constraints, trade-offs), not what. Keep them short.
- **Commits:**
  - imperative subject, with a body listing what changed and how it was verified
  - ends with the attribution trailer required by the repo's tooling
  - one logical change per commit
- **Docs:**
  - user-facing behaviour goes in the user manual (`user-manual/`); keep the README to setup and an overview; regenerate screenshots with `run/run.sh e2e:test e2e -- -c screenshots.config.ts` when screens change
  - decisions go in the PLAN.md decision log (add the next `D<n>` row)
  - structural decisions get an ADR in `docs/adr/`

---

## 11. Open items (as of 2026-10-19)

- Dedicated tests for `packages/graph/src/catalog-runner.ts`: timeout and row cap.
- Browser tests in CI (needs the full stack in the pipeline).
- Batched (`UNWIND`) graph writes for large imports.
- Write-class catalog queries (`kind: write`) are modelled but not executable.
- Licensed UBS font to replace the Source Sans 3 stand-in (`--font-sans`).
- Realm role removals in Keycloak reach scheduled reports only after the owner's next sign-in (bindings apply at once).
- Next phase: Phase 5, SaaS (per-tenant provisioning, backups, quotas, webhooks; PLAN.md).
