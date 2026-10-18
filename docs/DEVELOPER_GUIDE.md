# D4 Developer Guide

Low-level reference for working in this repository: where things live, how a request flows, how to make common changes, how to test, and the pitfalls already hit.

Related documents:
- [`PLAN.md`](PLAN.md): product plan, decision log (D1–D30) and status.
- [`adr/`](adr): architecture decisions.
- [`../README.md`](../README.md): quick start.

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
| 8 | **No local Node is assumed.** Everything builds and runs in Docker via `deploy/dev.sh`. | `Dockerfile`, `deploy/` |
| 9 | Ids are **ULIDs** (26 chars, Crockford base32). | `packages/core/src/ids.ts` |
| 10 | Cypher identifiers (labels, relationship types) are **never interpolated unchecked**; they pass `ident()` and come from the metamodel. | `packages/graph/src/mapping.ts` |

---

## 2. Repository map

```
apps/
  api/        NestJS (Fastify) API: REST + read-only GraphQL, auth, catalog
  web/        React + Vite SPA (explorer, queries workspace), served by nginx in Docker
  e2e/        Playwright browser tests (run in Docker against the live stack)
packages/
  metamodel/  Metamodel schema (zod), loader, registry; starter.yaml
  core/       IO-free domain: types, ULIDs, lifecycle, validity, ModelService, rules,
              planImport, validateModel, InMemoryModelRepository
  cypher/     Schema DDL, catalog checks (params, static checks, EXPLAIN contract,
              content hash), system query packs (packs/system/*.yaml)
  graph/      Neo4j adapter: Neo4jModelRepository, GraphQueries, EXPLAIN explainer,
              catalog runner
  db/         Postgres control plane: Drizzle schema, migrations, stores, local seed
  codecs/     Model-as-code documents (d4/v1): parse, import input, export
  cli/        `d4` command: validate, workspaces, import, export
samples/      ubs-banking.yaml (illustrative sample model)
deploy/       docker-compose, dev.sh, Keycloak realm, SeaweedFS, OTel, nginx, e2e runner
docs/         PLAN.md, ADRs, this guide
```

### Package dependency graph

```
metamodel ◄── core ◄── codecs ◄── cli
    ▲          ▲  ▲
    │          │  └──────────── db (uses ulid, DomainEvent)
  cypher ◄── graph (+ core, metamodel)
    ▲          ▲
    └──── api ─┴── db, codecs, core, metamodel
web ──► core, metamodel (bundled for the browser)
```

- **Module format:** all packages except `web` and `e2e` are **CommonJS** TypeScript (`tsconfig.base.json` uses `NodeNext`), and import each other through `dist/`. Turbo builds dependencies first (`dependsOn: ["^build"]`).
- **Browser use of `@d4/metamodel`:** `web` imports it, so its `load.ts` must not touch `node:fs` at import time. File loading happens only inside `loadStarterMetamodel()`.

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
| API wiring | `apps/api/src/app.module.ts`, `app.setup.ts` (GraphQL plugin) |
| Auth | `apps/api/src/auth/identity.ts`, `auth.service.ts`, `auth.guard.ts` |
| Workspace access | `apps/api/src/model/workspace-access.service.ts` |
| Error → HTTP mapping | `apps/api/src/http/errors.ts` |
| Request schemas + OpenAPI | `apps/api/src/http/schemas.ts`, `openapi.ts` |
| Catalog API | `apps/api/src/catalog/*` |
| Web routes | `apps/web/src/App.tsx` |
| Web API client | `apps/web/src/api.ts` |
| Design tokens / themes | `apps/web/src/styles.css`, `theme.ts` |

---

## 3. Running locally

**Prerequisite:** Docker Desktop with at least 4 GB of memory; 6 GB is recommended.

Everything else runs in containers.

