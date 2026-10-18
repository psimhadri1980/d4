# D4 — Design-to-Delivery Graph Platform: Plan & Decisions

## Context

We need a platform (plus a reusable core library) that lets teams **capture, decide on, plan, develop and deliver design elements** across an enterprise landscape. The landscape is a **graph**: data products, divisions, applications, platforms, data stores, business processes, capabilities, actors and process steps all relate to each other. Plans and roadmaps are **time-bound changes** to that graph, plus the dependencies between those changes.

Today this knowledge is spread across spreadsheets, EA tools and wikis, so nobody can easily answer *"which processes break if we retire platform X?"*, *"what is the golden copy of Customer data and who distributes it?"* or *"what has to ship before Division Y can go live with data product Z?"*. The goal is one connected model where users can **visualise, query (through a curated Cypher Query Catalog), build and export roadmaps, plans and dependencies** from any angle.

`d4/` is empty, so this is greenfield.

**Decisions (confirmed):**
- **TypeScript end to end** (front end, back end, library, CLI)
- **Neo4j Community Edition** only
- **Cypher is the mandatory query language** for all reads and writes inside the platform. Users **never type Cypher directly**. Instead they browse, search and run **pre-built, curated Cypher queries** from a governed **Query Catalog**, filling in parameters through forms. Only **Query Authors** (power users) write Cypher, and only inside the Query Studio. Their queries are reviewed, versioned and published, then **assigned to RBAC roles or groups**.
- Web app plus a reusable core library
- Multi-tenant SaaS

### What Neo4j Community constrains (and how the design handles it)
| Community limitation | Design response |
|---|---|
| One user database per instance, no multi-database | **One Neo4j Community instance per tenant** (container/StatefulSet), managed by the Tenant Provisioner. This gives hard isolation, which also protects tenants from each other's author-written Cypher. |
| No clustering or read replicas | Scale per tenant vertically. Large tenants get bigger pods. Make the API layer stateless and cache hot query results in Redis. |
| No role-based or fine-grained DB security (one DB user with full rights) | **The database never receives ad-hoc Cypher from end users, so all security lives in the app layer.** The **Query Catalog** is the security boundary (see §1.1): only *published* query versions, identified by id + version + content hash, can be executed. Parameters are always bound, never concatenated. Each query's visibility and execution rights come from app RBAC. The safety checks (read-only via `EXPLAIN`, procedure allow-list, cost estimate) run **at authoring and publish time**. At run time, defence in depth adds: READ session mode for read queries, timeout, row cap, and a hash check that the stored text is unchanged. Write-type catalog entries (e.g. bulk retire) are a separate class that needs Admin approval and runs through the command pipeline so it is audited. |
| No online backup | Scheduled `neo4j-admin database dump` (brief stop) on a replica-free pod, *plus* continuous logical backup from the Postgres event log. A tenant can be rebuilt by replaying events. |
| APOC Core and GDS Community are allowed | Use them for path expansion, subgraph extraction and centrality. |

---

## Decision log

