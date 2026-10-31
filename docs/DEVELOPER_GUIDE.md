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
| 8 | **Containers (Podman) are the source of truth.** Everything builds and runs in containers via `deploy/dev-infra.sh`, `dev-deploy.sh` and `test.sh`; local Node (`deploy/dev.sh`) is optional, for fast iteration. | `apps/*/Containerfile`, `deploy/` |
| 9 | Ids are **ULIDs** (26 chars, Crockford base32). | `packages/core/src/ids.ts` |
| 10 | Cypher identifiers (labels, relationship types) are **never interpolated unchecked**; they pass `ident()` and come from the metamodel. | `packages/graph/src/mapping.ts` |

---

## 2. Repository map

```
apps/
  api/        NestJS (Fastify) API: REST + read-only GraphQL, auth, catalog, jobs
  worker/     Background job worker (BullMQ consumer): exports and spreadsheet imports
  renderer/   Render queue consumer: PNG/PDF via headless Chromium (Playwright image)
  web/        React + Vite SPA, served by nginx in a container: the shell (src/App.tsx, components/, nav.tsx) and six modules (src/modules/)
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
  ui-kit/     React components shared by the web app and embedders (Gantt, GraphCanvas, ResultTable, element list and details, forms, view bar), styles.css, base.css (tokens, element defaults) and app.css (controls, panes, lists, forms, shared component styles)
  web-platform/ what every web module shares: sign-in, typed API client, query keys, current user and view, module contract
samples/      ubs-banking.yaml (illustrative sample model)
deploy/       compose/ (split by concern), dev-infra.sh, dev-deploy.sh, dev.sh, test.sh, lib/, env/ (layered settings), Keycloak realm, OTel, nginx, e2e runner
mocks/        development-only S3 (file-backed, S3 REST + SigV4) and SMTP (Mailpit-compatible inbox API)
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
    └──── api ─┴── worker (jobs, db)
web ──► core, metamodel (bundled for the browser)
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
| Request schemas + OpenAPI | `apps/api/src/model/model.schemas.ts`, `http/zod.ts` (z, ErrorSchema), `http/zod.pipe.ts` (`@ValidBody`, `@ValidQuery`); paths per feature in `<feature>/<feature>.openapi.ts`, assembled by `http/openapi.ts` |
| Catalog API | `apps/api/src/catalog/*` |
| Web modules and routes | `apps/web/src/modules/<explore\|queries\|plan\|data\|reporting\|admin>/module.tsx` (each module's routes and menu items, registered in `modules/index.ts`); the shell (`App.tsx`, `components/Layout.tsx`, `nav.tsx`) mounts them under `/w/:ws` |
| Web API client | `packages/web-platform/src/api.ts` (shared calls over the typed `@d4/sdk` client), `apps/web/src/modules/<module>/api.ts` (a module's own calls) |
| Design tokens / themes | `packages/ui-kit/base.css` (tokens, element defaults) and `app.css` (controls and shared components), `apps/web/src/shell.css`, each module's `<module>.css`; `apps/web/src/theme.ts` |

---

## 3. Running locally

**Prerequisite:** Podman 5 (rootless) with `podman compose` and `systemctl --user enable --now podman.socket`; `deploy/dev-infra.sh doctor` checks the setup. About 4 GB of free memory for the stack; Node 24 only for local runs.

Four scripts, each for one job; all read `deploy/env` and share `deploy/lib/common.sh`. Compose files are split by concern in `deploy/compose/` (`infra`, `apps`, `web`, `gateway`, `observability`, `tools`); every app has its own `Containerfile`.

**Gateway:** the gateway always runs in Podman, on the only browser-facing port (`GATEWAY_PORT`, 5173), with two hosts: `D4_PUBLIC_URL` (http://localhost:5173) serves the containers or the apps `dev.sh` runs on local Node, and `D4_PODMAN_URL` (http://d4.localhost:5173, `GATEWAY_PODMAN_HOST`) always serves the containers (`*.localhost` resolves to this machine without `/etc/hosts`). Each host is one origin with its own sign-in: Keycloak takes its issuer from the request's host, `/config.json` holds paths the page resolves against its origin, and the API accepts `OIDC_ISSUER` plus `OIDC_EXTRA_ISSUERS`. On each host: the web app at `/`, the API at `/api` (prefix stripped, so the API keeps `/v1/...`, `/graphql`, `/healthz`), Keycloak at `/auth` (`KC_HTTP_RELATIVE_PATH`), and in development the mail inbox at `/mail/` and Grafana at `/grafana/`. The gateway (`apps/gateway`, nginx) resolves upstreams per request, so a stopped app gives 502 rather than a dead gateway, and `deploy/dev.sh` can point one upstream at a process on the host. No CORS: everything is same-origin. It starts with the infrastructure.

| Command | What it does |
|---|---|
| `deploy/dev-infra.sh up [--obs]` | Start Postgres, Neo4j, Redis, Keycloak, the gateway and the S3/SMTP mocks (plus OTel, Tempo, Prometheus and Grafana with `--obs`), then run `db-migrate` (migrations + local seed) and `neo4j-schema`. |
| `deploy/dev-infra.sh status` / `logs <svc>` / `down` / `reset [--yes]` | Status, logs, stop; `reset` also **deletes all volumes** (asks first). |
| `deploy/dev-infra.sh migrate` / `schema` | Re-run Postgres migrations + seed, or Neo4j DDL. |
| `deploy/dev-infra.sh tenant create t_acme "Acme Ltd"` | Operator: a new tenant with its own Neo4j container `d4-neo4j-t_acme` on 127.0.0.1:7701+ (password in `deploy/secrets/`, git-ignored), registered, claimed, schema applied, starter metamodel and `default` workspace seeded. Re-runnable; no service gets the container engine's socket. `D4_OPS=local` runs the control-plane step (`d4-ops`) on local Node. |
| `deploy/dev-infra.sh tenant list` / `check` / `suspend` / `resume` / `delete` / `remove <id>` | Operator: tenant status and health; `remove` also stops its container (the volume stays). |
| `deploy/dev-infra.sh tenant user t_acme acme-admin [role …]` | Local Keycloak user for a tenant (password `DEV_USER_PASSWORD`, default role admin); the first run switches the `tenant` claim to an admin-only user attribute. |
| `deploy/dev-infra.sh quota <tenant> [metric=value …]` | Operator: show or change a tenant's limits. |
| `deploy/dev-infra.sh token [user]` / `doctor` | An access token (default `dev-admin`) / environment checks. |
| `deploy/dev-deploy.sh [api\|worker\|renderer\|web\|gateway\|backend\|all]` | Build and (re)start app containers, all by default; starts the infrastructure first if needed. Builds and restarts only the named apps (`--no-deps`): init jobs and mocks are left alone, so after a migration or seed change run `dev-infra.sh migrate`. Image builds reuse turbo's cache (a build-cache mount), so only changed packages rebuild, and the backend images (api, worker, renderer, ops) start from `turbo prune`, so a change outside an app's workspaces leaves its layers cached. `build` and `stop` take the same names; `status` lists images. Set `D4_OTEL_ENDPOINT=http://otel-collector:4318` to trace the API. |
| `deploy/test.sh static` | Typecheck, lint and `knip` (unused files, exports, dependencies). `static`, `unit`, `integration` and `web` run on host Node 24 when it is installed (picked from nvm if needed; seconds, no image build); `--container` forces the test image, and `all` always uses containers. |
| `deploy/test.sh unit` / `integration [--filter pkg]` | Unit tests only, or all tests with Postgres, Neo4j, Redis and S3 (two suites at a time, 1.5 GB cap). |
| `deploy/test.sh e2e [playwright args]` | Playwright suite through the gateway (container on the host network), e.g. `--grep catalog --retries=0`; it tests whatever mix of container and `dev.sh` apps is behind the gateway. |
| `deploy/test.sh web` / `smoke` / `all` | Web checks and build / gateway and API health + login + `/api/v1/me` / static, integration and browser tests (full run; not required before each commit). Add `--local` to run on host Node. |
| `deploy/mfe-publish.sh <name> <dist\|-> <version> [--activate] [--keep N]` | Upload a web module build as an immutable release, activate it for the local tenant (or roll back with `-` and an older version), and delete inactive versions beyond the newest N (D70). |
| `deploy/dev.sh sample` / `cli <args>` | Import `samples/ubs-banking.yaml` (idempotent) / run the `d4` CLI in a container; paths are relative to the repo root. |

**Bringing the stack up on a busy machine:** `dev-infra.sh up` first, then `dev-deploy.sh backend`, then `dev-deploy.sh web`, so image builds and JVM start-ups do not overlap. Neo4j, Keycloak, the API and the test container have CPU caps (2, 1.5, 1, 2).

### Settings

All settings live in `deploy/env` and are loaded in order, later files winning: `common.env` (public URLs, ids, flags), `container.env` or `host.env` (how a process reaches the services from inside the compose network or from the host), `dev-secrets.env` (local credentials only), then your git-ignored `local.env`. A variable set in your shell wins over the files, e.g. `WEBHOOK_INTERVAL_MS=2000 deploy/dev.sh worker`. Compose reads the same files (`env_file`, and `${...}` from the environment `dev.sh` exports), so call compose through `deploy/dev.sh` or export the files first. Services parse settings with `@d4/config`; `D4_ENV` defaults to `production`, which refuses the dev password. To add a setting: add it to a fragment in `packages/config` (or the app's `config.ts`), put the local value in the right env file (secrets in `dev-secrets.env`), and never default a secret in code.

### Apps on local Node (optional)

For quick changes, run an app on the host with hot reload, behind the same gateway: `dev.sh` points the gateway's `localhost` upstream for it at `host.containers.internal:<port>` (recreating the gateway takes about a second) and on Ctrl-C routes back. The container keeps running, so http://d4.localhost:5173 shows the deployed build next to the local one; `test.sh e2e` tests localhost, `test.sh e2e --podman` the containers. Needs Node ≥ 24 on PATH; pnpm runs at the version pinned in `package.json` via `npx`, so corepack is not needed. Host `node_modules` and `dist` are ignored by image builds (`.containerignore`). Local servers listen on all interfaces so the gateway container can reach them.

| Command | What it does |
|---|---|
| `deploy/dev.sh web` | Installs dependencies if missing, builds the packages the web app imports, then runs Vite on `:5174` behind the gateway, with hot reload (HMR through the gateway's port); `/config.json` comes from the env files. The dev server writes an import map of the shared packages too, so the web modules (from the registry, releases or `dev.sh web-<name>`) load into it. |
| `deploy/dev.sh web-<name>` | One web module (`explore`, `queries`, `plan`, `data`, `reporting`, `admin`) rebuilt on every change (`vite build --watch`) and served at `/mfe/_dev/<name>/` on `localhost` only; point the shell at it with `localStorage['d4:module:<name>'] = '/mfe/_dev/<name>/<name>.js'` and reload (about a second per change). Runs alongside `dev.sh web` and `api`: the running overrides are kept in `deploy/.dev-routes`. |
| `deploy/dev.sh api` | API on local Node (tsx watch) on `:3100` (`host.env`), behind the gateway at `/api`. It uses the local queues, so run `dev.sh worker` and `dev.sh renderer` for background jobs. |
| `deploy/dev.sh worker` | Job worker on local Node for the local API's queues (`d4-jobs-local`, `d4-render-local`). Scheduler, webhook sending and daily backups are off (`host.env`) unless set, e.g. `WEBHOOK_INTERVAL_MS=2000 deploy/dev.sh worker`, because they share the dev database with the container worker. |
| `deploy/dev.sh renderer` | Builds the renderer image from the tree and runs it once on the local render queue; Chromium needs the Playwright image. |
| `deploy/dev.sh restore` | Routes the gateway back to the containers (if a `dev.sh` run was killed) and clears `deploy/.dev-routes`. |
| `deploy/test.sh web --local` | Web unit tests, typecheck, lint and production build on local Node (seconds, not minutes). |
| `deploy/dev-deploy.sh web` | After committing: rebuilds and starts the `web` container. |

Loop: `dev.sh web` (plus `dev.sh api` when the API changes) → edit (hot reload) → `test.sh web --local` and `test.sh e2e` → commit → ask before deploying → stop the local servers → `dev-deploy.sh web` (and `api`) → `test.sh e2e`.

Hot reload covers `apps/web` only. After changing `packages/*`, restart `dev.sh web` (it rebuilds the packages and Vite's pre-bundle with `--force`) and `dev.sh api`; otherwise the page uses the old package and fails with errors such as an export being undefined.

Vite serves the dev build, so React StrictMode runs effects twice. That surfaces bugs the production build hides, such as one-time OIDC callback codes being redeemed twice.

### Ports

| Port | Service |
|---|---|
| 5173 | gateway, the only browser-facing port (`D4_PUBLIC_URL`; Keycloak redirect URIs follow it): web `/`, api `/api` (`/api/v1/openapi.json`, `/api/graphql`), keycloak `/auth`, inbox `/mail/`, grafana `/grafana/` |
| 5174 | `dev.sh web` (Vite, behind the gateway) |
| 7474 / 7687 | neo4j |
| 5432 | postgres |
| 6379 | redis |
| 8333 | S3 (mocks/s3, data in the `s3-mock-data` volume) |
| 1025 | SMTP (mocks/smtp; report emails stay local; inbox at `/mail/`) |
| 3002 / 3003 | worker / renderer health (`/healthz`, inside the containers) |
| 3100 / 3102 | `dev.sh api` (behind the gateway) / `dev.sh worker` health, on the host |
| 7701+ | Bolt of tenant Neo4j containers from `tenant-create` (127.0.0.1 only) |

### Local users

The password for all of them is `d4-local-dev`. They exist only in the local realm.

| User | Roles |
|---|---|
| `dev-admin` | admin, query-author, query-steward |
| `dev-viewer` | viewer |
| `dev-author` | query-author, viewer |
| `dev-steward` | query-steward, viewer |

### Browser preview in the Claude desktop app

`.claude/launch.json` has three configurations:
- `dev` attaches to whatever serves `http://localhost:5173` (the container or `dev.sh web`).
- `dev.sh web` runs `deploy/dev.sh web`, and `stack` runs `deploy/dev-deploy.sh web`. The desktop app's preview runner may not be allowed into `~/Documents` (macOS privacy), in which case start `dev.sh web` from a terminal and use `dev`.

Do not let the preview move to another port: sign-in will fail there.

### Running a single package's checks

```bash
deploy/test.sh integration --filter @d4/<package>
```

Integration tests need `D4_TEST_POSTGRES_URL`, `D4_TEST_NEO4J_URL` and `D4_TEST_NEO4J_PASSWORD`. The `test` service sets them, turbo passes them through (`turbo.json`), and suites without them are skipped.

### Changing dependencies (no local pnpm)

Edit the `package.json`, then regenerate the lockfile in a container:

```bash
podman run --rm --userns=keep-id -e HOME=/tmp -v "$PWD":/repo:z -w /repo docker.io/library/node:24-alpine sh -c \
  "COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm@9.12.0 install --lockfile-only"
```

With a local install (`node_modules` present), that container run stops at pnpm's "remove the modules directories?" prompt; answering yes would delete the host's `node_modules`. Use the local pnpm instead: `npx pnpm@9.12.0 install` (Node at `/opt/homebrew/bin`). The lockfile is platform-independent, so Docker builds accept it.

Images install with `--frozen-lockfile`. A stale lockfile fails the build, not silently at run time.

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
   - node types: `name` (PascalCase), `layer`, optional `extends`, and `attributes` (camelCase, not reserved)
   - relationship types: `name` (UPPER_SNAKE), `from`/`to` (types or `*`) and `attributes`
   - enums go under `enums`
2. **Bump `version`.** The local seed registers it and repoints the `default` workspace. Production needs a migration plan.
3. Run `deploy/test.sh integration`. `@d4/metamodel` checks references and the reserved names.
4. Run `deploy/dev-infra.sh schema`. New relationship types change the cross-type id index name; the schema step drops a stale one only when no workspace's metamodel still uses it (`applySchema` drops nothing unless given `keepRelationshipIndexes`).
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
- Graphs: `GraphCanvas` (layouts radial, force or hierarchy; `fitSignal`). It reads tokens at render time and listens for `THEME_EVENT`.
- **Modules:** a screen belongs to one module (`apps/web/src/modules/<module>/`). Add its route to that module's `module.tsx` as a lazy page (`lazyPage(() => import('./Page'), 'Page')`). A module imports only `@d4/web-platform`, `@d4/ui-kit` and domain packages, never another module or the shell; code two modules need goes into one of those packages. Query screens are tabs inside `/w/:ws/queries`, with state in `?tabs=mode:id,…&active=…`.
- **Navigation:** add the page to its module's `nav` (group and group `order`, icon from `@tabler/icons-react`, `match` prefixes, optional `sub` items, `visible` rule, and `order` when several modules share a group). `nav.tsx` builds the menu from every module; the sidebar, the breadcrumb and the Ctrl K search all read it. A sub-item that sets a query parameter (`matrices?kind=…`) is active when the URL has that parameter, so the page must read it.
- **Admin-only pages** each have their own route and wrap their content in `AdminGate` from `@d4/ui-kit`.

### Add a browser test

- **Location:** `apps/e2e/tests`. Use `signIn(page, 'viewer' | 'author' | 'steward' | 'admin')` and `api()` from `helpers.ts`.
- **Test data:** prefix created data with `RUN` (one token, no hyphens, so full-text search can find it) and clean up with `afterAll` via the API.
- **Navigation:** `openNav(page, 'Admin', 'Usage')` opens an item or, through the icon rail's flyout, a sub-item. Scope link lookups to `getByRole('navigation', { name: 'Main' })`; the breadcrumb repeats page names.
- **Ordering:** for multi-step stories use `test.describe.configure({ mode: 'serial' })`.
- **Selectors:** prefer roles and labels, and use `exact: true` for short names. Playwright name matching is a case-insensitive substring match: "Edit" also matches "Cr*edit* Exposure".
- **Graph assertions:** read geometry through the test hook on the graph's DOM node (`el.__cy`); see `layoutStats` in `explorer.spec.ts`.

### Change the Keycloak realm

1. Edit `deploy/keycloak/d4-realm.json`. It's used only on first import into a fresh Keycloak.
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
| Browser | `apps/e2e/tests` | 40 | live stack via `deploy/test.sh e2e` |

- **Order:** before committing, first test the touched apps on local Node (`deploy/dev.sh <app>`, `deploy/test.sh <suite> --local`, the covering browser specs); this is strongly preferred because it takes seconds. Then build and redeploy only the touched apps, then run `deploy/test.sh integration --filter <pkg>` for the touched packages before the browser specs that cover the change (`deploy/test.sh e2e <spec>`). A full `test.sh all` is optional (for example before merging a branch). Type check and lint also run in CI (`.github/workflows/ci.yml`), which starts Postgres and Neo4j services. Browser tests are not in CI yet.
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
| `test.sh integration` passes instantly with suites skipped | turbo did not hash the `D4_TEST_*` settings, so it replayed an earlier run without the services | `turbo.json` hashes them (`env`) and lists root config as `globalDependencies` |
| Every image build spends ~50 s before the first step, even when nothing changed | The compose provider (`docker-compose` plugin) reads `.dockerignore`, not `.containerignore`, so it uploaded the whole tree with `node_modules` (~900 MB) | `.dockerignore` is a symlink to `.containerignore`; edit `.containerignore` only |
| Signed in but landed on the workspace home instead of the deep link (dev server only) | StrictMode ran the auth effect twice; the second `signinRedirectCallback` reused a spent code | One shared callback redemption per page load (`packages/web-platform/src/auth.tsx`) |
| Docker engine crashed during `up`; Docker Desktop came back empty | Parallel image builds plus Neo4j/Keycloak start-up exceeded the VM's CPUs | CPU caps in compose; start in stages (see §3) |
| Explorer tests opened "Client Master contract v2" | Fresh full-text index scored the longer name higher | Exact name matches rank first; tests pick by exact name |
| Invalid render parameters answered 500 instead of 400 (tests only) | zod 3.25 ships CJS and ESM builds; under vitest, src (ESM) and `@d4/jobs` dist (CJS) saw different `ZodError` classes | The error mapper also recognises zod errors by name and `issues` |
| Graph pictures: edges crossed labels; parallel relationships stacked their labels | Lines drawn after labels; one line per relationship | Labels drawn last with a white halo; one line per element pair with a combined label in time order |
| A job endpoint answered 500 "relation \"jobs\" does not exist" | The dev database had not run migration 0005 | Run migrations after pulling (`deploy/dev-infra.sh migrate`, or `node packages/db/dist/migrate.js` with `POSTGRES_URL` on the host) |
| Page blank with "Cannot read properties of undefined" right after changing a package | Vite's pre-bundle of `@d4/core` was stale | `dev.sh web` runs Vite with `--force`; restart it after changing `packages/*` |
| On Queries, a tall tab made the tab strip scroll instead of the page | The strip (`overflow-x: auto`) sat in a scrolling flex column, so its minimum height was 0 and it shrank | Only the active `.tab-panel` scrolls; the strip is `flex: none` |
| Search for a hyphenated name (e.g. "cut-over") found nothing | The analyzer indexes "cut" and "over"; the escaped prefix query "cut\-over*" is not analyzed | `luceneQuery` splits on hyphens and slashes too |
| The web app is blank after adding or renaming a workspace package, with "does not provide an export named …" | The package has no ESM build, so Vite serves its CommonJS file | Give it a tsup ESM build and a `browser` entry in its `exports` map, like `@d4/render` |
| A new tenant's requests fail with "No ready graph database" or a connection error from `dev.sh api` | Local processes reach tenant instances through `NEO4J_HOSTS`, computed when they start | Restart `dev.sh api` and `dev.sh worker` after `tenant-create` |
| "The graph database registered for tenant … belongs to another tenant" | The tenant's registered bolt URI (or host mapping) points at a Neo4j already claimed by another tenant (`:D4Tenant` marker) | Fix the registry entry or `NEO4J_HOSTS`; never remove the marker to get past it |
| Neo4j exits with 137 (`OOMKilled`), freezes (`stop-the-world pause` with `gcTime=0` in `debug.log`), or everything times out | The machine is over-committed: the stack, a Docker test build and local servers together exceed RAM, so the Docker VM swaps (seen on an 8 GB Mac with Docker at 6.2 GB: load average above 100) | Neo4j is sized to ~1.2 GB (APOC only, every JVM area capped). On 8 GB: do not run the local servers while `dev.sh test` builds and runs, run browser tests against one stack at a time, and give macOS room (Docker ≤ 5 GB). `docker compose -f deploy/docker-compose.yml up -d neo4j` restarts it |
| `@d4/jobs`, `@d4/infra`, `@d4/graph` or `@d4/db` integration tests time out | Several database-heavy files ran at once (Neo4j's 30 s transaction limit, or Postgres database creation) | These packages run their test files one at a time with longer limits (`vitest.config.ts`); keep it that way |
| Sign-in hangs on "Signing in…"; Keycloak's discovery document names `localhost:8080` | A proxy sent `X-Forwarded-Port` with its own listen port, and Keycloak (`KC_PROXY_HEADERS=xforwarded`) used it | The gateway sends `X-Forwarded-Host` with the public port and no `X-Forwarded-Port` |
| The gateway answers 502 for an app on the host (`could not be resolved` in its log) | nginx's resolver asks DNS only; `host.containers.internal` is in `/etc/hosts` | The gateway's start script replaces `/etc/hosts` names in `UPSTREAM_*` with their address; local servers must listen on all interfaces |
| Background-job browser tests time out when run against `dev.sh api` | `dev.sh worker` / `dev.sh renderer` not running, so jobs on the local queues are never picked up | Start `dev.sh worker` and `dev.sh renderer` before `test.sh e2e` |
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
| `pnpm` / `node` not found | No local toolchain | Use `deploy/dev.sh` and the container commands above |
| A container never turns healthy under Podman although its service runs | Podman's default OCI image format ignores `HEALTHCHECK` in a Containerfile | Health checks live in the compose files, not the Containerfiles |
| A `node -e "…"` health check fails with a syntax error | Podman splits a health-check argument on spaces | Write such one-liners without spaces (see the renderer in `compose/apps.yaml`) |
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
  - user-facing behaviour goes in the user manual (`user-manual/`); keep the README to setup and an overview; regenerate screenshots with `deploy/test.sh e2e -c screenshots.config.ts` when screens change
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
