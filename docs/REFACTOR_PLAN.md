# D4 refactor plan: production readiness

**Status:** P0 and P1 built 2026-10-25 (D57, D58), plus in-repo S3 and SMTP mocks replacing SeaweedFS, aws-cli and Mailpit (D59); P2 built 2026-10-25 (D60); P3 built 2026-10-25 (D61); P4 built 2026-10-31 (D62); P5 built 2026-10-31 (D63); P6 onwards proposed. See section 10. When a phase is accepted, record its decisions in the [PLAN.md](PLAN.md) decision log (D31 onwards) and the structural ones in ADR 0008 (section 9).

Scope, as requested:
1. Prune the code base: remove duplication, use well-defined patterns, delete dead code.
2. Move from Docker to Podman, with one Containerfile per app.
3. Replace `deploy/dev.sh` with four focused scripts: `dev-infra.sh`, `dev-deploy.sh`, `dev.sh` and `test.sh`.
4. Add an nginx gateway in front of every app, whether the app runs in a container or on local Node.
5. Externalise all configuration into real env files (not only an `.env.example`), including every host URL.
6. Split the web app's page categories (Explore, Queries, Plan, Data, Reporting, Admin) into federated modules that the shell loads at run time and that deploy independently.

---

## 1. Summary

| Phase | What lands | Size | Depends on |
|---|---|---|---|
| P0 | Baseline, `knip` dead-code gate, Node 20 → 24 LTS | S | none |
| P1 | `@d4/config`, layered env files, no hard-coded URLs, runtime web config | M | P0 |
| P2 | Podman, one Containerfile per app, split compose files, `dev-infra.sh`, `dev-deploy.sh`, `test.sh` | L | P1 |
| P3 | nginx gateway (single origin: `/`, `/api`, `/auth`, `/mfe/*`), `dev.sh` local runs routed through it | M | P2 |
| P4 | Backend pruning and patterns (config, runtime, Nest modules, guards, stores, OpenAPI) | L | P1 (parallel with P2–P3) |
| P5 | Web app as a modular monolith (module contract, SDK client, CSS split, import boundaries) | M | P1 (parallel with P2–P4) |
| P6 | Module federation: shell plus six remotes, manifest, per-remote images | L | P3, P5 |
| P7 | CI on Podman (images + browser tests), docs, decision log, ADR | M | each phase |

```
P0 ─► P1 ─┬─► P2 ─► P3 ─────────┐
          ├─► P4 (parallel)     ├─► P6 ─► P7
          └─► P5 (parallel) ────┘
```

Every phase leaves `test.sh all` green and is committed as several small commits (one logical change each, per CLAUDE.md). P5 is worth doing even if P6 is postponed.

---

## 2. What the review found

### 2.1 Containers and scripts
- **One `Dockerfile` with six targets.** Every Node image copies the whole `/repo` (all workspaces, sources and dev dependencies) from the build stage. There is no pruning, everything runs as root, and the base is `node:20-alpine`. Node 20 reached end of life in April 2026.
- **Fragile renderer image.** `node_modules` is installed on Alpine (musl) and copied into the Ubuntu (glibc) Playwright image. This only works while every dependency is pure JS, as the comment in the `Dockerfile` admits.
- **Image names are short** (`neo4j:5.26-community`, `postgres:16-alpine`). Podman needs fully qualified names or configured short-name aliases.
- **`deploy/dev.sh` mixes five concerns in 165 lines and 25 commands:** infrastructure, image deploys, local Node runs, tests and operator tools.
  - It assumes macOS: the `/Applications/Docker.app` PATH fallback, `/opt/homebrew/bin`, and `lsof` checks for a `com.docke*` process.
  - It copies 10 to 15 environment variables inline, with small differences, into `api-local`, `worker-local`, `renderer-local` and `tenant_cli`.
- **Ports are coupled to OIDC.**
  - The browser talks to three origins: `:5173` (web), `:3000` (API) and `:8080` (Keycloak). The API therefore needs CORS (`apps/api/src/app.setup.ts:9`, which hard-codes `http://localhost:5173`).
  - The e2e container runs four `socat` forwards (`deploy/e2e/run.sh`) so its browser sees the same origins.
- **Operator entry points are scattered across three packages:**
  - `packages/db/src/{migrate,seed-local,set-quota}.ts`
  - `packages/jobs/src/tenant-cli.ts`
  - `apps/api/src/scripts/apply-schema.ts`

  The init jobs run them from the API image.
- **Stale scripts and settings:**
  - The root `package.json` scripts `infra:up`, `infra:down`, `dev` and `db:schema` duplicate `dev.sh`.
  - The API's `dev`/`start` scripts read a root `.env` that nothing creates.
  - `.claude/launch.json` points at the macOS Docker binary.

### 2.2 Configuration
- **Three copies of the same config schema.** `apps/{api,worker,renderer}/src/config.ts` repeat about 12 fields (Postgres, Neo4j, Redis, S3, SMTP, queues) and the `optional()` helper. Four more entry points read `process.env.POSTGRES_URL` directly.
- **Dev secrets are code defaults** (`S3_SECRET_KEY` defaults to `d4-local-dev`). A misconfigured production deploy would start with them.
- **Hard-coded URLs:**
  - CORS origin (`app.setup.ts:9`).
  - `APP_URL` fallback in `packages/jobs/src/process.ts:92`.
  - Web defaults in `apps/web/src/config.ts`.
  - Keycloak redirect URIs in `deploy/keycloak/d4-realm.json`.
  - e2e helpers.
  - The compose `x-api-env` block.