| # | Date | Decision | Rationale / notes |
|---|---|---|---|
| D1 | 2026-10-15 | Deliver a **web app plus a reusable core library** (SDK, CLI, UI kit) | The same domain logic serves the UI, the API, automation and embedding |
| D2 | 2026-10-15 | **Multi-tenant SaaS** | Many organisations on one platform |
| D3 | 2026-10-15 | **TypeScript end to end**, replacing the earlier Rust proposal | One language for front end and back end, with shared types and zod schemas |
| D4 | 2026-10-15 | **Neo4j 5 Community Edition only** | Licensing; the Community limits are handled below |
| D5 | 2026-10-15 | **One Neo4j Community instance per tenant** ([ADR 0001](adr/0001-neo4j-community-per-tenant.md)) | Community has no multi-database or DB-level RBAC, so this gives hard isolation; nodes carry no `tenantId` |
| D6 | 2026-10-15 | **Cypher is the mandatory query language** | Used for all internal reads and writes and for catalog queries |
| D7 | 2026-10-15 | **Users never type Cypher; they run a curated, searchable Query Catalog** ([ADR 0002](adr/0002-curated-cypher-query-catalog.md)) | Query Authors write, Stewards review, publish and grant to roles; published versions are immutable and hashed; the catalog is the security boundary |
| D8 | 2026-10-15 | Physical components are scoped for the **full product, not only an MVP** | See §4 (P1–P7, L1–L7) |
| D9 | 2026-10-15 | **Extensive metamodel**: about 125 node types across 10 layers, with subtypes via `extends` | See §5.2; implemented in `packages/metamodel/starter.yaml` |
| D10 | 2026-10-15 | Data-store roles (Master, Golden Copy, Approved Distributor, Replica, Consumer Cache) are a **property on the `HOLDS` relationship** | One store can play different roles for different data products |
| D11 | 2026-10-15 | Layer labels use a **`Layer` suffix** (e.g. `:ApplicationLayer`) ([ADR 0003](adr/0003-metamodel-driven-labels.md)) | Avoids clashes with type labels such as `Application` |
| D12 | 2026-10-15 | Back end on **NestJS (Fastify)**; local auth via **Keycloak** OIDC; tenant taken **only from the signed `tenant` token claim** | Structured DI and guards; no tenant spoofing |
| D13 | 2026-10-15 | `@d4/core` is deferred to Phase 1; the starter metamodel lives in `packages/metamodel/` | Nothing to hold in core until Phase 1 |
| D14 | 2026-10-17 | MinIO replaced by **SeaweedFS** for local S3 | MinIO no longer publishes container images |
| D15 | 2026-10-17 | `validFrom`/`validTo`/`scenarioId` are **system fields** on elements and relationships, not metamodel attributes | Time travel and rule checks need them uniformly on both |
| D16 | 2026-10-17 | Lifecycle moves forward one step, back one step for rework before LIVE, may retire early before LIVE, LIVE ↔ DEPRECATED; RETIRED is terminal | Encoded in `@d4/core` `lifecycle.ts` |
| D17 | 2026-10-17 | **REST and GraphQL from the start** | GraphQL for graph-shaped reads, REST (OpenAPI) for commands, import/export and webhooks |
| D18 | 2026-10-17 | Control plane uses **Drizzle migrations** (`packages/db/drizzle`) run by a `db-migrate` job; the event log is **append-only**, enforced by a database trigger | Replaces `init.sql`; trustworthy audit trail and outbox |
| D19 | 2026-10-17 | Roles = IdP realm roles **plus** `role_bindings` (user or group, tenant-wide or per workspace) | The IdP stays simple, and workspace-level grants live in D4 |
| D20 | 2026-10-17 | Metamodel attributes are stored as plain Neo4j properties, so names that clash with system fields are reserved (`DEPENDS_ON.type` → `dependencyType`; starter metamodel 0.2.0) | Readable catalog Cypher (`n.name`, `n.lifecycle`) |
| D21 | 2026-10-17 | Graph write and event log are coordinated as described in [ADR 0004](adr/0004-graph-and-event-log-write.md): events inserted in an open Postgres transaction, Neo4j commits with version checks, then Postgres commits | No distributed transaction; the remaining gap is detectable and reconcilable |
| D22 | 2026-10-17 | GraphQL is read-only, authenticates lazily inside resolvers, and maps errors to `extensions.code` matching the REST error codes | One error vocabulary across REST and GraphQL |
| D23 | 2026-10-17 | Model-as-code format `d4/v1`: document `key`s for wiring, ids kept on export; imports match by id → externalKey → type + name, are validated as a whole, applied as one change set, and never delete | Hand-authored files re-import without duplicates; exports round-trip exactly |
| D24 | 2026-10-17 | Sample dataset uses UBS's public divisions with **invented** systems, data and plans, labelled illustrative | Realistic demo without misrepresenting a real bank's internals |
| D25 | 2026-10-18 | Web app uses `react-router` (not TanStack Router), `oidc-client-ts` (PKCE, session storage), and runs `@d4/metamodel` + `@d4/core` in the browser | Forms, relationship options and lifecycle moves follow the exact server rules |
| D26 | 2026-10-18 | Browser tests with **Playwright 1.47** in Docker (`deploy/dev.sh e2e`); the container forwards localhost:5173/8080/3000 to web/keycloak/api so OIDC origins match a developer browser; tests run serially on the dev workspace with `e2erun…`-prefixed data cleaned up after | Real login flow and real API; no test-only auth bypass |
| D27 | 2026-10-19 | Query Catalog runs as a module inside the API for now (`apps/api/src/catalog`), not yet the separate P3 service | Same auth, tenancy and Neo4j routing; split out when load or isolation needs it |
| D28 | 2026-10-19 | Catalog rules: authors draft and submit; stewards review (no self-review except admins), publish, deprecate and grant; system pack installed per tenant as certified, published entries; runs require a grant, a published or deprecated version, a matching fingerprint and valid parameters | ADR 0002 made concrete |
| D29 | 2026-10-19 | Content fingerprints use canonical JSON (keys sorted) | Postgres jsonb reorders keys; fingerprints must survive storage |
| D30 | 2026-10-19 | Web UI follows IBM Carbon principles (productive type scale, 8 px grid, layered greys, dark UI shell, field-style inputs, contained tabs, categorical layer palette) with light (White/G10) and dark (G100) themes plus a System/Light/Dark picker; **Source Sans 3** (OFL) stands in for the licensed UBS brand font, IBM Plex Mono for code | Consistent, accessible look; the brand font can be dropped in later via `--font-sans` without other changes |
| D31 | 2026-10-18 | Roadmap engine is dependency-free in `@d4/core`: whole-day dates, deliverables inclusive `[start, end]`, milestones as points; planned dates are "not earlier than" constraints and dependency pushes are reported as conflicts, never written back | Pure, testable in Node and the browser; the plan stays the user's, the engine only explains it |
| D32 | 2026-10-19 | Optional local Node for the web app: Vite on the host (:5173) against API/Keycloak in Docker, with `web-local`, `web-check`, `e2e-local`; `web-deploy` puts committed changes back into the container. Docker stays the source of truth for CI and other packages | Web iterations in seconds instead of image rebuilds; the dev build also catches StrictMode-only bugs |
| D33 | 2026-10-19 | Model views: reads default to the baseline (items without `scenarioId`) and ignore validity; `asOf` keeps items valid on that date (half-open periods); a scenario view is the baseline plus that scenario, where a scenario relationship of a type between two elements replaces the baseline's relationships of that type between them. Elements are additive. Diffs match by id and pair replaced relationships as changes | Lets a scenario re-date a hand-over without touching the baseline; one rule implemented twice (`applyView` in `@d4/core`, `inView`/`relInView` in Cypher) and tested for agreement |
| D34 | 2026-10-19 | Matrices and the decision log are computed in `@d4/core` from a scoped fetch (only the relationship types a matrix needs, in the model view; lifecycle counts aggregated in Cypher). Each matrix carries findings; overlapping-master checks use validity periods so a planned hand-over is not flagged. Decisions stay ordinary `Decision` elements (no separate store) | Pure, testable shaping; bounded queries instead of whole-workspace snapshots; ADRs are edited with the same metamodel-driven forms as everything else |

## Status

- **Phase 0 scaffold is committed** (`0930be9`):
  - monorepo with CI
  - docker-compose local infrastructure
  - `@d4/metamodel`
  - `@d4/cypher` (schema DDL)
  - `apps/api` skeleton
  - ADRs 0001–0003
- **Not yet verified.** Nothing has been built or tested, because Node, pnpm and Docker weren't installed on the dev machine. Run the README "Getting started" steps to verify.
- **Local Docker stack verified** (`e9c9d07`): all services healthy, smoke test passes.
- **Phase 1a done:** `@d4/core` with element and relationship model, ULIDs, lifecycle, validity periods, `ModelService` commands with events, rule checks, an in-memory repository and whole-model validation. 34 tests pass.
- **Phase 1b done:** `@d4/db` with Drizzle schema and migrations (tenants, Neo4j instances, versioned metamodels, workspaces, users, groups, role bindings, append-only event log with outbox), stores, and an idempotent local seed. 44 tests pass, including 10 Postgres integration tests.
- **Phase 1c done:**
  - `@d4/graph`: Neo4j `ModelRepository` with version-checked writes, plus `GraphQueries` (list, filter, page, full-text search, connections, neighbourhood)
  - API: REST endpoints for elements and relationships (with OpenAPI) and read-only GraphQL
  - users created on first login; Keycloak roles merged with workspace role bindings
  - event history recorded in Postgres
  - 69 tests pass, including 14 end-to-end API tests; checked live through Keycloak
  - CI now runs the Postgres and Neo4j integration tests