| Command | What it does |
|---|---|
| `deploy/dev.sh up` | Build images, start the core stack and wait for `web` to be healthy. Runs `db-migrate` (migrations + local seed), `neo4j-schema` (DDL) and `s3-init` (buckets) first. |
| `deploy/dev.sh up-obs` | Also start OTel collector, Tempo, Prometheus and Grafana (~1 GB more). |
| `deploy/dev.sh status` / `logs <svc>` | Container status, or follow one service's logs. |
| `deploy/dev.sh down` / `reset` | Stop the stack; `reset` also **deletes all volumes**. |
| `deploy/dev.sh migrate` / `schema` | Re-run Postgres migrations + seed, or Neo4j DDL. |
| `deploy/dev.sh test` | Unit + integration tests in a container (two suites at a time, 1.5 GB cap). |
| `deploy/dev.sh e2e [playwright args]` | Playwright suite against the running stack, e.g. `--grep catalog --retries=0`. |
| `deploy/dev.sh sample` | Import `samples/ubs-banking.yaml` into the `default` workspace (idempotent). |
| `deploy/dev.sh cli <args>` | Run the `d4` CLI in a container; paths are relative to the repo root. |
| `deploy/dev.sh token [user]` | Print an access token (default `dev-admin`). |
| `deploy/dev.sh smoke` | Health checks + login + `/v1/me`. |

### Ports

| Port | Service |
|---|---|
| 5173 | web (**must** be 5173: Keycloak redirect URIs) |
| 3000 | api (`/v1/openapi.json`, `/graphql`) |
| 8080 | keycloak |
| 7474 / 7687 | neo4j |
| 5432 | postgres |
| 6379 | redis |
| 8333 | S3 (SeaweedFS) |
| 3001 | grafana (observability profile) |

### Local users

The password for all of them is `d4-local-dev`. They exist only in the local realm.

| User | Roles |
|---|---|
| `dev-admin` | admin, query-author, query-steward |
| `dev-viewer` | viewer |
| `dev-author` | query-author, viewer |
| `dev-steward` | query-steward, viewer |

### Browser preview in the Claude desktop app

`.claude/launch.json` has two configurations:
- `dev` attaches to the running app at `http://localhost:5173`.
- `stack` runs `docker compose up --build web` in the foreground on 5173.

Do not let the preview move to another port: sign-in will fail there.

### Running a single package's checks

```bash
cd deploy && docker compose -f docker-compose.yml --profile tools run --rm --build test \
  pnpm turbo run test typecheck lint --filter @d4/<package>
```

Integration tests need `D4_TEST_POSTGRES_URL`, `D4_TEST_NEO4J_URL` and `D4_TEST_NEO4J_PASSWORD`. The `test` service sets them, turbo passes them through (`turbo.json`), and suites without them are skipped.

### Changing dependencies (no local pnpm)

Edit the `package.json`, then regenerate the lockfile in a container:

```bash
docker run --rm -v "$PWD":/repo -w /repo node:20-alpine sh -c \
  "corepack enable && corepack prepare pnpm@9.12.0 --activate && pnpm install --lockfile-only"
```

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

| Migration | Contents |
|---|---|
| 0000 | init |
| 0001 | event-log guards, role check |
| 0002 | catalog tables |
| 0003 | catalog guards: immutability and lifecycle trigger, one open draft, search index |
| 0004 | `queries.archived_at` |

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

`WorkspaceAccess.resolve(principal, ws, 'read' | 'write')` loads the workspace for the principal's tenant, returning 404 for other tenants' ids.
- **Read** needs any role.
- **Write** needs contributor, planner, architect or admin, from token roles or workspace role bindings.

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
3. Run `deploy/dev.sh test`. `@d4/metamodel` checks references and the reserved names.
4. Run `deploy/dev.sh schema`. New relationship types change the cross-type id index name, and `applySchema` drops the stale one.
5. If you added a rule, add a `rules:` entry (`acyclic` or `uniqueValuePerTarget`). Both `assertRelationshipRules` and `validateModel` pick it up automatically.

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

1. Add the zod request schema in `apps/api/src/http/schemas.ts`. In the controller, parse with `parse(Schema, body)`.
2. Inject dependencies with **explicit `@Inject(Token)`**; the dev runner emits no decorator metadata.
3. Put access checks and logic in a service. Throw `DomainError` for domain failures and Nest `*Exception`s for HTTP ones; `toErrorResponse` maps both.
4. Register the controller and providers in `app.module.ts`.
5. Document the endpoint in `apps/api/src/http/openapi.ts`.
6. Test it end to end with `apps/api/test/harness.ts` (`startHarness()`), which gives a fresh Postgres database, the real Neo4j and local-signed tokens.