- **Build-time web config.** The web app's API and OIDC URLs are baked in at build time (`VITE_*`), so one image cannot serve two environments.

### 2.3 Backend code
- **Duplicated bootstrap.** `apps/worker/src/main.ts` and `apps/renderer/src/main.ts` repeat the same code: DB, graph and artefact setup, the logging wrapper around job handlers, the health server, graceful shutdown and `log()`. Only the API has OpenTelemetry.
- **One Nest module for everything.** `AppModule` registers 19 controllers. Webhooks, connectors, backups and admin live in `model/` although they are not model endpoints.
- **Repeated access checks.**
  - `this.admin(p)` is called 22 times across two controllers instead of using a declarative role guard.
  - Workspace scope resolution is repeated per handler, and `open()` helpers are copied between controllers.
- **Stores created per request.** There are 53 `new XStore(this.database.db)` calls instead of injected providers.
- **Request schemas in two places.** Ten controllers define zod schemas inline while others use `http/schemas.ts`. Every handler calls `parse()` by hand.
- **Hand-maintained OpenAPI.** `http/openapi.ts` is a 650-line document kept separate from the routes. A test catches drift, but only after the fact.
- **`@d4/jobs` mixes two jobs.** It holds infrastructure adapters (tenant graph routing, S3, BullMQ, SMTP, provisioning) as well as the job handlers, plus an operator CLI.

### 2.4 Web app
- **`apps/web/src/api.ts` (616 lines) duplicates the SDK.** It hand-writes the types and the fetch client that `@d4/sdk` already generates from OpenAPI, and has its own `ApiError` next to `D4ApiError`.
- **No module boundaries.** Pages import each other (`Queries` → `Catalog`/`QueryStudio`/`Stewardship`, `Admin` → `AdminBackups`/…). Nothing stops one category reaching into another.
- **Repeated hooks.** `useQuery(['me'])` appears in 4 places, and there is no query-key factory.
- **One 2,406-line `styles.css`.** Lines 1–960 are shared (tokens, base, shell, controls, panes, lists); the rest are page sections.
- **CommonJS packages in the browser.** Vite needs `optimizeDeps`/`commonjsOptions` workarounds, and two known pitfalls come from this: the stale pre-bundle and the zod dual-package `ZodError`. Module federation shares ES modules far more reliably than CommonJS.
- **Roadmap exports only in the browser.** CSV and Mermaid export for the roadmap (`roadmap-export.ts`) is implemented in the web app, while every other export format lives in `@d4/codecs`.

---

## 3. Target architecture

```
                         browser  (one origin: D4_PUBLIC_URL, default http://localhost:5173)
                            │
                  ┌─────────▼──────────┐
                  │  gateway (nginx)   │  TLS (prod), security headers, request id, gzip
                  └─┬──────┬──────┬──┬─┘
       /            │      │/api/ │  │/auth/                /mfe/<name>/          /mail/ /grafana/ (dev)
   web-shell ◄──────┘      │      │  └──► keycloak    web-explore  web-queries  web-plan
                           ▼      │                   web-data     web-reporting web-admin
                          api ◄───┘ (GraphQL at /api/graphql)
                           │
     worker ── renderer ── ops (init jobs, operator CLI)
        │         │         │
   postgres · neo4j (+ per-tenant) · redis · s3 · mailpit · otel/tempo/prometheus/grafana
```

Each upstream is `host:port` taken from env. The same gateway routes to a container (`api:3000`) or to a process on the host (`host.containers.internal:3100`), so local and container runs look identical to the browser.

### 3.1 Repository layout after the refactor

```
apps/
  api/ worker/ renderer/        each with its own Containerfile
  ops/                          NEW  operator CLI: migrate, seed, schema, tenant, quota (init jobs use it)
  gateway/                      NEW  nginx: Containerfile, templates/*.conf.template
  web-shell/                    host app (today's apps/web minus the pages)
  web-explore/                  Explorer, element editor, Compare, Matrices
  web-queries/                  Catalog, Query studio, Stewardship
  web-plan/                     Roadmap, Decisions, Proposals
  web-data/                     Import, Connectors, Backups
  web-reporting/                Reports, Jobs
  web-admin/                    Workspaces, People and roles, Webhooks, Usage
  e2e/                          Containerfile; no socat
packages/
  config/                       NEW  zod env fragments, URL derivation, *_FILE secrets
  runtime/                      NEW  logger, telemetry, health server, shutdown, queue-service bootstrap
  infra/                        NEW  split from jobs: TenantGraphs, S3ArtifactStore, JobQueue, SmtpMailer, provisioning
  jobs/                         job handlers only (export, import, render, backup, sync, schedules, webhooks, usage)
  web-platform/                 NEW  auth, SDK-backed client, QueryClient, hooks, module contract, runtime config
  ui-kit/                       + shared components, design tokens and base CSS
  metamodel core cypher graph db codecs render connectors sdk cli   (roles unchanged)
deploy/
  env/                          layered env files (section 4.1)
  compose/                      infra.yaml observability.yaml apps.yaml web.yaml gateway.yaml tools.yaml
  web-static/nginx.conf         one static-file config shared by all web images
  lib/                          common.sh env.sh compose.sh node.sh gateway.sh tenant.sh
  dev-infra.sh dev-deploy.sh dev.sh test.sh
  keycloak/ otel/ grafana/ seaweedfs/
```

---

## 4. Workstreams in detail

### 4.1 Configuration (P1)

**Env files.** The env files are committed and flat: `KEY=value` lines with no interpolation, so bash, compose and `node --env-file` all read them the same way. They are loaded in this order, and later files win:

| File | Committed | Holds |
|---|---|---|
| `deploy/env/common.env` | yes | `D4_PUBLIC_URL`, `GATEWAY_PORT`, service ports, realm and client ids, bucket and queue names, feature flags, resource sizing (`NEO4J_HEAP`, …), image registry and tag |
| `deploy/env/container.env` | yes | Host names as seen inside the Podman network: `POSTGRES_HOST=postgres`, `NEO4J_HOST=neo4j`, `REDIS_HOST=redis`, `S3_HOST=s3`, `SMTP_HOST=mailpit`, `KEYCLOAK_INTERNAL_URL=http://keycloak:8080/auth`, `UPSTREAM_*` |
| `deploy/env/host.env` | yes | The same names as seen from a host process: `localhost` for data stores; Keycloak through the gateway |
| `deploy/env/dev-secrets.env` | yes | The local-only `d4-local-dev` passwords, gathered in one clearly named file instead of spread across compose |
| `deploy/env/local.env` | no (git-ignored) | Personal overrides |

In production the same variable names come from the platform: Podman secrets, Kubernetes, or a vault. Secrets can be given as `NAME_FILE=/run/secrets/name`, which `@d4/config` reads.

**`@d4/config` package.**
- **Fragments.** Composable zod fragments: `http`, `postgres`, `neo4j`, `redis`, `s3`, `oidc`, `smtp`, `queues`, `telemetry`, `publicUrl`. Each app composes only what it needs:
  ```ts
  export const ApiConfig = defineConfig({ ...http, ...postgres, ...neo4j, ...oidc, ...jobs, ...telemetry });
  export const loadApiConfig = () => loadConfig(ApiConfig); // one error listing every bad variable
  ```
- **Derived values.** Computed in one place: `POSTGRES_URL` from host, port, user, password and database (an explicit URL still wins), `OIDC_ISSUER` from `D4_PUBLIC_URL` and the realm, and `APP_URL` = `D4_PUBLIC_URL`.
- **Production guards.** With `D4_ENV=production`, the app refuses to start if `WEBHOOK_ALLOW_PRIVATE=true` or if any secret equals a known dev value. No secret has a default in code.
- **One loader.** Used by `api`, `worker`, `renderer` and `ops`. This removes three `config.ts` copies and four direct `process.env` reads.

**Runtime web config.**
- The shell fetches `/config.json` before rendering. The gateway renders it from env: OIDC authority, client id, API base `/api`, and the remote manifest.
- The `VITE_*` build-time settings and `apps/web/src/config.ts` go away, and one image runs anywhere.
- With a single origin, the defaults are simply relative paths.

**Hard-coded URLs removed:**
- **CORS.** Removed, since the app is same-origin. An optional `CORS_ORIGINS` remains for embedders.
- **`process.ts:92` fallback.** Becomes a required `appUrl`.
- **Realm redirect URIs.** Use Keycloak import placeholders (`${D4_PUBLIC_URL}/*`).
- **e2e.** Takes `E2E_BASE_URL` only.
- **`launch.json`.** Updated.

### 4.2 Podman and Containerfiles (P2)

**Host prerequisites** (checked by `dev-infra.sh doctor`):
- Podman 5.x, rootless.
- A compose provider: `podman-compose` or `docker-compose` v2 used through `podman.socket`.
- cgroup v2 with cpu and memory delegated to the user, so `mem_limit` and `cpus` apply.
- Node 24 for local runs.

Neither Podman nor Node is installed on this machine yet.

**Conversion checklist:**
- **Image names.** Use fully qualified names everywhere (`docker.io/library/postgres:16-alpine`, `quay.io/keycloak/keycloak:…`).
- **Network.** Name it explicitly (`networks: { default: { name: d4 } }`), so `tenant-create` can attach tenant Neo4j containers without guessing `d4_default`.
- **Host address.** `host.docker.internal` becomes `host.containers.internal`.
- **Published ports.** Bind them to `127.0.0.1`. Only the gateway port is meant for a browser; data-store ports stay published for local apps and tools.
- **SELinux.** Add `:Z` to bind mounts, so Fedora and RHEL hosts work. Other hosts ignore it.
- **Health waits.** Scripts wait with their own `wait_healthy` loop (`podman healthcheck run` / `podman inspect`), not with compose `--wait`. The scripts then work with either compose provider and without a systemd user session, which Podman needs to run health checks on its own.
- **Ignore file.** `.containerignore` replaces `.dockerignore`.

**One Containerfile per app.** The build context is the repo root, and each file is self-contained so any app builds on its own. The shared preamble is about 10 lines; that duplication is deliberate, because it keeps the builds independent. Template for a Node service:

```dockerfile
ARG NODE_IMAGE=docker.io/library/node:24-alpine

FROM ${NODE_IMAGE} AS prune
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm dlx turbo@2 prune @d4/api --docker --out-dir /out      # only the workspaces api needs

FROM ${NODE_IMAGE} AS build
RUN corepack enable
WORKDIR /repo
COPY --from=prune /out/json/ .
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY --from=prune /out/full/ .
RUN pnpm turbo run build --filter=@d4/api... && pnpm --filter @d4/api deploy --prod /app

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app .
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --retries=6 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
```