- **Phase 1d done:**
  - `planImport` in `@d4/core`
  - `@d4/codecs` (model-as-code documents) and the `@d4/cli` `d4` command (validate, import, export, workspaces)
  - API `import` (with dry run) and `export` endpoints
  - `samples/ubs-banking.yaml` (92 elements, 178 relationships), imported live; the re-import is a no-op
  - 91 tests pass
- **Phase 1e done:**
  - `apps/web`: Keycloak sign-in, search and filters, Cytoscape neighbourhood graph with expand, details panel (relationships, history), metamodel-driven create/edit, add/remove relationships, delete
  - served by nginx on :5173
  - checked live in the browser
  - 97 tests pass
- **Phase 1 (Model) complete.**
- **Browser tests done:** 20 Playwright tests covering sign-in, explorer, editing, relationships and roles; stable across repeated runs.
- **Memory tuning:** Neo4j cap raised to 1.8 GB, and the test container capped at 1.5 GB with two suites at a time, so runs on a 4 GB Docker VM stay inside memory.
- **Known follow-ups:**
  - run the browser tests in CI
  - code-splitting (bundle ~290 KB gzipped)
  - graph layout readability on dense neighbourhoods
  - batched Neo4j writes for large imports
- **Phase 2 progress:**
  - 2a: catalog storage
  - 2b: authoring checks and EXPLAIN
  - 2c: system pack (7 queries)
  - 2d: API (search, detail, drafts, submit, review, version status, grants, executions, run)
  - the catalog runner was written by the project owner
  - 154 tests pass
- **2e done:**
  - web catalog page (parameter forms, results, CSV)
  - Query Studio (drafts with live check results, submit)
  - Stewardship console (review queue with side-by-side Cypher, publish or send back, grants, certification, version lifecycle, run log)
  - local users `dev-author` and `dev-steward`
  - 157 unit/integration tests and 27 browser tests pass
- **Follow-ups done:**
  - draft test runs
  - graph-shaped results (with a lineage graph system query)
  - delete/archive of catalog entries
  - readable explorer layouts (radial, force, hierarchy) with measured readability tests
- **Still open:** dedicated tests for the catalog runner (owner to provide); the runner is exercised end to end, including node, relationship and path conversion.
- **Phase 3 plan:**
  - 3a: roadmap engine in `@d4/core` (cycles, topological order, forward/backward pass for all four dependency types with lags, slack, critical path, lanes, conflicts: cycle, unscheduled, dependency violated, change after retirement, duplicate introduction, past due, done before predecessor)
  - 3b: roadmap API: resolve a scope (initiative, division or catalog query result) to deliverables via `CONTAINS`/`CHANGES`/`DEPENDS_ON`, run the engine, REST + GraphQL
  - 3c: Roadmap Studio in the web app: Gantt with lanes by any aspect, dependency arrows, critical path, conflict list, CSV/Mermaid export
  - 3d: time travel and scenarios: as-of graph, scenario branches, side-by-side diff
  - 3e: matrices (CRUD-I, capability × application, data-store roles, lifecycle heat-map) and decision records
- **3a done:** roadmap engine with 13 tests over the sample client-master plan and edge cases.
- **3b done:**
  - `GraphQueries.planningGraph`: scope roots (initiative, division, deliverable or any changed element) → contained/owned deliverables and milestones, deliverables that change the root or what it owns, their milestones, and transitive `DEPENDS_ON` prerequisites
  - `roadmapFromGraph` in `@d4/core`: lanes by initiative, division, status, type or milestone; change list; new `misses-milestone` conflict
  - `GET /v1/workspaces/{ws}/roadmap` (OpenAPI) and GraphQL `Workspace.roadmap`
  - on the sample: migrate is 30 days too early and misses cut-over by 29 days; critical path is cut-over → decommission
- **3c done:**
  - Roadmap page in the web app (`/w/:ws/roadmap?scope=…&lanes=…&zoom=…`): scope picker (initiatives, divisions, element search), SVG Gantt with lanes, week/month/quarter zoom, today line, dependency arrows, critical path, planned-vs-earliest outlines, conflict list, item details (dates, slack, dependencies, changes) and CSV/Mermaid export
  - roadmap responses now include the dependencies between items
  - 3 web unit tests (exports, Gantt geometry) and 2 browser tests
- **3d done:**
  - `ModelView` (`asOf`, `scenarioId`) with `visibleIn`, `applyView` and `diffModels` in `@d4/core`; the same rule in Cypher (`inView`, `relInView`) on element lists, connections, neighbourhoods and snapshots
  - REST: `asOf` and `scenario` on element list, relationships and neighbourhood; `GET /v1/workspaces/{ws}/diff`; GraphQL arguments and `Workspace.diff`; unknown scenarios → 404, non-Scenario ids → 400
  - web: Explorer "As of" and "Scenario" pickers (kept per tab), a notice while not on today's baseline, scenario badges, new relationships go into the selected scenario, dashed edges relative to the view date; Compare page with swap and shareable URL
  - 4 core, 1 Neo4j, 2 API and 4 browser tests
  - follow-up: deleting a Scenario should remove its items
- **3e done:**
  - `@d4/core`: CRUD-I, capability × application (TIME classes), data store roles and lifecycle heat-map matrices with findings and CSV; `decisionLog` (options, chosen, decided elements, supersession, findings)
  - `GraphQueries.subgraphOf` and `lifecycleCounts`; `GET /v1/workspaces/{ws}/matrix/{kind}` and `/decisions` (REST, OpenAPI, GraphQL), all following `asOf` and `scenario`
  - web: Matrices page (sticky headers, grouped rows, legend, findings, CSV) and Decisions page (search, status filter, record view, "New decision" preselecting the type)
  - fixed the Roadmap scope search squeezing names into the layer-dot column
  - 9 core, 4 Neo4j, 1 API and 4 browser tests
- **Phase 3 (Planning) complete.**

---

## 1. Requirements summary