### Add a Postgres table or column

1. Edit `packages/db/src/schema.ts`.
2. Generate the migration in a container:
   ```bash
   docker run --rm -v "$PWD":/src node:20-alpine sh -c 'set -e; corepack enable; corepack prepare pnpm@9.12.0 --activate;
     mkdir /work; cd /src; tar --exclude=node_modules --exclude=.git -cf - . | tar -xf - -C /work;
     cd /work; pnpm install --frozen-lockfile; cd packages/db; pnpm drizzle-kit generate --name <name>;
     cp drizzle/00* /src/packages/db/drizzle/; cp drizzle/meta/* /src/packages/db/drizzle/meta/'
   ```
3. drizzle-kit 0.24 doesn't generate CHECK constraints, triggers or expression indexes. Add them as a `--custom` migration. Index expressions must be **IMMUTABLE**; wrap functions such as `array_to_string`.
4. If the change touches existing local data, check that `db-migrate` still works on the current volume.

### Add a web screen or component

- Use the existing class names and tokens in `styles.css`. Define colours as tokens with light and dark values, never as literals in components.
- Use `useRegistry(ws)` for metamodel-driven UI, and the `api` and `catalogApi` clients in `api.ts`.
- **Give form fields unique ids with `useId()`.** Several query tabs can be mounted at once.
- **List boxes (`select[size]`) need an explicit empty option**, or the browser shows the first option as selected while the value is `''`.
- Graphs: `GraphCanvas` (layouts radial, force or hierarchy; `fitSignal`). It reads tokens at render time and listens for `THEME_EVENT`.
- Routing: `App.tsx`. Query screens are tabs inside `/w/:ws/queries`, with state in `?tabs=mode:id,…&active=…`.

### Add a browser test

- **Location:** `apps/e2e/tests`. Use `signIn(page, 'viewer' | 'author' | 'steward' | 'admin')` and `api()` from `helpers.ts`.
- **Test data:** prefix created data with `RUN` (one token, no hyphens, so full-text search can find it) and clean up with `afterAll` via the API.
- **Ordering:** for multi-step stories use `test.describe.configure({ mode: 'serial' })`.
- **Selectors:** prefer roles and labels, and use `exact: true` for short names. Playwright name matching is a case-insensitive substring match: "Edit" also matches "Cr*edit* Exposure".
- **Graph assertions:** read geometry through the test hook on the graph's DOM node (`el.__cy`); see `layoutStats` in `explorer.spec.ts`.

### Change the Keycloak realm

1. Edit `deploy/keycloak/d4-realm.json`. It's used only on first import into a fresh Keycloak.
2. Apply the same change to the running Keycloak:
   ```bash
   docker exec d4-keycloak-1 /opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080 \
     --realm master --user admin --password d4-local-dev
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
| Browser | `apps/e2e/tests` | 40 | live stack via `deploy/dev.sh e2e` |

- **Order:** run `deploy/dev.sh test` before `deploy/dev.sh e2e`, and both before committing. Type check and lint also run in CI (`.github/workflows/ci.yml`), which starts Postgres and Neo4j services. Browser tests are not in CI yet.
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
| `INTERNAL` | 500 | anything else (logged) |

---

## 9. Pitfalls already hit (and the fix)

| Symptom | Cause | Fix in place |
|---|---|---|
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
| MinIO image pull denied | MinIO stopped publishing images | SeaweedFS for local S3 |

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
  - user-facing behaviour goes in the README
  - decisions go in the PLAN.md decision log (add the next `D<n>` row)
  - structural decisions get an ADR in `docs/adr/`

---

## 11. Open items (as of 2026-10-19)

- Dedicated tests for `packages/graph/src/catalog-runner.ts`: timeout and row cap.
- Browser tests in CI (needs the full stack in the pipeline).
- Batched (`UNWIND`) graph writes for large imports.
- `applySchema` tolerance for concurrent "already exists" during parallel setups.
- Write-class catalog queries (`kind: write`) are modelled but not executable.
- Licensed UBS font to replace the Source Sans 3 stand-in (`--font-sans`).
- Next phase: planning and roadmaps (Phase 3 in PLAN.md).