| App | Runtime base | Notes |
|---|---|---|
| `api`, `worker`, `ops` | `node:24-alpine` | Pruned, production dependencies only, non-root |
| `renderer` | Playwright image (glibc) | **Build and run on the same libc.** Install inside a `node:24-bookworm` build stage, not on Alpine |
| `gateway` | `nginxinc/nginx-unprivileged:alpine` | `templates/` rendered by the image's envsubst at start |
| `web-shell`, `web-*` | `nginxinc/nginx-unprivileged:alpine` | Static `dist`, shared `deploy/web-static/nginx.conf`: hashed assets `immutable`; `index.html`, `remoteEntry.js` and `mf-manifest.json` `no-cache` |
| `e2e` | Playwright image | No `socat`; runs on the host network against `D4_PUBLIC_URL` |
| test runner | build stage of a `tools` Containerfile | Used by `test.sh --container` |

**Compose split.** The files are combined per command by `deploy/lib/compose.sh`:

| File | Services |
|---|---|
| `infra.yaml` | postgres, neo4j, redis, s3, keycloak, mailpit, plus the one-shot jobs `ops-migrate`, `ops-schema` and `s3-init` |
| `observability.yaml` | otel-collector, tempo, prometheus, grafana |
| `apps.yaml` | api, worker, renderer |
| `web.yaml` | web-shell and the six remotes |
| `gateway.yaml` | gateway |
| `tools.yaml` | test, e2e |

Memory caps, CPU limits and Neo4j sizing stay, as compose interpolation from `common.env` (`${NEO4J_HEAP}`).

### 4.3 Scripts (P2, with `dev.sh` in P3)

All four scripts source `deploy/lib/*.sh`, which provides:
- env loading (section 4.1);
- the compose wrapper;
- `wait_healthy`;
- Node and pnpm discovery (`.node-version` plus `corepack`, no Homebrew paths);
- `neo4j_hosts`;
- gateway upstream switching;
- consistent logging and usage text.

No environment variable is passed inline any more.

**`deploy/dev-infra.sh`: data stores, identity, observability, operator tasks**

| Command | What it does |
|---|---|
| `up [--obs]` | Start the infrastructure (plus observability), run migrate, schema and buckets, wait until healthy |
| `down` / `reset [--yes]` | Stop / stop and delete volumes (asks first) |
| `status`, `logs <svc>` | Status table, follow logs |
| `migrate`, `schema`, `seed` | One-shot jobs in the `ops` image |
| `tenant create\|list\|check\|suspend\|resume\|delete\|remove\|user …` | Today's `tenant-*` commands under one verb |
| `quota <tenant> [metric=value …]` | Tenant limits |
| `token [user]` | Access token from Keycloak (through the gateway) |
| `doctor` | Podman version, compose provider, cgroup delegation, free ports, Node version |

**`deploy/dev-deploy.sh`: build and run app containers (all by default)**

| Command | What it does |
|---|---|
| `[app…\|backend\|web\|all]` | Build the images and (re)start them; starts infrastructure first if it is down. Apps: `api worker renderer gateway web-shell web-explore web-queries web-plan web-data web-reporting web-admin` |
| `build [app…]` | Build only (used by CI), `--tag`, `--no-cache` |
| `stop [app…]`, `status` | Stop / show what runs, image tag and age |

**`deploy/dev.sh`: run an app (or all) on local Node with hot reload, behind the gateway**

| Command | What it does |
|---|---|
| `<app>… \| all` | Stops those containers, starts the apps on Node (`tsx watch` or Vite HMR) on their dev ports, points their gateway upstreams at `host.containers.internal:<port>` and recreates the gateway (about 1 s). On Ctrl-C a trap restores container routing |
| `status`, `restore [app]` | Which apps are local and which are containers / switch back |
| `cli <args>`, `sample` | `d4` CLI against `${D4_PUBLIC_URL}/api`; import the UBS sample |

Every app gets the same `dev` script contract in its `package.json`, so `dev.sh all` is `turbo run dev --filter=<apps>`. Port 5173 belongs to the gateway, so Vite dev servers use 5174 and up, behind it.

**`deploy/test.sh`: every test, locally or in containers**

| Command | What it does |
|---|---|
| `static` | Typecheck, lint, `knip` |
| `unit [--filter pkg]` | Unit tests, no services (`--local` by default when Node is present, `--container` otherwise) |
| `integration [--filter pkg]` | Postgres, Neo4j, Redis and S3 suites (starts infrastructure if needed) |
| `web` | Web unit tests, typecheck, lint, build |
| `e2e [playwright args]` | Browser tests against the gateway, whatever mix of local and container apps is running |
| `smoke` | Gateway health, `/api/healthz`, login, `/api/v1/me` |
| `all` | `static` → `unit` → `integration` → `e2e`: the pre-commit gate |

To split unit from integration, integration files get an `*.int.test.ts` suffix and run as their own turbo task (`test:int`) with the `D4_TEST_*` pass-through. This replaces today's silent skipping when the env vars are missing.

### 4.4 Gateway (P3)

**`apps/gateway/templates/default.conf.template`** (sketch):

```nginx
resolver ${GATEWAY_RESOLVER} valid=10s ipv6=off;   # resolve per request: a stopped upstream gives 502, never a dead gateway
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
  listen 8080;
  client_max_body_size 25m;                            # API accepts 20 MB model imports
  add_header X-Request-Id $request_id always;
  proxy_set_header X-Request-Id $request_id;
  proxy_set_header X-Forwarded-Proto $scheme;  proxy_set_header X-Forwarded-Host $host;
  proxy_http_version 1.1;  proxy_set_header Upgrade $http_upgrade;  proxy_set_header Connection $connection_upgrade;

  location = /healthz     { return 200 'ok'; }
  location = /config.json { alias /etc/nginx/runtime/config.json; add_header Cache-Control no-store; }

  location /api/  { set $u ${UPSTREAM_API};      rewrite ^/api/(.*)$ /$1 break; proxy_pass http://$u; proxy_read_timeout 120s; }
  location /auth/ { set $u ${UPSTREAM_KEYCLOAK}; proxy_pass http://$u; }
  include /etc/nginx/conf.d/remotes/*.conf;            # one /mfe/<name>/ block per enabled remote, generated from env
  include /etc/nginx/conf.d/dev/*.conf;                # /mail/ and /grafana/ only when D4_ENV=dev
  location /      { set $u ${UPSTREAM_WEB_SHELL};    proxy_pass http://$u; }
}
```