### Functional
| # | Requirement |
|---|---|
| F1 | **Configurable metamodel**: each tenant defines its own aspect types, relationship types, allowed connections, custom attributes and rules, starting from a seeded starter metamodel. |
| F2 | **Capture**: users enter data through forms, the graph canvas, bulk CSV/Excel import, model-as-code YAML, or the API/SDK. |
| F3 | **Data-store roles per data product**: Master, Golden Copy, Approved Distributor, Replica, Consumer Cache. A store can be master for one product and distributor for another. |
| F4 | **Process ↔ data lineage**: a process step, performed by an actor and supporting a capability, can Create, Read, Update, Inactivate or Delete a data product (CRUD-I matrix). |
| F5 | **Design lifecycle**: Idea → Proposed → Decided → Planned → In Development → Live → Deprecated → Retired, with Decision records (ADR-style). |
| F6 | **Planning**: Initiatives, Deliverables and Milestones that introduce, modify or retire elements, with target dates and dependencies. |
| F7 | **Roadmap extraction**: from any scope, derive ordered deliverables with swim-lanes by any aspect, the critical path, conflicts and cycles. |
| F8 | **Time travel and scenarios**: as-is graph at date T, to-be graph at T+n, and side-by-side comparison of alternative scenarios. |
| F9 | **Query Catalog (curated Cypher)**: a searchable library of mastered, parameterised Cypher queries. Users run them with form-based parameters and get graph, table, matrix or roadmap output. Power users author, test, version and publish queries and assign them to roles (§1.1). |
| F10 | **Visualise**: graph explorer, roadmap/Gantt, matrices and heat-maps. |
| F11 | **Export**: YAML/JSON, CSV/Excel, PNG/SVG, PDF, Mermaid/PlantUML, ArchiMate Open Exchange, Cypher script. |
| F12 | **Governance**: RBAC, audit/history, comments, change proposals with approval, webhooks and connectors. |

### 1.1 Query Catalog: roles and lifecycle

| Role | Can do |
|---|---|
| **Viewer / Contributor / Planner** (basic users) | Search the catalog by name, tags, aspect type, owner or description. Run the queries assigned to their roles, with parameters (element pickers, dates, enums). Pin a query to a dashboard. Use its output as the scope for a roadmap or export. **No Cypher editor.** |
| **Query Author** (power user) | Use the Query Studio: Cypher editor with autocomplete from the tenant schema, test runs against the live DB with row caps, and a declared parameter schema with types, defaults and UI widgets. Declare the result shape (graph / table / tree / roadmap scope). Add documentation and tags. Submit for review. |
| **Query Steward** (reviewer/master) | Review the diff and test results, approve and publish a version, deprecate versions, and **assign or revoke access to roles or groups**. Mark queries as "certified/mastered". |
| **Admin** | Approve write-class queries and manage the system query packs. |

Query lifecycle: **Draft → In Review → Published (vN, immutable, hashed) → Deprecated → Retired**.
- Usages pin to a version or to "latest published".
- The catalog ships **system packs**, for example:
  - impact of retiring X
  - golden-copy lineage of data product Y
  - CRUD-I for process P
  - roadmap scope for division D
  - orphan elements
  - lifecycle risk
- Tenants can extend or override these packs.
- Every execution is logged with user, query version, parameters and duration.

### Non-functional
- Hard tenant isolation, SSO (OIDC/SAML), full audit trail, versioned metamodel.
- Per tenant, plan for about 1M nodes and 5M edges. The explorer should stay under 300 ms for 5k visible elements, and a 6-hop impact query should finish in under 1 s.
- API-first: everything the UI does is also available through the API and SDK.

---

## 2. Technology stack (all TypeScript)

| Concern | Choice |
|---|---|
| Monorepo | **pnpm workspaces + Turborepo**, TS project references, ESLint, Prettier, Vitest |
| Back-end framework | **NestJS** (on Fastify adapter): modules, DI, guards, interceptors |
| API | **GraphQL** (Apollo / NestJS GraphQL) for graph-shaped reads, **REST + OpenAPI** for commands, import/export and webhooks |
| Graph DB | **Neo4j 5 Community** + APOC Core + GDS Community, official **`neo4j-driver`** |
| Cypher tooling | **`@neo4j-cypher/language-support`** for parsing, linting and autocomplete (shared server and browser), and **`@neo4j/cypher-builder`** for programmatic Cypher |
| Control-plane DB | **PostgreSQL** + **Drizzle ORM** |
| Jobs / queue | **BullMQ** + **Redis** (Redis also caches views and query results) |
| Validation / schemas | **zod** (metamodel, DTOs), shared by API and UI |
| Graph algorithms in core | **graphology** (topo-sort, cycles, critical path) |
| Auth | **Keycloak** (or Auth0/Zitadel) via OIDC, `jose` for JWT validation |
| Object storage | S3 / SeaweedFS locally (`@aws-sdk/client-s3`) |
| Front end | **React + Vite**, TanStack Router/Query, **Cytoscape.js** (Sigma.js + graphology for very large graphs), **CodeMirror 6** + Neo4j Cypher language support, custom D3/SVG Gantt, AG Grid, Zustand |
| Exports | `exceljs`, Playwright/headless Chromium (PDF/PNG), `fast-xml-parser` (ArchiMate), Mermaid text |
| Observability | OpenTelemetry JS → Prometheus / Grafana / Tempo / Loki |
| Infra | Docker, Kubernetes + Helm, Terraform, GitHub Actions |

---

## 3. Logical components

```
┌──────────────────────────────── Web UI ───────────────────────────────────┐
│ Explorer │ Editor │ Query Catalog/Studio │ Roadmap Studio │ Matrices │ Import/Export │ Admin │
└───────────────────────────────────┬───────────────────────────────────────┘
                    GraphQL │ REST/OpenAPI │ Webhooks │ SDK
┌───────────────────────────────────┴───────────────────────────────────────┐
│ Identity & tenancy · Model commands · Query (Cypher) · Planning · Jobs     │
├─────────────────────────────── @d4/core ──────────────────────────────────┤
│ Metamodel registry & validator · Element domain · Lifecycle/Decisions      │
│ Planning & Roadmap engine · Temporal/scenario resolver · Cypher templates  │
├───────────────────────────── adapters ────────────────────────────────────┤
│ Neo4j repo (per-tenant conn) · Postgres repo · Redis cache · S3 · Queue    │
└───────────────────────────────────────────────────────────────────────────┘
```

All **writes** go through commands. Each command is validated against the metamodel, applied to Neo4j with generated Cypher, and appended to the Postgres **event log**. The event log is used for audit, history, webhooks and tenant rebuilds.

All **reads** are Cypher. System queries come from templates in `@d4/cypher`. User-facing queries are published Query Catalog entries, executed only by the Query Catalog Service (§1.1, P3).

---

## 4. Physical components to build: scope (full product, not only MVP)

### 4.1 Deployable services (we build these)

| # | Component | Runtime | Full scope |
|---|---|---|---|
| P1 | **Web App** (`apps/web`) | Static SPA on CDN | Model Explorer (expand/filter, layouts, grouping, styling rules, as-of slider, scenario switch). Element Editor (metamodel-driven forms, constrained relationship picker, history, comments, decisions). **Query Catalog** (search by text, tags, aspect and certification; run with parameter forms; results as graph, table, matrix or roadmap scope; favourites; pin to dashboard). **Query Studio**, for the Query Author role only (CodeMirror Cypher editor with schema autocomplete, parameter-schema designer, test run, docs, submit for review). **Steward console** (review diffs, publish/deprecate, assign to roles/groups, usage analytics). **Roadmap Studio** (scope → lanes → Gantt, dependencies, critical path, conflicts, drag-to-reschedule, scenario diff). Matrices (CRUD-I, capability × app, data-store roles, lifecycle heat-map). Import wizard with column mapping and dry run. Export center. Admin (members, roles, metamodel editor, API keys, webhooks, connectors). Dashboards. Notifications. |
| P2 | **API Service** (`apps/api`) | NestJS, stateless pods | AuthN (OIDC/JWT, API keys) and AuthZ (RBAC: Viewer, Contributor, Architect, Planner, Admin, at workspace level). Tenant resolution → connection routing. GraphQL schema for elements, relationships, views and roadmaps. REST commands. Metamodel validation. Lifecycle workflow and change proposals (draft → review → publish). Comments. Event log writer (outbox). Webhooks dispatch enqueue. Rate limiting. OpenAPI and GraphQL schema publishing for the SDK. |
| P3 | **Query Catalog Service** (`apps/query`) | NestJS, separate pods (isolated failure and CPU) | **Catalog**: CRUD for query definitions, immutable versions with content hash, parameter schemas (zod/JSON-Schema → UI form), result-shape descriptors, tags and docs, full-text search (Postgres `tsvector`), certification flag, system packs and tenant overrides. **Governance**: Draft → Review → Publish → Deprecate workflow, steward approvals, role/group assignments, version pinning. **Authoring checks** (at test and publish time): parse and lint with the Cypher language-support library, `EXPLAIN` read/write classification, procedure allow-list, banned clauses (`LOAD CSV`, `dbms.*`), `PROFILE` cost estimate, mandatory `LIMIT` or paging. **Execution**: authorise (user role ∈ query grants), verify hash, bind and validate params, inject as-of/scenario parameters, READ session, timeout, row/byte caps, shape the result into graph/table/tree/roadmap scope, cache in Redis, log the execution. Write-class queries go to P2's command pipeline. |
| P4 | **Worker** (`apps/worker`) | Node + BullMQ consumers | Bulk import (CSV/Excel/YAML/ArchiMate) with mapping and validation reports. Roadmap computation for large scopes. Scheduled snapshots. Webhook delivery with retries. Notifications (email/Slack/Teams). Search index refresh. Metamodel migrations (rename type or attribute across the graph). |
| P5 | **Export Renderer** (`apps/renderer`) | Node + headless Chromium | Server-side rendering of graph views and roadmaps to PDF/PNG/SVG using the same React components as the UI. Branded report templates. Scheduled report distribution. Excel workbooks. ArchiMate XML, Mermaid/PlantUML and Cypher-script exports. Artefacts go to S3 with signed URLs. |
| P6 | **Tenant Provisioner / Control Plane** (`apps/control-plane`) | NestJS + K8s API client | Tenant sign-up and onboarding. Creates a **per-tenant Neo4j Community StatefulSet + PVC + secret**, applies schema (constraints/indexes) and seeds the starter metamodel. Resizes plans, suspends and deletes tenants. Scheduled dump backups to S3, restore, and rebuild from the event log. Neo4j version upgrades. Quotas and usage metering (nodes, queries, storage) → billing hooks. Health monitoring of tenant DBs. |
| P7 | **Connector Hub** (`apps/connectors`) | Worker-style service | Pluggable inbound/outbound sync: DataHub/Collibra (data products, lineage), ServiceNow CMDB (applications, platforms), LeanIX/Ardoq (capabilities), Jira/Azure DevOps (deliverables ↔ epics, status sync), Git (model-as-code repos). Scheduled and webhook-triggered runs. Mapping config per tenant. Conflict reporting. |

### 4.2 Libraries and tools (we build and publish these)

| # | Package | Full scope |
|---|---|---|
| L1 | **`@d4/core`** | Pure TS domain with no IO, running in Node and the browser. Element/relationship types, metamodel registry and rule validator, lifecycle state machine, planning model, **roadmap engine** (DAG build, cycle detection, topo-sort, scheduling, critical path, conflict rules), temporal/scenario resolution, diffing of two graph states. |
| L2 | **`@d4/metamodel`** | zod schemas for the metamodel DSL, the starter metamodel (`starter.yaml`), industry packs (banking, insurance) and metamodel versioning/migration descriptors. |
| L3 | **`@d4/cypher`** | Internal Cypher templates for every system read and write (built with cypher-builder). **System query packs** stored as `.cypher` files plus YAML metadata (params, result shape, tags, docs), with tests. Temporal and scenario parameter conventions. Authoring-check utilities (lint, classify, allow-list) used by P3. Schema introspection. Schema DDL (constraints/indexes). |
| L4 | **`@d4/codecs`** | Import/export codecs: YAML/JSON model-as-code, CSV/Excel, ArchiMate Open Exchange, Mermaid/PlantUML, Cypher script, plus round-trip guarantees. |
| L5 | **`@d4/sdk`** | Typed client generated from GraphQL/OpenAPI (graphql-codegen, openapi-typescript), with auth helpers and pagination. |
| L6 | **`@d4/cli`** | `d4 validate \| import \| export \| run <catalog-query> --param k=v \| diff \| roadmap`, plus `d4 queries push/test` so Query Authors can manage query packs as code in Git through the same review flow. Supports model-as-code in Git and CI usage. |
| L7 | **`@d4/ui-kit`** | Reusable React components: GraphCanvas (Cytoscape wrapper), RoadmapGantt, Matrix, CypherEditor, ElementForm. Used by the web app and the export renderer, and embeddable by other apps. |