**Paths:**
- **`/api` is stripped before proxying,** so the API keeps its routes (`/v1/...`, `/graphql`, `/healthz`). The OpenAPI document gets `servers: [{ url: '/api' }]`. SDK, CLI and e2e use `${D4_PUBLIC_URL}/api`.
- **Keycloak lives under `/auth`:** `KC_HTTP_RELATIVE_PATH=/auth`, `KC_HOSTNAME=${D4_PUBLIC_URL}/auth`, `KC_PROXY_HEADERS=xforwarded`. The API keeps fetching JWKS on the back channel (`OIDC_JWKS_URI` from `KEYCLOAK_INTERNAL_URL`).
- **Mailpit and Grafana:** `MP_WEBROOT=/mail/`; `GF_SERVER_ROOT_URL` with `GF_SERVER_SERVE_FROM_SUB_PATH=true`.

**Hardening:**
- Security headers: CSP with `script-src 'self'`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`.
- gzip.
- Optional TLS server block from `GATEWAY_TLS_CERT` / `GATEWAY_TLS_KEY`.
- The request id is logged by the API (section 4.5).

**Effects:**
- One browser-facing port. It stays **5173** by default, so the realm, bookmarks and the "port 5173" rule keep working; it is configurable through `GATEWAY_PORT` and `D4_PUBLIC_URL`.
- No CORS.
- The e2e container's four `socat` forwards go away: it runs on the host network and opens `D4_PUBLIC_URL`.
- Local or container apps make no difference to the browser or the tests.

### 4.5 Backend pruning and patterns (P4)

| # | Change | Removes |
|---|---|---|
| 1 | `@d4/config` (section 4.1) in every service and operator tool | 3 `config.ts` copies; direct `process.env` reads |
| 2 | `@d4/runtime`: `startQueueService({ name, queue, concurrency, deps, onTick? })` with health server, shutdown registry, JSON logger (pino) and `startTelemetry(serviceName)` | About 70 duplicated lines in `worker` and `renderer`; adds tracing to both |
| 3 | Split `@d4/jobs` into `@d4/infra` (adapters) and `@d4/jobs` (handlers); move operator commands into `apps/ops` (`d4-ops migrate\|seed\|schema\|tenant\|quota`) | Entry points spread across `db`, `jobs` and `api/scripts`; init jobs no longer need the API image |
| 4 | Nest feature modules: `InfraModule` (global: config, Database, TenantGraphService, JobsInfra, stores), `WorkspacesModule`, `ModelModule`, `CatalogModule`, `JobsModule`, `IntegrationsModule` (webhooks, connectors), `AdminModule` (workspaces, people, usage, backups) | 19 controllers in one module and a mislabelled `model/` folder |
| 5 | `@Roles('admin')` plus `RolesGuard`; `@WorkspaceScope('read'\|'write'\|'review')` parameter decorator that resolves `WorkspaceAccess` and the model handles | 22 `this.admin(p)` calls; the `open()` helpers; repeated `access.resolve` |
| 6 | Stores as injectable singletons provided by `InfraModule` | 53 `new XStore(this.database.db)` calls |
| 7 | `ZodPipe` (`@Body(ZodPipe(CreateElementBody))`); schemas live in `<feature>/<feature>.schemas.ts`; each feature registers its routes in the OpenAPI registry next to the controller | Manual `parse()` calls; the 650-line central `openapi.ts`; inline schemas in 10 controllers |
| 8 | `nestjs-pino` with request id (from the gateway), tenant and user on every line; same JSON shape as the queue services | Unstructured API logs |
| 9 | Move roadmap CSV and Mermaid export into `@d4/codecs`; the web app and scheduled exports share it | Browser-only `roadmap-export.ts` |
| 10 | `InMemoryModelRepository` behind a `@d4/core/testing` subpath export | Test-only code in the public entry |
| 11 | Delete the stale root and API scripts (`infra:*`, `db:schema`, `dev`, `start --env-file`) | Second, broken way to run things |
| 12 | `knip` in `test.sh static` and CI | Dead files, exports and dependencies coming back |

No behaviour changes in P4. The API e2e suite (`apps/api/test`) and the OpenAPI drift test are the safety net.

### 4.6 Web: modular monolith (P5), then module federation (P6)

**P5: make the boundaries real inside `apps/web` first** (no build change):
1. **`packages/web-platform`:**
   - `AuthProvider`/`userManager`;
   - a typed client from `@d4/sdk` (replaces `api.ts` and `ApiError`);
   - the `QueryClient` and a query-key factory;
   - `useMe`, `useAccess`, `useRegistry`, `useView`/`ViewProvider`;
   - the runtime-config loader;
   - the module contract types.
2. **`packages/ui-kit`** receives the shared components (`ErrorBanner`, `ViewBar`, `ParamForm`, `AttributeField`, `ScheduleForm`, `ExportMenu`, `ElementList`, `ElementDetails`) plus the design tokens and base CSS (lines 1–960 of `styles.css`). Page CSS moves next to its module.
3. **Browser-consumed packages ship ESM:** `core`, `metamodel`, `render`, `ui-kit`, `sdk` and `web-platform` get dual ESM/CJS builds (tsup) with `exports` maps. Server apps stay CJS. This removes the Vite `optimizeDeps`/`commonjsOptions` workarounds and the two related pitfalls.
4. **Code moves** into `src/modules/<explore|queries|plan|data|reporting|admin>/`, each with a `module.tsx` descriptor. `NAV` is built from the descriptors, and the sidebar, breadcrumb and Ctrl K keep reading one list.
5. **Import boundaries** are enforced by an ESLint rule (`import/no-restricted-paths`): a module may import `web-platform`, `ui-kit` and domain packages, never another module.
6. **Shared dependency versions** are pinned once with pnpm `catalog:` in `pnpm-workspace.yaml`.

Ship P5 and run the full e2e suite. The UI must be unchanged.

**The module contract** (in `@d4/web-platform`):

```ts
export interface D4Module {
  id: string;                    // 'explore', 'queries', …
  contract: 1;                   // shell refuses unknown majors with a clear notice
  nav: NavGroupContribution;     // group label, order, items (label, icon, to, match, sub, visible)
  routes: RouteObject[];         // relative to /w/:ws; pages are React.lazy chunks
}
```

**P6: extract each module into an MF remote:**
- **Tooling:** `@module-federation/vite` in every web app, with `@module-federation/enhanced/runtime` in the shell for runtime registration. If the Vite plugin's dev mode falls short in the spike, fall back to Rsbuild, which has native Module Federation 2.0.
- **What a remote is:** each remote `apps/web-<name>` exposes `./module` (a small descriptor entry; pages stay lazy chunks inside the remote).
- **What the shell owns:** `/`, `/callback` and the `/w/:ws` layout. At start-up it:
  1. fetches `/config.json` (the remote manifest, from env);
  2. registers the remotes;
  3. loads every `./module` descriptor in parallel with a timeout;
  4. mounts their routes under `/w/:ws`.

  A remote that fails to load shows an "unavailable" notice in its nav group and route (per-remote `ErrorBoundary` plus `Suspense`). The rest of the app keeps working.
- **Navigation across remotes is by URL only.** Legacy redirects (`catalog/:qid`, `studio/:qid`, `stewardship/:qid`) move into the queries remote.

| Shared dependency | Singleton | Reason |
|---|---|---|
| `react`, `react-dom` | yes (strict) | Two copies break hooks |
| `react-router-dom` | yes | One router context |
| `@tanstack/react-query` | yes | One cache across remotes |
| `@d4/web-platform` (wraps `oidc-client-ts`) | yes | One token store and silent renew |
| `@d4/ui-kit` | yes | One theme listener and stylesheet |
| `@d4/core`, `@d4/metamodel` | yes, eager in shell | Large; registry objects cross remote boundaries |
| `cytoscape`, `@tabler/icons-react` | shared, not singleton | Used by some remotes only |

**Independent deployment:**
- Each remote has its own Containerfile and image tag.
- `dev-deploy.sh web-plan` rebuilds and restarts only that container. The shell picks up the new `mf-manifest.json` on the next page load, since manifests and entries are `no-cache` and chunks are hashed.
- Rollback means redeploying the previous tag.
- `dev.sh web-plan` runs that remote with Vite HMR (`base: '/mfe/plan/'`, HMR through the gateway) while the rest stays in containers.

**Tests:**
- Unit tests per remote.
- A contract test that validates every built descriptor against the contract schema.
- New e2e cases:
  - with `web-plan` stopped, the app loads and Plan shows "unavailable";
  - a redeployed remote is picked up without restarting the shell.

---

## 5. Phases, steps and acceptance

### P0: Baseline and guardrails (S)
- Record image sizes, `dev.sh test` duration and the e2e pass list as the baseline.
- Add `knip`; fix or justify findings.
- Move to Node 24 LTS (`engines`, `.node-version`, CI, images).
- **Done when:** all suites pass on Node 24 and `knip` is clean.

### P1: Configuration (M)
- Add `@d4/config` and adopt it in `api`, `worker`, `renderer` and the operator entry points.
- Add the `deploy/env/*` files, delete `.env.example`, and remove the dev-secret defaults from code.
- Add runtime `/config.json` to the web app (served by today's web nginx until P3).
- Remove the hard-coded URLs listed in section 2.2. Template the Keycloak realm.
- **Done when:** `grep -rn "localhost" apps packages --include=*.ts` finds only tests and documented defaults, and the stack runs from env files alone.

### P2: Podman, Containerfiles, compose split, `dev-infra.sh` / `dev-deploy.sh` / `test.sh` (L)
- **Day 1 spike:** compose provider fidelity (profiles, `depends_on` conditions, health checks without systemd) and rootless host access (section 7).
- **Containerfiles:** one per app, with turbo prune, `pnpm deploy`, non-root and fully qualified images. Add `apps/ops`.
- **Compose and scripts:** the six compose files, `deploy/lib`, and the three scripts.
- **Removed:** `Dockerfile`, `docker-compose.yml`, `.dockerignore` and `deploy/dev.sh` (temporarily replaced by a stub that prints the new commands).
- **Done when:**
  - `dev-infra.sh up && dev-deploy.sh && test.sh all` passes on Podman;
  - every image is non-root, and Node images are clearly smaller than the baseline;
  - `dev-deploy.sh api` rebuilds only the API.

### P3: Gateway and `dev.sh` (M)
- **Gateway:** `apps/gateway`. Keycloak moves to `/auth`, the API to `/api`, and CORS is removed.
- **e2e:** host network, `E2E_BASE_URL` only. `deploy/e2e/run.sh` is deleted.
- **`dev.sh`:** local runs with gateway switching.
- **Done when:**
  - `test.sh e2e` passes with everything in containers;
  - it passes again with `dev.sh api web-shell` running locally;
  - only the gateway port is browser-facing.

### P4: Backend pruning (L, parallel with P2–P3)
- Section 4.5, items 2–11, one commit per item. Item 1 lands in P1, item 12 in P0.
- **Done when:** behaviour is unchanged (API e2e and browser suites pass), `knip` is clean, and each item's "Removes" column is true.

### P5: Web modular monolith (M, parallel with P2–P4)
- Section 4.6, P5 steps 1–6.
- **Done when:**
  - the browser suite passes;
  - no module imports another (lint);
  - `api.ts` and the Vite CommonJS workarounds are gone.

### P6: Module federation (L)
- Section 4.6, P6: shell plus six remotes, manifest, per-remote Containerfiles, gateway `/mfe/*` blocks, `dev.sh` and `dev-deploy.sh` support, contract and resilience tests.
- **Done when:**
  - each remote builds, deploys and rolls back alone;
  - stopping any remote leaves the rest usable;
  - the browser suite passes.

### P7: CI and docs (M, runs alongside)
- **CI** (GitHub's Ubuntu runners include Podman): `test.sh static unit integration`, `dev-deploy.sh build`, then `dev-infra.sh up && dev-deploy.sh && test.sh e2e`. This closes the open item "browser tests in CI".
- **Supply chain:** image scan and SBOM, digest-pinned base images for release builds.
- **Docs:** section 9.

---

## 6. Deleted at the end

- **Container and compose files:**
  - `Dockerfile` and `.dockerignore`;
  - `deploy/docker-compose.yml`;
  - `deploy/web/nginx.conf` (now `deploy/web-static/nginx.conf`);
  - `deploy/e2e/run.sh`.
- **Scripts:** `deploy/dev.sh` in its current form (rewritten), the root `package.json` `infra:*`/`db:schema`/`dev` scripts, and the API `dev`/`start --env-file` scripts.
- **Config files:** `.env.example`, `apps/web/src/config.ts`, and `apps/{api,worker,renderer}/src/config.ts` (replaced by `@d4/config`).
- **Code:**
  - `apps/web/src/api.ts` (replaced by the SDK client in `web-platform`);
  - `apps/web/src/roadmap-export.ts` (moved to codecs);
  - operator entry points in `packages/db`, `packages/jobs` and `apps/api/src/scripts` (moved to `apps/ops`);
  - the CORS setup in `app.setup.ts`.
- **Environment workarounds:** the Vite CommonJS workarounds in `apps/web/vite.config.ts`, and the macOS-specific paths in scripts and `.claude/launch.json`.

---

## 7. Risks and spikes

| Risk | Mitigation |
|---|---|
| Compose provider differences under Podman (`depends_on` conditions, profiles; health checks need a systemd user session) | Day 1 spike in P2. Scripts never rely on `--wait` and poll health themselves. Pick and pin one provider in `deploy/lib/compose.sh` |
| Rootless networking: containers reaching apps on the host (`host.containers.internal` with pasta) | Spike in P2. Local apps bind `0.0.0.0` on dev ports, or set pasta host-loopback mapping in `containers.conf`; `doctor` checks it |
| Keycloak under `/auth` changes the token issuer | Expected in dev: one sign-out. Update `auth.spec.ts` URL assertions and the API test issuer together |
| Vite federation plugin maturity (dev mode, shared packages) | ESM builds first (P5). Spike before P6; fall back to Rsbuild |
| MF operating cost: more images, version skew between shell and remotes | Contract version check, catalog-pinned shared versions, resilience e2e. P5 alone already delivers the code-quality benefit if P6 is deferred |
| `pnpm deploy` semantics differ in pnpm 10 | Stay on pnpm 9.12 for this refactor; upgrade separately |
| 8 GB machines | Seven static nginx containers plus the gateway add about 100 MB; existing caps stay |

---

## 8. Production-readiness checklist (cross-cutting)

- [ ] Non-root images and a read-only root filesystem where possible; no secrets in images or code defaults.
- [ ] Secrets through `*_FILE`; the dev-secret guard refuses to start in production.
- [ ] Separate liveness and readiness on every service: `/healthz` and `/readyz`. Worker and renderer get readiness too.
- [ ] Structured JSON logs with request id, tenant and user; OTel traces from api, worker and renderer.
- [ ] Gateway: security headers, body limit, timeouts, TLS option; only the gateway is browser-facing.
- [ ] Data-store ports bound to `127.0.0.1` in dev and not published in production.
- [ ] Reproducible images: frozen lockfile, pinned base images (digests for releases), scan and SBOM in CI.
- [ ] Browser tests in CI against the composed stack.

---

## 9. Docs and decisions to record as phases land

- **Decision log rows** in `PLAN.md`:
  - D31: Podman replaces Docker; one Containerfile per app.
  - D32: single-origin gateway (`/`, `/api`, `/auth`, `/mfe/*`).
  - D33: layered env files and `@d4/config`; runtime web config.
  - D34: module federation with a versioned module contract.
- **ADR 0008, "Gateway and micro-frontends".** It changes D26: the e2e browser reaches the gateway directly, without port forwarding.
- **`DEVELOPER_GUIDE.md`:**
  - §1 rule 8: "Containers (Podman) are the source of truth".
  - §2 repo map.
  - §3 commands and ports: only 5173 for the browser.
  - §6 recipes: new REST endpoint, new web page, which now means "add to a module descriptor".
  - §9 pitfalls: drop the Docker Desktop and Vite pre-bundle rows; add the Podman ones.
- **`CLAUDE.md` essentials and the `README` quick start.**
- **User manual:** `08-reference/shortcuts-and-urls.md` and `troubleshooting.md`, since the URLs change.

---

## 10. Progress and baseline

**Baseline (2026-10-25, before P0):** stack build and start 129 s; `dev.sh test` 115 s, 331 tests passed (1 skipped); browser suite 71 passed in 167 s. Images: api 1.06 GB, worker 1.06 GB, renderer 3.63 GB, web 82 MB, test 1.06 GB, e2e 3.08 GB.

**After P0 + P1 + mocks:** 351 tests passed (new: `@d4/config`, `mocks/s3` contract tests with the AWS SDK, `mocks/smtp` with nodemailer; the jobs S3 integration test now runs against the mock); browser suite 71 passed. Images: api 1.14 GB, worker 1.14 GB, renderer 3.84 GB (Node 24), mock-s3 and mock-smtp 244 MB each (Node base only). Image size reduction is P2's job (pruned per-app images).

Changes beyond the original P1 list:
- Local S3, mail and the bucket job are in-repo mocks (`mocks/s3`, `mocks/smtp`), at the user's request; compose services `s3` and `smtp`.
- `deploy/dev.sh up` now starts the whole default stack (it only started `web` and its dependencies, so the worker and renderer could run stale images).
- `deploy/dev.sh check` runs typecheck, lint and knip.

**After P2 (Podman):** all services run rootless on Podman 5.7 with `podman compose` (Docker Compose v5 as provider). Images: api 355 MB, worker 280 MB, renderer 2.27 GB, web 56 MB, mocks 175 MB each. `test.sh static` clean, 351 tests and 72 browser tests pass (a setup step now provisions every dev user, so the suite passes on a fresh database).

Deviations from the P2 design: no turbo prune (a filtered `pnpm install` plus `pnpm deploy` gives the same pruning with fewer moving parts); the operator image (`apps/ops`) stays in P4, so init jobs still use the API image; unit and integration tests are split by environment (integration suites skip without their services) rather than by renaming files.

**After P3 (gateway):** one browser-facing port (5173, the gateway); the API, Keycloak and the mail inbox are no longer published. `test.sh all` passes: static clean, 351 tests, 72 browser tests through the gateway. The browser suite passes again with the API (plus a worker and renderer on the local queues) running on the host behind the gateway, the path `dev.sh api` uses; this machine has Node 22, so that run used the API image on the host network rather than `tsx watch`, and `dev.sh web` (Vite behind the gateway) is not yet exercised.

Deviations from the P3 design: `/config.json` stays in the web image (served through the gateway) instead of moving to the gateway; no CSP yet (the other security headers are set), since a strict `script-src 'self'` needs checking against Keycloak's pages and the Vite dev server; no TLS server block yet (P7 with deployment); `dev.sh status` is replaced by `dev.sh restore`.

**After P4 (backend pruning):** one commit per item (11, 10, 9, 2, 6, 5, 4, 7, 8, 3 in two parts); `test.sh all` passed before each code commit (static clean, 351 tests, 72 browser tests); the generated OpenAPI document is unchanged. New packages `@d4/runtime` and `@d4/infra`, new app `apps/ops` (image 229 MB).

Deviations from the P4 design: `@Workspace(access)` covers routes whose access is fixed; handlers whose access depends on the request (dry runs) and helpers that also check ownership still call `WorkspaceAccess.resolve`. Controllers' small inline schemas (admin, webhooks, connectors, schedules, backups, catalog) stay in their controllers; only the model's shared schemas moved to `model/model.schemas.ts`. Access is now checked before the query string is validated (a request that is both forbidden and malformed gets 403, not 400).

**After P5 (web modular monolith):** one commit per step (6, 3, 1, 2, 4, 5); `test.sh all` passed before each code commit (static clean, 351+ tests, 72 browser tests). New package `@d4/web-platform`; `@d4/ui-kit` holds the shared components and the base styles; the web app is a shell plus six modules (`apps/web/src/modules/`), each with a `module.tsx` descriptor. `api.ts` and the Vite CommonJS workarounds are gone, and ESLint rejects a module importing another module or the shell. The 68 manual screenshots match the pre-P5 build apart from run-to-run data, and the served CSS keeps the old rule order.

Deviations from the P5 design:
- ESM builds are added next to the existing `tsc` CommonJS builds (tsup emits `dist/*.mjs`), exported under the `browser` condition rather than `import`, so Node and vitest keep loading one (CommonJS) copy of each package. `@d4/metamodel` has a browser entry without its file loaders.
- The base CSS is two files, `@d4/ui-kit/base.css` (tokens, element defaults) and `app.css` (controls, panes, lists, forms, shared components), because the shell's rules sat between them in the old stylesheet; a rule went to `app.css` when another module or a ui-kit component uses its classes, not by line number.
- The boundary rule is ESLint's built-in `no-restricted-imports` (any `..` import from a module), not `import/no-restricted-paths`: no new plugin.
- Using the typed client showed where the OpenAPI document under-described the API (catalog versions, the execution log, `Job.scheduleId`, the `archived` and `status` filters); those are documented now. Responses are unchanged.
- `AdminGate` and the admin workspace list moved down to `ui-kit` and the platform, since the data module's backups and connectors screens use them.
- `test.sh static` now runs two turbo tasks at a time (it was killed for memory on a cold cache).