### 4.3 Infrastructure we deploy and configure (not build)
- Neo4j Community 5 (one instance per tenant, APOC Core + GDS Community plugins)
- PostgreSQL (control plane, event log; managed HA)
- Redis (queue + cache)
- S3 (SeaweedFS locally)
- Keycloak (IdP, per-tenant realms or organisations)
- Ingress / API gateway (TLS, WAF, rate limits)
- CDN
- OTel collector + Prometheus/Grafana/Tempo/Loki
- Kubernetes with Helm charts per service, Terraform for cloud resources

### 4.4 Topology

```
Browser ─▶ CDN (P1 SPA)
        ─▶ Ingress ─┬─▶ P2 API ───────────┬─▶ Tenant Neo4j (per tenant, Community)
                    ├─▶ P3 Query Service ─┘
                    └─▶ P6 Control Plane ──▶ K8s API (provision Neo4j pods)
P2/P3/P6 ─▶ PostgreSQL (tenants, users, RBAC, metamodels, events, views)
P2 ─▶ Redis/BullMQ ─▶ P4 Worker · P5 Renderer · P7 Connectors ─▶ S3
All ─▶ OTel collector;  P2/P3/P6 ─▶ Keycloak (JWKS)
```

---

## 5. Graph data model (Neo4j)

Because each tenant has its own instance, nodes don't need `tenantId`. `workspaceId` separates multiple models inside a tenant.

### 5.1 Common node properties
`id` (ULID, unique constraint), `workspaceId`, `type`, `name`, `description`, `lifecycle`, `ownerId`, `tags[]`, custom attrs (typed properties defined by the metamodel), `validFrom`, `validTo`, `scenarioId` (null means baseline), `version`, `createdAt/By`, `updatedAt/By`, `deleted`.

Every node also has the generic label `:Element`.

### 5.2 Node labels (starter metamodel; extensible per tenant)

All nodes carry `:Element` plus a **layer label**: `:StrategyLayer`, `:OrganisationLayer`, `:BusinessLayer`, `:DataLayer`, `:ApplicationLayer`, `:TechnologyLayer`, `:GovernanceLayer`, `:DesignLayer`, `:PlanningLayer` or `:SystemLayer` (the `Layer` suffix avoids clashes with type labels such as `Application`; see ADR 0003). This makes layer-wide catalog queries cheap. Tenants can add, rename or hide labels through the metamodel.

**A. Strategy & motivation (`:StrategyLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Vision` | Long-term aspiration; `horizon` |
| `Goal` | Measurable objective; `targetDate`, `kpiRef` |
| `Objective` / `KeyResult` | OKR decomposition; `metric`, `baseline`, `target` |
| `Driver` | Internal or external force (market, cost, risk) |
| `Principle` | Architecture or data principle that constrains design |
| `Outcome` | Business result expected from change; `valueEstimate` |
| `KPI` | Metric definition; `unit`, `formula`, `frequency` |
| `ValueStream` / `ValueStreamStage` | End-to-end value delivery; `seq` |
| `Product` / `Service` (business) | What is offered to customers; `channel`, `segment` |
| `CustomerSegment` / `Market` | Who is served; `region` |

**B. Organisation (`:OrganisationLayer`)**
| Label | Meaning / key properties |
|---|---|
| `LegalEntity` | Regulated entity; `jurisdiction`, `lei` |
| `Division` / `BusinessUnit` / `Department` | Hierarchical org units; `costCenter` |
| `Team` | Delivery or ownership team; `type` (stream-aligned, platform…) |
| `Actor` | Role, person, system actor or external party; `actorKind` |
| `Role` | Business role (e.g. Data Owner, Data Steward, Process Owner) |
| `Person` | Named individual (minimal PII: name, email ref) |
| `Location` / `Site` / `Region` | Physical or geo placement; `country`, `dataResidencyZone` |
| `Vendor` / `Partner` | Third parties; `contractRef`, `riskTier` |
| `Contract` | Agreement with a vendor or partner; `startDate`, `endDate`, `cost` |

**C. Business architecture (`:BusinessLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Capability` | Hierarchical (L0–L3) ability; `level`, `maturity`, `strategicImportance` |
| `BusinessFunction` | Organisational grouping of behaviour |
| `BusinessProcess` | End-to-end process; `processLevel`, `frequency`, `bpmnRef` |
| `SubProcess` | Nested process |
| `ProcessStep` / `Activity` | Atomic step; `seq`, `automationLevel` (manual / semi / auto) |
| `BusinessEvent` | Trigger or result (e.g. "Account Opened") |
| `BusinessRule` / `Decision Table` | Rule applied in a step; `dmnRef` |
| `BusinessObject` | Conceptual business concept (Customer, Account, Trade) |
| `Channel` | Interaction channel (web, branch, API) |
| `UseCase` / `UserJourney` | Scenario of use; `persona` |

**D. Data (`:DataLayer`)**
| Label | Meaning / key properties |
|---|---|
| `DataDomain` / `SubDomain` | Ownership boundary for data |
| `DataProduct` | Governed, consumable data asset; `productType` (source-aligned / aggregate / consumer-aligned), `sla`, `qualityScore`, `classification` |
| `DataContract` | Interface spec of a data product; `schemaRef`, `version`, `sla`, `freshness` |
| `DataSet` / `Table` / `Topic` / `File` / `APIResource` | Physical data assets inside a store; `format`, `rowCount` |
| `DataEntity` (logical) | Logical entity in the data model; `keyAttributes` |
| `DataAttribute` / `CriticalDataElement` | Attribute-level detail; `isCDE`, `piiType` |
| `ReferenceData` / `CodeSet` | Shared code lists |
| `DataStore` | Database, lake, warehouse, file share or stream; `category` (Operational / Analytical / Archive / Streaming), `technology`, `environment` |
| `DataClassification` | Confidentiality or sensitivity class (Public, Internal, Confidential, Restricted, PII, PCI) |
| `DataQualityRule` / `DataQualityMetric` | DQ checks; `dimension`, `threshold` |
| `Pipeline` / `DataFlow` / `Job` | Movement or transformation; `schedule`, `tool` |
| `Report` / `Dashboard` / `MLModel` | Data consumers; `tool`, `audience` |
| `GlossaryTerm` | Business definition linked to entities and attributes |

Data-store *role per product* (Master, Golden Copy, Approved Distributor, Replica, Consumer Cache) stays a **relationship property** on `HOLDS`, not a label.

**E. Application (`:ApplicationLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Application` | Business application; `appId`, `criticality`, `hosting` (SaaS / on-prem / cloud), `TIMEClass` (Tolerate / Invest / Migrate / Eliminate) |
| `ApplicationComponent` / `Microservice` | Deployable part of an app |
| `ApplicationService` | Functionality exposed by an app |
| `Interface` / `API` | Integration endpoint; `protocol`, `style` (REST / event / file), `version` |
| `Event` / `MessageSchema` | Event-driven contracts |
| `Integration` | Point-to-point or middleware flow; `pattern` |
| `SoftwareProduct` | Commercial or OSS product and version; `vendor`, `eolDate` |

**F. Technology & platform (`:TechnologyLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Platform` | Shared runtime or data platform (e.g. Snowflake, K8s, Kafka); `platformType`, `owner` |
| `PlatformService` | Capability offered by a platform |
| `Environment` | Dev / Test / Prod; `region` |
| `InfrastructureNode` / `Cluster` / `Server` | Compute; `provider` |
| `CloudAccount` / `Subscription` | Cloud tenancy |
| `Network` / `Zone` | Network segmentation |
| `TechnologyStandard` | Approved tech (radar status: Adopt / Trial / Assess / Hold) |

**G. Governance, risk & compliance (`:GovernanceLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Policy` / `Standard` | Internal rule; `version` |
| `Regulation` / `RegulatoryRequirement` | External obligation (GDPR, BCBS 239, DORA…) |
| `Control` | Control implementing a policy; `controlType`, `effectiveness` |
| `Risk` | Identified risk; `likelihood`, `impact`, `rating` |
| `Issue` / `Finding` | Audit or DQ findings; `severity`, `dueDate` |
| `Exception` / `Waiver` | Approved deviation; `expiry` |
| `Decision` | ADR-style decision; `status`, `context`, `consequences`, `decidedOn` |
| `Assumption` / `Constraint` | Design assumptions and constraints |

**H. Design (`:DesignLayer`)**
| Label | Meaning / key properties |
|---|---|
| `DesignElement` | Generic captured design item; `designKind` |
| `Requirement` | Functional or non-functional; `priority` (MoSCoW), `acceptanceCriteria` |
| `Epic` / `Feature` / `UserStory` | Backlog items (syncable with Jira/ADO); `externalKey` |
| `ArchitectureView` / `Diagram` | Saved visual composition; `queryRef` |
| `Pattern` / `ReferenceArchitecture` | Reusable solution template |
| `Option` | Alternative evaluated within a Decision |

**I. Planning & delivery (`:PlanningLayer`)**
| Label | Meaning / key properties |
|---|---|
| `Portfolio` / `Program` | Grouping of initiatives; `budget` |
| `Initiative` / `Project` | Funded change; `startDate`, `endDate`, `status`, `budget`, `sponsor` |
| `WorkPackage` / `Deliverable` | Unit of change that alters elements; `plannedStart`, `plannedEnd`, `actualEnd`, `status`, `effort` |
| `Milestone` / `Gate` | Checkpoint; `date`, `gateType` |
| `Release` / `Increment` / `Sprint` | Delivery cadence; `date` |
| `Plateau` / `TransitionState` | Named architecture state at a point in time (as-is, T1, T2, to-be) |
| `Scenario` | Alternative plan branch; `baseScenario`, `status` |
| `Dependency` (reified, optional) | When a dependency needs its own lifecycle, owner or comments |
| `Resource` / `Capacity` | Team capacity for scheduling; `fte`, `period` |
| `Cost` / `Benefit` | Financial attributes tied to initiatives and elements |

**J. System (`:SystemLayer`, internal, not user-visible)**
- `:MetaType`, which mirrors the metamodel for in-graph introspection queries
- `:Tag`, a shared taxonomy node for tags with hierarchy
- `:Snapshot`, which records snapshot and baseline markers

### 5.2.1 Additional relationships for extended labels (excerpt)
```
(Goal)-[:REALIZED_BY]->(Initiative|Capability)   (Driver)-[:MOTIVATES]->(Goal)
(Principle)-[:CONSTRAINS]->(:Element)            (KPI)-[:MEASURES]->(Goal|Capability|DataProduct)
(ValueStreamStage)-[:ENABLED_BY]->(Capability)   (LegalEntity)-[:HAS_UNIT]->(Division)
(Role)-[:ACCOUNTABLE_FOR {raci}]->(:Element)     (Person)-[:PLAYS]->(Role)
(DataProduct)-[:EXPOSES]->(DataContract)-[:DESCRIBES]->(DataSet)
(DataEntity)-[:HAS_ATTRIBUTE]->(DataAttribute)-[:CLASSIFIED_AS]->(DataClassification)
(GlossaryTerm)-[:DEFINES]->(DataEntity|DataAttribute)
(Pipeline)-[:READS]->(DataSet)  (Pipeline)-[:WRITES]->(DataSet)  (DataSet)-[:STORED_IN]->(DataStore)
(Report|MLModel)-[:CONSUMES]->(DataProduct)
(Regulation)-[:REQUIRES]->(Control)-[:MITIGATES]->(Risk)-[:AFFECTS]->(:Element)
(Requirement)-[:SATISFIED_BY]->(:Element)        (Epic)-[:IMPLEMENTS]->(Deliverable)
(Plateau)-[:INCLUDES]->(:Element)                (Deliverable)-[:TRANSITIONS {from,to}]->(Plateau)
(Application)-[:DEPLOYED_IN]->(Environment)-[:HOSTED_ON]->(Platform)
(SoftwareProduct)<-[:BUILT_ON]-(Application)     (Vendor)-[:SUPPLIES]->(SoftwareProduct|Platform)
```

### 5.3 Relationships
```
(Division)-[:OWNS]->(DataProduct|Application|Platform|BusinessProcess)
(Capability)-[:PARENT_OF]->(Capability)
(BusinessProcess)-[:SUPPORTS]->(Capability)
(BusinessProcess)-[:HAS_STEP {seq}]->(ProcessStep)-[:NEXT]->(ProcessStep)
(ProcessStep)-[:PERFORMED_BY]->(Actor)
(ProcessStep)-[:ACTS_ON {op: CREATE|READ|UPDATE|INACTIVATE|DELETE}]->(DataProduct)
(DataProduct)-[:IN_DOMAIN]->(DataDomain)
(DataProduct)-[:DERIVED_FROM]->(DataProduct)
(DataStore)-[:HOLDS {role: MASTER|GOLDEN_COPY|APPROVED_DISTRIBUTOR|REPLICA|CONSUMER_CACHE}]->(DataProduct)
(DataStore)-[:FEEDS {mode: BATCH|STREAM|API}]->(DataStore)
(Application)-[:REALIZES]->(Capability)
(Application)-[:USES {op}]->(DataStore)
(Application|DataStore)-[:RUNS_ON]->(Platform)
(Application)-[:INTEGRATES_WITH]->(Application)
(Decision)-[:DECIDES]->(:Element)   (Decision)-[:SUPERSEDES]->(Decision)
(Initiative)-[:CONTAINS]->(Deliverable)-[:PART_OF]->(Milestone)
(Deliverable)-[:CHANGES {action: INTRODUCE|MODIFY|RETIRE, targetLifecycle}]->(:Element)
(Deliverable)-[:DEPENDS_ON {dependencyType: FS|SS, lagDays}]->(Deliverable)
```
Relationships carry `id`, `validFrom/validTo` and `scenarioId`, so they are time-aware and scenario-aware.

Schema DDL in `@d4/cypher` covers:
- uniqueness constraints on `id` per label
- range indexes on `(workspaceId, type)` and `lifecycle`
- full-text index on `name` and `description`

**Rules enforced by the validator** (examples):
- at most one MASTER and one GOLDEN_COPY per DataProduct per validity period
- `ACTS_ON` only goes from ProcessStep to DataProduct
- no `DEPENDS_ON` cycles

### 5.4 Roadmap derivation
1. Resolve the scope (a Cypher view) to a set of elements.
2. Expand to the Deliverables that `CHANGE` them, plus the transitive `DEPENDS_ON` closure.
3. `@d4/core` roadmap engine:
   - cycle detection
   - topological order
   - scheduling
   - critical path
   - conflict rules (e.g. retiring a platform before its dependants migrate, or overlapping golden copies)
4. Group into lanes by any aspect → Gantt → export.

### 5.5 Control plane (Postgres)
`tenants`, `tenant_db_instances`, `workspaces`, `users`, `groups`, `roles`, `memberships`, `api_keys`, `metamodels` (versioned), `queries`, `query_versions` (cypher, hash, param_schema, result_shape, status), `query_grants` (role/group), `query_reviews`, `query_executions`, `events` (audit/outbox), `change_proposals`, `comments`, `jobs`, `exports`, `connectors`, `webhooks`, `usage_metrics`.

---

## 6. Repository layout

```
d4/
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
  apps/   web  api  query  worker  renderer  control-plane  connectors
  packages/  core  metamodel  cypher  codecs  sdk  cli  ui-kit  config(eslint/tsconfig)
  packages/metamodel/starter.yaml  samples/bank.yaml
  deploy/docker-compose.yml   # neo4j:5-community(+APOC,GDS), postgres, redis, seaweedfs (s3), keycloak
  deploy/helm/  deploy/terraform/
  docs/adr/
```

---

## 7. Delivery roadmap (full scope, phased)

| Phase | Content |
|---|---|
| **0 Foundations** | Monorepo, CI, docker-compose, Keycloak auth, OTel, Neo4j schema bootstrap, control-plane skeleton (single tenant locally) |
| **1 Model** | L1/L2/L3 basics, P2 CRUD + event log, P1 Explorer + Editor, YAML import/export (L4, L6) |
| **2 Query Catalog** | P3 catalog + governance + execution, system query packs, Catalog UI for users, Query Studio + Steward console, role assignments |
| **3 Planning** | Lifecycle, Decisions, Initiatives/Deliverables, roadmap engine, temporal and scenarios, Roadmap Studio, matrices |
| **4 Delivery outputs** | P4 Worker imports, P5 Renderer (PDF/PNG/Excel/ArchiMate/Mermaid), scheduled reports |
| **5 SaaS** | P6 per-tenant Neo4j provisioning, backups/restore/rebuild, quotas/metering/billing, change proposals, webhooks, L5 SDK, L7 ui-kit publishing |
| **6 Ecosystem** | P7 connectors (DataHub, Collibra, ServiceNow, LeanIX, Jira/ADO, Git), industry metamodel packs, performance tuning for 1M-node tenants |

---

## 8. Verification

- **Unit tests** (Vitest + fast-check) in `@d4/core`: metamodel rules, lifecycle transitions, roadmap engine (cycles, ordering, critical path, conflicts).
- **Query Catalog tests**:
  - a basic user can only see and run queries granted to their roles
  - no API accepts raw Cypher from non-authors
  - unpublished or tampered (hash mismatch) versions are refused
  - publish-time checks reject a corpus of write or unsafe queries (`CREATE`, `MERGE`, `DELETE`, `CALL dbms.*`, `LOAD CSV`, `apoc.periodic.*`)
  - param validation, timeouts and row caps are enforced
  - every system-pack query has a test against the seed dataset
- **Integration tests** with Testcontainers (`neo4j:5-community`, Postgres, Redis): repositories, API, Query Service.
- **Isolation test**: provision two tenants via P6 and assert that no credential or route can reach the other tenant's instance.
- **Seed scenario** (`samples/bank.yaml`), imported with `d4 import`:
  - Explorer shows the master/golden/distributor lineage
  - the CRUD-I matrix is correct
  - the roadmap for "Division Retail" shows the critical path
  - export → re-import round-trips to an identical graph
- **E2E** (Playwright): create element → run a catalog query → extract roadmap → export PDF.
- **Performance**: a synthetic 1M-node tenant meets the explorer and 6-hop impact latency targets.
- **Backup drill**: dump → restore, and rebuild from the event log, give an identical graph checksum.
