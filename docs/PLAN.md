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
| D35 | 2026-10-19 | Export formats are pure functions in `@d4/codecs` (CSV, Mermaid, ArchiMate Open Exchange 3.1, Cypher script) over a snapshot, served by the existing export endpoint with `format`, `scope`/`depth` and the model view. ArchiMate uses specific relationship types only where the meaning is unambiguous (Realization, Composition, Triggering, Access, Assignment); the rest are Association named after the D4 type, and unmapped element types are skipped and listed | Deterministic, testable files with no new dependencies; imports into Archi and similar tools without being rejected for invalid relationship combinations |
| D36 | 2026-10-19 | Spreadsheet import is analyze → mapping → dry run → apply over the existing `planImport`: per-table mappings (elements or relationships, optional type for the sheet, a field per column), references resolved as import key → id → externalKey → name ("Type: Name" when ambiguous), and any row problem blocks the whole import. Excel is also an export format with the same columns, so exports round-trip | One validation and matching path for every import; users fix sheets row by row instead of finding half an import applied |
| D37 | 2026-10-19 | Background jobs: a Postgres `jobs` table is the durable record (status, progress, result, artefact); BullMQ in Redis carries only `{tenantId, jobId}` with the job id as queue id; artefacts (uploads, export files) live in S3 and are downloaded through the API. Validation errors fail a job at once; other errors retry (3 attempts, exponential back-off); finished jobs ignore redeliveries. Jobs act as the submitting user, whose access is checked at submission. The export and tabular-import work lives in `@d4/jobs`, shared by the API's direct endpoints and the worker | Tenant isolation and audit stay in Postgres; Redis can be flushed without losing history; one implementation for direct and background work |
| D38 | 2026-10-19 | Pictures are drawn as SVG by pure code (`@d4/render`: Gantt geometry shared with the web chart, deterministic radial graph layout, fixed light theme); headless Chromium only converts SVG to PNG/PDF, in a separate renderer service on its own queue, built from the Playwright image. Pages are static (no scripts, no network) with the brand stand-in font inlined | No auth or app state in the renderer; identical output in tests and production; Chromium's memory and image size limited to one service |
| D39 | 2026-10-19 | Scheduled reports: a Postgres `schedules` row (job kind and parameters, a UTC daily/weekly/monthly cadence, owner, next run); every worker polls every 30 s and claims due rows with `FOR UPDATE SKIP LOCKED`, advancing `next_run_at` in the same transaction; each run is an ordinary job owned by the schedule's owner (`jobs.schedule_id`). Missed runs run once, not catch-up. Runs can use the run date (as-of, or roadmap "today"). Delivery is via Jobs/Reports for now | No extra scheduler service or Redis repeatables to keep in sync; safe with several workers; runs reuse the job path, permissions and artefacts |
| D40 | 2026-10-19 | Scheduled runs re-check the owner's access (tenant active, workspace live, user present, a role from realm roles stored at last sign-in or current bindings) and pause the schedule with a reason when it fails. Report emails go through SMTP (Mailpit locally) with the file attached up to 5 MB, otherwise a link; delivery problems are recorded on the job, never fail it. Import uploads are deleted when the import ends; other files expire after `ARTIFACT_RETENTION_DAYS` (30) and job records keep an `artifactExpired` marker | Background work cannot outlive a person's access; people get reports where they read them; stored data is bounded |
| D41 | 2026-10-19 | Tenant administration is admin-only under `/v1/admin`: workspaces are created on the tenant's active metamodel, renamed, archived and restored (never deleted); role bindings are granted and revoked per workspace or tenant-wide, only for users who have signed in; an admin cannot remove their own tenant-wide admin binding | Day-to-day tenant operations without database access; archiving keeps data and history; a guard against locking the tenant out |
| D42 | 2026-10-20 | Webhooks are fed by an outbox relay in the worker: unpublished events become one delivery row per matching webhook (tenant, optional workspace, event types; only events recorded after the webhook was created) in the same transaction that marks them published. Deliveries are JSON POSTs signed `D4-Signature: t=…,v1=HMAC-SHA256(secret, "t.body")`, retried 5 times over about 7.5 hours; a webhook turns itself off after 5 failed deliveries in a row. URLs must be https and must not resolve to private, loopback or link-local addresses (checked when saved and before each attempt; `WEBHOOK_ALLOW_PRIVATE` for local development only). Secrets are stored in plain text, shown once on create or rotate | At-least-once delivery without a second queue, safe with several workers (`SKIP LOCKED`); receivers can verify origin and reject replays; a tenant cannot use webhooks to reach the platform's own network. Secrets must be readable to sign; encrypting them at rest waits for a key-management decision |
| D43 | 2026-10-20 | Change proposals store a list of model operations (create, change or delete elements and relationships; new elements get a `ref` that later steps use), not a copy of the model. Every check and the approval replay the steps through `ModelService` on a staging layer over the live model (`stageProposal`), and an approval applies the result as one change set under a row lock on the proposal. Each item may change once per proposal. The author is the actor of the resulting events, which also carry `proposalId` and `approvedBy`. Architects and admins review, never their own proposals; a rejection needs a reason. Draft → submitted → applied / rejected / withdrawn; submitted can go back to draft | Same validation, rules and optimistic locking as direct edits, so a proposal can never write what a direct edit could not; a proposal whose items changed meanwhile is refused at the failing step instead of overwriting newer work; four eyes on every reviewed change |
| D44 | 2026-10-20 | Quotas per tenant on elements, relationships, active workspaces, catalog query runs per UTC day, jobs per UTC day and stored file bytes. Built-in defaults (`DEFAULT_LIMITS`), overridden per tenant in `tenant_quotas` by the platform operator (`deploy/dev.sh quota`); tenant admins see usage and limits but cannot change them. Graph growth is checked in the shared event sink, so commands, imports, background imports and approved proposals are all covered; graph counts are cached per process for 30 s and moved forward by that process's writes, so concurrent writers can overshoot by what they add within one period. Changes and deletions are never limited. Over a limit: `QUOTA_EXCEEDED` (403), scheduled runs are skipped. The worker records each tenant's usage hourly in `usage_daily` for billing | Limits that cannot be bypassed by choosing another write path; counting a large graph on every write would be too slow, and a small overshoot is acceptable for plan limits; billing needs history, not just current figures |
| D45 | 2026-10-20 | Backups are logical and per workspace, not `neo4j-admin dump`: a gzip JSON snapshot of the workspace graph (deleted items included) in object storage, with the event-log position read before the snapshot and a SHA-256 checksum over canonical items. Restore = snapshot + replay of every event after that position; rebuild = replay of the whole log; both lock model writes for the workspace (`workspaces.locked_reason`, checked in the event sink), take a safety snapshot first and read the result back to check it. Replay applies an event only when it is the item's next version, so a snapshot that raced writes still converges. Verify replays the log and compares it with the live graph, which detects the Postgres/Neo4j gap noted in `eventSink`. Daily backups per active workspace after `BACKUP_HOUR_UTC`; 14 kept per workspace. Admin only; restore and rebuild need the workspace slug typed | A dump needs the database stopped and acts on a whole Neo4j instance, which locally holds every workspace (and tests share it); per-workspace operations can run while the tenant works. Ending every restore at the head of the event log means a restore can never silently drop later changes, and the event log stays the single source of truth |
| D46 | 2026-10-20 | Tenant provisioning goes through an `InstanceDriver` interface; locally the **manual** driver is used: the operator starts the tenant's Neo4j container (`deploy/dev.sh tenant-create`), and the control plane registers it, claims it, applies the schema and seeds it. No service gets the Docker socket (user decision). Every database carries a `:D4Tenant` marker claimed on first use; a connection whose database is claimed by another tenant is refused, so a wrong registry entry or host mapping cannot cross tenants. Passwords are `file:` secret refs read from a mounted directory (Kubernetes-style); local processes map registered hosts with `NEO4J_HOSTS`. Keycloak's `tenant` claim comes from an admin-only user attribute | Access to the Docker daemon is root on the host; the manual driver keeps that power with the operator, and a Kubernetes driver can implement the same interface later. The marker turns isolation from a convention into a check |
| D47 | 2026-10-20 | The SDK is generated from the API's own OpenAPI document (`openapi-typescript` types; the shipped `openapi.json` is committed) with a small hand-written client: no runtime dependencies, CommonJS like the other packages, paths, parameters, bodies and results checked at compile time, errors as `D4ApiError` with the API's codes, plus paging and job-waiting helpers. API tests fail when a served route is undocumented or the SDK copy is stale. Packages are made publishable (`pnpm pack` works) but stay `private` until a registry and licence are chosen | One source of truth for the contract; a runtime client library (openapi-fetch) would add an ESM-only dependency to CommonJS consumers for little gain; publishing is an outward step that needs an owner decision |
| D48 | 2026-10-20 | Connectors sync into a workspace through the import planner: source records are mapped (declarative JSON mapping: record filter, type, id, name, attributes with value maps, relationships) to import elements keyed `<connector key>:<source id>`, so matching, validation and the single change set are the same as model-as-code imports, and the event sink applies quotas, locks, webhooks and backups. The connector remembers each item's element version and mapped-value hash after a sync: unchanged items are skipped; an item changed in D4 and in the source since the last sync is a conflict (kept and reported by default, or taken from the source per connector); deletions made in D4 are respected; items gone from the source are reported, never deleted. Syncs run as jobs in the worker (no separate connectors service yet); credentials are write-only and stored like webhook secrets; outbound URLs use the webhook checks | One write path for every way data enters; people's edits are never silently overwritten; a separate service can come later without changing the model |
| D49 | 2026-10-20 | The local stack is sized for an 8 GB laptop: Neo4j runs APOC only (Graph Data Science is unused and cost several hundred MB of class metadata), with heap 512 MB (384 MB gave multi-second GC pauses under test load), page cache 128 MB and capped off-heap areas in a 1.4 GB container, and keeps at most 100 MB of transaction logs. Heavy steps run one at a time | Repeated Neo4j OOM kills and suite-wide timeouts were the machine swapping (load average above 100), not code; raising limits made it worse. GDS can come back per tenant when a feature needs it |
| D50 | 2026-10-20 | Industry metamodel packs (banking: BIAN-style service landscape, banking products, regulatory reports with BCBS 239 lineage, DORA ICT third parties; insurance: ACORD-aligned products, coverages, party roles, underwriting, claims, Solvency II / IFRS 17 reports) are additions composed onto the starter, never redefinitions; the composed metamodel gets the pack's own id and version. A workspace picks one when it is created; existing workspaces keep theirs. Several metamodels can share one tenant graph, so relationship-id indexes are only dropped when the caller passes every index still in use | Packs inherit every starter improvement and cannot change what starter types mean; mixed-metamodel tenants must not lose each other's indexes |
| D51 | 2026-10-20 | Git model-as-code is a connector kind (`git`) that reads D4 model documents from one branch (shallow clone into a temporary directory, path filter, no symlinks followed, file and size caps) and syncs them through the same planner as other connectors, so D4 edits are protected the same way and each run records the commit. Connector kinds are `records` (a mapping turns source records into elements) or `model` (documents need no mapping). Tokens go to git through environment configuration (`http.extraHeader`), never the command line; only https is allowed outside local development, where http and `file://` are allowed too. Any invalid document fails the sync. Push-triggered syncs and writing back to Git are not built | Model-as-code gets review in pull requests and history in Git while D4 stays the system of record; strict parsing behaves like a CI check instead of applying half a change |
| D52 | 2026-10-20 | Navigation is a left sidebar driven by one model (`nav.tsx`): groups Explore, Plan and govern, Data management, Reporting, Administration; an icon rail by default with flyouts, expandable to labels with sub-menus (remembered per browser); a breadcrumb header; Ctrl K search over pages, elements and catalog queries. Admin sections, Connectors and Backups get their own routes | The top bar had run out of room; one model keeps sidebar, breadcrumb and search consistent; deep links to admin sections and filtered views (`?kind=`, `?show=`, `?section=`) |
| D53 | 2026-10-21 | End-user documentation lives in `user-manual/` (nested markdown by feature and journey). Its screenshots are captured from the live stack by `apps/e2e/screenshots` (`deploy/dev.sh e2e -c screenshots.config.ts`), not drawn by hand, so they can be regenerated when screens change; the README keeps setup and an overview only. | Screens change often; scripted captures keep the manual honest. |
| D54 | 2026-10-21 | AI-assisted ingestion ([ADR 0005](adr/0005-ai-assisted-ingestion.md), proposed): a model suggests spreadsheet and connector mappings and fixes for dry-run issues, but only as artefacts a person could type (`TableMapping`, `Mapping`, value corrections) that still pass zod, the metamodel registry, the dry run and `planImport`. It runs server-side behind a provider interface (`packages/ai`), is off by default per tenant, sends only headers plus a few sampled rows, and is quota-limited and logged | Removes the manual mapping and error-fixing work without giving the model write access, Cypher or a way around tenant and metamodel rules |
| D55 | 2026-10-21 | Conversational change workspace and agent platform ([ADR 0006](adr/0006-conversational-change-workspace.md), proposed): one screen where users describe a change in plain English; a LangGraph orchestrator picks a declarative skill, which drafts only change-proposal operations and import mappings (the draft is a `draft` proposal plus an append-only revision list); the user iterates with previews and analyses, then submits the whole set for approval as one proposal (D43). The agent runs as its own service (LangGraph Python in `apps/agent`; the API contract is generated from OpenAPI and JSON Schema, not shared code), calls D4 only through the REST API with the user's token, and reaches all tools through an MCP gateway that enforces per-skill allow-lists, identity, limits and logging; no tool writes to the model. Decisions of 2026-10-21: nginx reverse proxy as the MCP gateway, with the policy (token check, per-skill tool allow-lists, fail closed) written in njs inside nginx, developer-only skills, mixed and mergeable drafts based on a snapshot with explicit rebase, background staging for large drafts, eval set plus human review sample before enablement, `zod-to-json-schema` contract checked in API CI, uv with Python 3.12 | Plain-language entry without a new write path, so validation, quotas and review stay identical; the gateway keeps auth and audit in one place as skills multiply |
| D56 | 2026-10-21 | Skill Hub ([ADR 0007](adr/0007-skill-hub.md), proposed): skills are declarative, immutable, content-hashed packages (manifest, schemas, prompts, tool allow-list, evaluation set) served to the agent from a configured URL by a CDN-like data plane (immutable content-addressed objects with year-long caching, a short-TTL signed channel index, mirrors and edge caches, signed revocation list) separate from the Hub's control plane. Lifecycle draft → in_review → approved → published → deprecated → archived, with `skill-author` and `skill-steward` roles (no self-review), automatic evaluation, search by description and example requests, audit of every transition and fetch. The agent verifies a signed manifest and the content hash, pins `id@version` per draft, and caches packages. Skills may carry scripts, delivered in the same signed package but run only in an isolated sandbox that is part of the agent harness (gVisor proposed, pending a spike; Python 3.12 or TypeScript on Deno; whole package incl. vendored libraries and files at most 10 MB; owned by the skill owner per tenant; no network, credentials or D4 access; JSON in, schema-validated JSON out), under a higher risk class with security approval from both the tenant and the platform operator, and tenant opt-in; published tool allow-lists generate the gateway's allow-list file | Skills can change without an agent release, under the same review and fingerprint controls as the Query Catalog, and a changed skill can never silently widen what the agent may do |
| D57 | 2026-10-25 | Node 24 LTS everywhere (engines, CI, images; the renderer copies Node 24 into the Playwright image) and `knip` as a gate for unused files, exports and dependencies (`deploy/dev.sh check`, CI); deliberately kept exports carry a `@public` tag with the reason. Refactor plan in [REFACTOR_PLAN.md](REFACTOR_PLAN.md) (P0) | Node 20 reached end of life in April 2026; dead code stays out once pruned |
| D58 | 2026-10-25 | Configuration is external and layered: committed flat env files in `deploy/env` (`common.env`, then `container.env` or `host.env` for the network view, `dev-secrets.env`, an optional git-ignored `local.env`; caller's environment wins in `deploy/dev.sh`), read by compose `env_file` and interpolation and by `dev.sh`. Services load settings through `@d4/config` (shared zod fragments, `NAME_FILE` secrets, `POSTGRES_URL` from the same parts the postgres image takes). `D4_ENV` defaults to `production`, which refuses the development secret and development-only switches. No secret defaults or hard-coded URLs in code: CORS follows `D4_PUBLIC_URL`/`CORS_ORIGINS`, the web app reads `/config.json` at start-up (written from env by its container), and the Keycloak realm takes `${D4_PUBLIC_URL}` and `${DEV_USER_PASSWORD}` placeholders. (P1) | One place per setting; the same image runs in any environment; a production deploy cannot start with dev credentials |
| D59 | 2026-10-25 | Local S3 and mail are in-repo mocks instead of third-party images: `mocks/s3` is a file-backed S3 endpoint (path-style REST: buckets, objects with ranges, conditional requests, metadata and checksums, copy, batch delete, ListObjects v1/v2, multipart; SigV4 header and presigned checks; `aws-chunked` bodies; buckets from `S3_MOCK_BUCKETS` created at start, replacing the aws-cli `s3-init` job), and `mocks/smtp` accepts SMTP and serves a Mailpit-compatible inbox API on :8025. Neither has runtime dependencies; both are contract-tested with the AWS SDK and nodemailer. Supersedes D14 and the Mailpit part of D40 | Fewer external images to pull and track; the local S3 behaves like S3 where the services depend on it (signatures, checksums, error codes) and keeps its data in plain files |
| D60 | 2026-10-25 | Local containers run on **rootless Podman** (with `podman compose`) instead of Docker. Each deployable has its own `Containerfile` (filtered `pnpm install`, then `pnpm deploy --prod`, non-root user, fully qualified base images); compose is split by concern in `deploy/compose/` with a named `d4` network, ports bound to 127.0.0.1 and health checks in compose. `deploy/dev.sh` is split into `dev-infra.sh` (infrastructure, tenants, operator tasks), `dev-deploy.sh` (build and start app containers, all or named), `dev.sh` (apps on local Node) and `test.sh` (static, unit, integration, web, e2e, smoke, all; `--local` for host Node), sharing `deploy/lib/common.sh`. Supersedes rule 8 "Docker is the source of truth". (P2) | No daemon or root on the host; per-app images are 3–4× smaller (api 1.14 GB → 355 MB); each script has one job |
| D61 | 2026-10-25 | An **nginx gateway** (`apps/gateway`) is the one browser-facing origin (`D4_PUBLIC_URL`, port 5173): web at `/`, API at `/api` (prefix stripped), Keycloak at `/auth` (`KC_HTTP_RELATIVE_PATH`), and in development the mail inbox at `/mail/` and Grafana at `/grafana/`. Upstreams come from the environment and resolve per request; `deploy/dev.sh web\|api` points one at the host and restores it on exit. CORS is removed; e2e runs on the host network against the gateway (no port forwarding) | One origin means no CORS, one TLS and header policy, and identical URLs whether an app runs in a container or on local Node; the token issuer changes once (`/auth/realms/d4`) |
| D62 | 2026-10-31 | **Backend pruning (P4):** `@d4/runtime` (pino JSON logs, tracing, the queue service loop) for worker and renderer; adapters in `@d4/infra`, job handlers in `@d4/jobs`; operator commands in `apps/ops` (`d4-ops migrate\|seed\|schema\|tenant\|quota`, its own image for the init jobs); API split into feature modules with injected stores, `@Roles()`, `@Workspace(access)`, `@ValidBody`/`@ValidQuery` and per-feature OpenAPI; request logs with the gateway's request id, tenant and user | One way to do each thing: no copied service loops, `new XStore()` calls, per-handler role checks or a 650-line route document; operator tasks no longer need the API image |
| D63 | 2026-10-31 | **Web modular monolith (P5):** the web app is a shell plus six modules (`explore`, `queries`, `plan`, `data`, `reporting`, `admin`) in `apps/web/src/modules/`, each exporting a `D4Module` descriptor (contract version, menu items, lazy routes) and owning its screens, API calls and stylesheet. What modules share lives in `@d4/web-platform` (sign-in, runtime settings, the typed `@d4/sdk` client, query client and keys, current user and view, the contract) and `@d4/ui-kit` (shared components, `base.css` and `app.css`). A module never imports another module or the shell (ESLint). Browser packages ship an ESM build under the `browser` export condition; shared versions are pinned with a pnpm catalog | Boundaries are checked rather than conventional, the API contract is typed end to end, and each module is already the unit P6 can load as a remote |
| D64 | 2026-10-31 | **Web runtime modules use single-spa (P6), not Module Federation:** a module is an ES module exporting a menu manifest and the single-spa lifecycles, mounted under `/w/:ws/<name>` with its own router; the shell passes a framework-neutral `Platform` object (settings, token, typed client, shared query cache, workspace, navigate) and shares React, React Router, React Query, `@d4/web-platform` and `@d4/ui-kit` through a build-generated import map. The shell never waits for a module; one that fails shows as unavailable | Both spikes passed the browser suite; single-spa removed the 8 s start-up stall and the slow dev remote, needs no D4-specific build plugin, and lets a module use another framework (or none). Cost: a router per module and a neutral platform layer; `ui-kit` components stay React only |
| D65 | 2026-10-31 | **Web module registry:** the modules the shell loads are rows in Postgres `web_modules` per tenant (name, title, description, owner, entry, version, contract, framework, enabled), managed by admins through `/v1/admin/web-modules` and the Admin › Modules page; the seed registers the dev stack's modules. The shell reads `GET /v1/web-modules` once signed in and again every 30 s and on returning to the tab (ETag, 304 when unchanged): it loads new modules, swaps a module whose release changed (unmount, import the new entry with `?v=<version>`, mount) and removes ones taken out, without a page reload. Entries must be same-origin paths under `/mfe/<name>/` and the contract one the shell supports | Releasing, turning off or adding a module is a data change rather than a shell redeploy, and admins see what runs. Restricting entries to platform-served paths keeps registration from injecting third-party code into every member's browser. Polling is simple and enough at this scale; server push can replace it later. Old module code stays in memory until the next reload (ES modules cannot be unloaded) |
| D66 | 2026-10-31 | **Targeted pre-commit checks:** `deploy/test.sh all` is no longer required before each commit. Each commit is tested first on local Node (`dev.sh` apps behind the gateway, `test.sh --local`), strongly preferred, then builds and redeploys only the touched apps, then runs the touched packages' tests and the browser specs covering the change; `test.sh static` when types, exports or dependencies change. The full run stays available, e.g. before merging a branch. | A full run takes minutes per commit and mostly re-tests untouched code; targeted checks keep the same confidence for the code that changed |
| D67 | 2026-10-31 | **Two gateway hosts:** the gateway always runs in Podman on port 5173 and serves two hosts. `localhost` (`D4_PUBLIC_URL`) routes to the containers, or to an app `deploy/dev.sh` runs on local Node; `d4.localhost` (`D4_PODMAN_URL`) always routes to the containers, which `dev.sh` no longer stops. Keycloak has no fixed hostname, so each host signs in on its own origin; `/config.json` holds paths resolved against the page origin; the API accepts `OIDC_ISSUER` and `OIDC_EXTRA_ISSUERS`. `test.sh e2e --podman` tests the containers | The local build and the deployed build can be compared side by side, and local-first testing (D66) never takes the containers down. `*.localhost` needs no hosts-file change; keeping one origin per host keeps the no-CORS rule |
| D68 | 2026-10-31 | **Faster build and test loop:** `.dockerignore` links to `.containerignore` (the compose provider read only the former and uploaded ~900 MB per image build); image builds run `turbo run build` with a build-cache mount for turbo's cache; `dev-deploy.sh <app>` builds and restarts only the named apps (`--no-deps`); `test.sh` runs unit, integration, static and web checks on local Node 24 by default (`--container` forces the image; `all` stays in containers) | Measured on the API: a no-change deploy 261 s → 17 s, a one-line change 151 s → 73 s, a package test 70 s → 5 s. Containers stay the source of truth for deploys, browser tests and the full run |
| D69 | 2026-10-31 | **(Superseded by D74)** **Split into `d4-api`, `d4-web` and `d4-infra` (planned, docs/REPO_SPLIT_PLAN.md):** repositories meet only through published contracts: `@d4/sdk` and the shared domain packages (`core`, `metamodel`, `codecs`, `render`), published from `d4-api`, and versioned images pinned in `d4-infra`'s `versions.env`. A repository never builds another. Phases: S0 boundaries inside the monorepo, S1 publishable contracts, S2–S4 extraction with history | A one-line change should build and test only what it touches. The dependency graph has just two build-time seams (SDK and a small pure domain slice), so the split is clean |
| D70 | 2026-10-31 | **Web module releases from a bucket (spike):** a module release is an upload, not an image: `POST /v1/admin/web-modules/{name}/releases` checks the manifest (contract, semver, file hashes, paths, size) and stores the files once, immutable, per tenant in the `d4-web-modules` bucket; the gateway serves them read-only under `/mfe/_r/<tenant>/<name>/<version>/`; the registry PUT activates a version per tenant, which is also the rollback. nginx only serves; the API is the control plane | Releases and rollbacks take under a second instead of an image build, old versions stay available, files can be cached for a year, and uploads go through the API's auth and checks. Per-tenant storage keeps one tenant's admin from activating code another tenant uploaded |
| D71 | 2026-10-31 | **Honest caches and narrow CI:** turbo hashes the `D4_TEST_*` settings and the root config (`globalDependencies`), so a run without test services never stands in for one with them; CI runs `turbo --affected` on pull requests (everything on `main`), keeps the turbo cache, checks that the committed SDK matches the API, and runs knip over the whole repository; backend images build from `turbo prune` | A cached pass must mean the tests ran. Measured: an API image after a web or docs change 57 s → 20 s |
| D72 | 2026-10-31 | **Module releases hardened:** a module manifest records the shared-package majors it was built against and the shell refuses a mismatch (`lifecycleProblems`, one contract check for shell and module tests); the production shell sends a content security policy (scripts from this origin plus the import map by hash); releases can be listed and inactive ones deleted (`mfe-publish.sh --keep N`); the release endpoints are in the OpenAPI document and the SDK | A module built against another React or platform major fails visibly instead of breaking at run time; the policy makes "only code the platform serves" hold in the browser, not just in the registry; old versions do not pile up |
| D73 | 2026-10-31 | **Every web module is a lifecycle app:** explore, queries, plan, data, reporting and admin are `apps/web-<name>`, loaded through the registry; the shell has no screens and the static `D4Module` contract is removed. A manifest may own several top-level paths (`paths`) and the workspace home (`home`), so URLs did not change | Each module now builds, tests and ships on its own (a one-line change tests one module), and every module goes through the same contract, registry and release path |
| D74 | 2026-10-31 | **One repository, web modules as plugins (ADR 0008), superseding D69:** no repository split; changes stay cheap through affected-only builds and tests, and every web module is an independently released plugin. Backend plugins (option A) come one feature at a time when a second owner, per-tenant backend features or slow backend CI call for them | Two independent reviews: the domain kernel still changes and most changes cross web and API, so separate repositories would slow every change; the cost was in rebuilding and retesting, which D66–D73 removed |
| D75 | 2026-10-31 | **CI covers the composed stack and the supply chain (P7):** an `e2e` job runs the browser suite against the stack on rootless Podman (`ubuntu-26.04`), with the same `dev-infra.sh`, `dev-deploy.sh` and `test.sh e2e` as locally; base images are pinned by digest and Dependabot proposes updates for actions, npm packages and images; every image built gets a Trivy vulnerability report (job summary) and a CycloneDX SBOM (artifact), report-only until a baseline is agreed; documentation-only changes skip CI | Podman only, as locally (D31), so CI tests what developers run. Digest pins make builds reproducible without freezing them. Scans start as reports because failing on an unknown backlog would block every change |
| D76 | 2026-11-01 | **Production-readiness checklist completed:** app containers run on a read-only root filesystem with `/tmp` as tmpfs (the gateway's `conf.d` is a link into `/tmp`); liveness (`/healthz`, the process is up) is separate from readiness (`/readyz`: the worker and renderer check Redis and Postgres), and compose healthchecks use readiness; the gateway adds a baseline CSP (`frame-ancestors`, `base-uri`, `object-src`, `form-action`) on top of the shell's script hashes, except under `/auth` and `/grafana`, plus header, body, send and connect timeouts, and serves HTTPS on 8443 when given a certificate; `deploy/compose/prod.yaml` publishes only the gateway and drops the development secrets. |
| D77 | 2026-11-01 | **Playwright moves by hand, in one change:** `@playwright/test`, `playwright-core` and the `mcr.microsoft.com/playwright` image (e2e and renderer) share one version, now 1.64.1 (the image in `deploy/env/images.env`, which Dependabot does not read) | Playwright only finds browsers built for its own version. Dependabot bumps only the npm packages (it cannot see the image), and such a PR fails the browser suite: close it and bump all three together |
| D78 | 2026-11-05 | **One entry point for build, run and test: `run/run.sh [<runtime>:]<component>:<command>`** (supersedes the `deploy/` scripts and compose files, and D67's second gateway host). Runtimes `local` and `podman`; categories `ui`, `service`, `infra`, `tool`, plus `stack`; commands `build`, `deploy`, `start`, `stop`, `reset`, `status`, `logs`, `test`, `exec`, `shell`. Each component carries its contract in a `component.yaml` beside it (schema `run/schema/component.schema.json`); infra lives in `infra/<name>/`, shared settings and the orchestrator in `run/`, the one entry point in `host.conf`. Every container runs on the host network and listens on `127.0.0.1:<port>`, the same port on both runtimes, so the gateway (always Podman) never changes and a component runs on one runtime at a time (deploying it on one stops it on the other). Packages compile once on the host with the shared turbo cache; images are thin wrappers around that output, tagged with a hash of their inputs and rebuilt only when it changes. `run.sh` polls `podman healthcheck run` every 5 s after a start. Tests default to the packages changed since `HEAD` within the component, and browser tests to the specs its `component.yaml` maps to it | Small changes rebuilt everything: each image compiled the shared packages again in its own build, and host builds and image builds shared nothing; failures surfaced late with no progress shown; tests ran wide by default. The target environments allow no Podman networks, resolve no host names inside Podman and do not always run health checks, and configuration was centralised away from the components it described. A no-change stack build now takes about 3 s, a component moves between runtimes in about 6 s, and the 75 browser specs pass with apps mixed across both runtimes |
| D79 | 2026-11-06 | **Graph Studio is built in phases as a new Explore page (`/w/:ws/graph-studio`)**, following [GRAPH_STUDIO_PLAN.md](GRAPH_STUDIO_PLAN.md): three SVG components in `@d4/ui-kit`, `GraphCanvas` (the whole result: graph, table, overview and its bars), `GraphSearch` and `GraphInspector`, that fetch nothing (the host owns state); pure layout logic in `@d4/render` and lens logic in a new `packages/lens`, node-type `role` in the metamodel, and lens search through a checked API endpoint (depth 1–6, both directions, 1,000-node cap enforced server side). The Explorer's Cytoscape graph is renamed `CytoscapeGraph` and deleted once Explorer moves to the new `GraphCanvas` | The requirements need elbow-routed labelled connectors, draggable nodes and labels, and semantic zoom, which the Cytoscape canvas does not give us; the components are shared with Ingestion Studio, so they must be stateless; lens previews and search must return the same nodes, so evaluation lives in one package |
| D80 | 2026-11-06 | **Elements and relationships accept attributes the metamodel does not define.** Defined attributes are still type-checked and required ones enforced; an undefined attribute is rejected only when it reuses a system field name (`RESERVED_ATTRIBUTE_NAMES`, now in `schema.ts` so the browser build has it) or holds a value Neo4j cannot store (anything but a string, number, boolean or a list of them) | Imported and ingested data carries attributes nobody modelled yet (Graph Studio's lens filters and the credit graph's typed values among them); rejecting them forced a metamodel change before any data could load. Properties are written as parameter maps, so names cannot inject Cypher, and system fields are written last |
| D81 | 2026-11-06 | **The shell refuses a web module that claims a path another module owns** (`pathClashes` in `@d4/web-platform`): the module already in place keeps the path, and the newcomer is marked unavailable with a problem naming the path and its owner. Modules are imported in parallel but registered in registry order (by name), so the same one wins every time | Two modules on one path left the first registered one shown and the other silently unreachable, in whichever order the imports happened to finish: Graph Studio's first route, `studio`, opened the Queries page because Query Studio owns that path, and only a browser test noticed |
| D82 | 2026-11-06 | **Graph Studio lenses are saved per workspace in Postgres (`studio_lenses`, migration 0014), private by default.** A private lens shows only to its owner; a workspace lens to everyone who can read the workspace. Anyone who can read a workspace may save private lenses; sharing one needs write access to the workspace. Only the owner changes or deletes a lens, and someone else's private lens answers 404. Others copy a lens through the editor's "Start from…" | A lens is a view definition, not a model change, so read access is enough to keep one for yourself; sharing puts it in front of everyone, so it takes the same access as changing the model. Answering 404 for another user's private lens does not reveal that it exists |
| D83 | 2026-11-07 | **The credit graph pack ships** (`packages/metamodel/packs/credit-graph.yaml`, `d4-credit-graph` 0.1.1 on the starter: clients and client groups, facilities and drawdowns, collateral agreements, accounts, instruments, properties, covenants, margin calls, limits, applications, approvals, reviews and exposure, each type with a lens `role`) and is registered in `METAMODEL_PACKS`, so a workspace can start from it. Its sample, `samples/credit-graph.yaml` (a fictional private bank, 838 nodes, 2,462 relationships), goes in a workspace of its own; the browser suite creates `credit` and imports it once. Graph Studio offers its 11 lenses there only. `/` now opens the `default` workspace when the user has one | The first real data set for lens search and the graph canvas; built in another worktree (its D78 there), brought in here. Registering it changes the admin API's metamodel list and the SDK. The sample's names repeat (two clients called Hugo Roth), so importing it again, matched by name, is ambiguous: it needs `externalKey`s before it can be re-imported. Without the start-page rule, adding a workspace that sorts before `Default` moved everyone's start page |
| D84 | 2026-11-07 | **A Graph Studio lens can take its roots from a catalog query.** Query Authors write the Cypher in the lens editor, but it is saved as a catalog draft and goes through the checks, review and publishing of D7; the lens stores the query id (and optionally a version), its own parameter values and the attributes it offers as quick filters. The query returns element ids in an `id` column, or element nodes; those become the roots, capped at 500, and the Studio expands them as usual. Runs go through `QueryRunService.run`, so grants, the fingerprint, bound parameters, the run log and quotas all apply | Authors asked for lenses the contour-and-facets model cannot express, without giving up D7: no end user types Cypher, and nothing unreviewed runs |
| D85 | 2026-11-07 | **A Graph Studio lens becomes a viewpoint: one declarative spec (anchor, typed steps with direction and depth, shape, disclosure policy, encodings, actions) that every visual pattern renders and every authoring surface produces** ([`docs/LENS_DESIGN.md`](LENS_DESIGN.md)). Patterns name relationship kinds (`containment`, `dependency`, `flow`, `ownership`, `association`, `classification`) declared in the metamodel, not relationship names. A server-side disclosure engine fills a node budget by degree of interest and folds the rest into group stubs that open on demand; nothing is cut without a mark. Today's lenses map onto the spec unchanged | Lenses were filters drawn as a flat neighbourhood: no direction, no hierarchy or flow, no drill-down, every node equal. Research across graph-visualisation studies, EA tools (Ardoq, LeanIX), lineage catalogs (DataHub, Collibra, Atlan) and graph explorers (Bloom, Linkurious, KeyLines) converges on search-first, budgeted disclosure over metamodel-defined traversals; compiling a spec on the server keeps the no-raw-Cypher rule (D7) without limiting what users can ask |
| D86 | 2026-11-07 | **Lens slice 1 (D85) ships: relationship kinds in the metamodel, and Graph Studio draws every lens by disclosure.** Relationships declare `kind` and `forward`, types `importance` (starter 0.4.0, credit graph 0.2.0). A search with `disclosure` walks the lens's steps level by level: a parent's links of one relationship and type are drawn when they fit the per-node cap (12) and the budget (150), else they fold into a group with a count; `studio/open` loads a group a page at a time, most important first. Lenses gain `steps`, `shape` (`ego` or `tree`) and `disclosure`; older lenses mean any relationship both ways to their depth. Two credit-graph Hierarchy lenses ship. Metamodel versions stay immutable: a workspace keeps the version it was made with, so existing workspaces get the kinds only once they can move to a new version | The first slice of D85: few nodes first, then open what you need, on any metamodel that labels its relationships. A step names kinds, not relationships, so patterns carry over between metamodels. Changing a stored version in place would change what every lens and check sees on that workspace without a record; upgrading workspaces is its own change |
| D87 | 2026-11-07 | **Lens slice 1 finished: workspace metamodel upgrades, groups of one, Pin.** An admin moves a workspace to the newest shipped version of its metamodel (`GET`/`POST /v1/admin/workspaces/{ws}/metamodel-upgrade`, an Upgrade button in Administration) only when `upgradeIssues` finds nothing existing data relies on: no type, relationship, attribute, endpoint or enum value removed or changed, no new required attribute, no new or changed rule. Additions and lens semantics (kinds, direction, roles, importance) pass, so the graph needs no migration; the new version's labels and indexes are added, then the workspace is repointed. Anything else stays a migration, out of scope. The banking and insurance packs go to 0.1.1: composing them on starter 0.4.0 changed their content under the same version, which `register` refuses. A group of one past the last level opened is drawn as its member while the budget has room (one level only, so a deeper Depth never shows fewer nodes), and a group page never leaves one member behind. Pin keeps a node on the canvas through drills and new searches, with the links it had, until unpinned or the search is cleared; it does not yet hold the node's position across steps or raise its interest on the server. | Workspaces created before D86 get Hierarchy lenses without recreating them; a check that refuses rather than migrates keeps data valid by construction. |
| D88 | 2026-11-07 | **Lens slice 2: lineage, impact and viewpoint chains.** A lens step may name the types it goes to (`types`, supertypes match subtypes) and the column it is drawn in (`stage`), so a lens can be a viewpoint chain (Capability → Application → DataStore). A third shape, Flow, draws each level as a column with its stage as the heading, left to right, or right to left when every step goes up, so sources sit on the left. `POST studio/impact` lists everything a lens reaches from its roots without a budget (each node once, at the level it is first reached, through the first link; at most 5,000 nodes and 20 levels, then `truncated`), shown under the canvas as the impact table with CSV export. The lens editor gets a Traversal section: pick a pattern (around the roots, hierarchy, lineage or impact, viewpoint chain); lineage follows one relationship kind up or down, with kinds the metamodel lacks greyed out; a chain is up to six typed steps whose target types and relationships are offered from the metamodel; the preview counts the first screen per column, drawn and folded. Built-in Flow lenses: Data lineage, What depends on a data store, Capability to data, and Facility to report on the credit graph. The browser tests get their own credit workspace (`e2e-credit-0-2-0`, "Credit graph (tests)") instead of sharing one with people. | Lineage and impact are the most asked questions after Ego (D85 section 4); the impact table answers "what exactly is affected" past the canvas budget, without drawing it. Steps per type and stage reuse the disclosure engine unchanged. |
| D89 | 2026-11-07 | **Lens slice 3, first part: Connection (how are two nodes linked?).** `POST studio/paths` returns the shortest paths between two elements (Neo4j `allShortestPaths`), up to six links and 25 paths, through elements in the view, optionally along one relationship kind; shortest first, then by the names along them. The length cap is clamped and spliced into the pattern, as Cypher takes no parameter there. Relationships are filtered by validity and scenario but not by scenario replacement, which needs a subquery per link. In Graph Studio the inspector offers "How is it connected to …?" for each pinned node, so the Connection pattern is a selection-gated action on Pin; it opens a step on the focus path with both ends as roots and a Connections list, where choosing a path shows only it. Matrix, Landscape, search phrases, templates and the other selection-gated actions follow in later parts of slice 3. | Pin already names the node the user cares about; pairing it with the selection needs no new search form. Shortest paths answer the question without exploding at depth 6. |
| D90 | 2026-11-07 | **Lens slice 3, second part: Matrix (which X relate to which Y?).** A lens gets the shape `matrix`: its roots are the rows, and the nodes its first step reaches are the columns, so the step must name the types of its columns (the API refuses a matrix lens without them). `POST studio/matrix` reads the step once from all roots and returns rows, columns and, per linked cell, the relationship types; a root reached from another root stays a row. At most 200 columns, the most linked first, then sorted by name; `truncated` when more were left out. In Graph Studio a Matrix lens opens its matrix under the canvas, which still shows the roots and the step; a row with no link is a gap, marked and listable on its own, and the matrix exports as CSV. The editor offers Matrix as a pattern with one step. Built-in lenses: Capabilities by application (starter) and Collateral cover (credit). Cells are not yet coloured by an attribute. | The step machinery already reads the links; a matrix is another shape over the same read, not a new query language. Gaps come free from the rows, which is the coverage question most matrices are asked for. |
| D91 | 2026-11-07 | **Lens slice 3, third part: Landscape (what is in this domain, and what state is it in?).** A lens gets the shape `landscape`: each root is a box holding what its first step reaches, usually one level down through containment; the API refuses a landscape lens without a step. It reads through `studio/matrix` (D90), the boxes being the rows and their contents the columns, so there is no new endpoint and the same limit of 200 contents applies. In Graph Studio a Landscape lens opens its boxes under the canvas; the contents are tiles coloured by one enum attribute, lifecycle when the types have it, chosen from the enum attributes of what is shown, with a legend in metamodel order. Colours are the theme's layer tokens. A box with nothing inside is marked. The editor offers Landscape as a pattern, greyed out when the metamodel declares no containment. Built-in lenses: Data domain landscape (starter) and Client groups (credit). Boxes are one level deep: a sub-box that is also a root is drawn as its own box, not nested. | The matrix read already returns each root with what it reaches; a landscape is the same data drawn as boxes. One level keeps the layout a grid that reads on any metamodel. |
| D92 | 2026-11-07 | **Lens slice 3, fourth part: search phrases and Open as (start a lens from what you are looking at).** A lens gets `phrases`: up to ten, each words then one slot at the end ("impact of $application"); the API refuses any other form. While no lens is chosen, the smart bar offers the phrases whose words the text starts, or that start with the text; choosing a filled one runs its lens with the slot's text as the name search on its roots. The lens editor takes phrases one per line and will not save a phrase without its slot. The inspector's **Open as** lists every other lens whose contour the selected node is (subtypes included, catalog-query lenses aside) and runs the chosen one from that node, as a new focus path named `<lens> · <node>`. Built-in phrases: lineage of, impact of, what depends on, data behind (starter); structure of, breakdown of, reports for (credit). A template is a lens opened this way: its anchor slot is the node or the phrase's slot, so there is no separate template object. | One slot at the end keeps the matching a prefix test that needs no parser and reads the same in every metamodel; the slot searches names, which the lens's roots already support. Open as gives every lens a right-click use without each lens declaring its actions. |
| D93 | 2026-11-08 | **Lens slice 4, first part: the text form.** A lens can be written as one line modelled on dbt selectors: `[N+]Type[+N] [via kind \| REL,REL] [to Type,Type] [where attr=v,attr=a\|b,attr>=n,attr<=n,attr~text] [as shape]`. `N+` follows N levels up, `+N` down, both the same N both ways (different numbers each way are refused, since a lens step has one depth); without levels the lens is drawn around its roots. It compiles in `@d4/core` (`parseLensText`, `formatLensText`) to the same spec: the contour and its filters, one repeating step, the depth (also the first-screen depth) and the shape. The lens editor has a Write it as text field above its sections: it shows the draft as text while the form can say it (no facets, catalog query, multi-step chain, stage or filter value with spaces), and Apply reads a line back, checked against the metamodel's types, relationships and attributes, replacing the contour, facets and traversal. Nothing new reaches the API: the editor saves the spec as before. | One line is quicker than the sections for a power user and reads the same in every metamodel. Compiling on the client to the existing spec keeps the server's checks the only gate, and no query text is sent. |
| D94 | 2026-11-08 | **Lens slice 4, second part: Cypher projections.** A lens's catalog query (D84) may return a projection instead of anchors: a `node` column (an element id or node, required), with `parent` or `from` (the link's source), `rel` (its relationship name), `anchor` (true for starting nodes) and `level` if it likes. `@d4/graph` reads the rows (`queryProjection`, naming the row whose `node` is not an element); `studio/search` with disclosure draws them through `projectQuery`: the nodes in row order up to the budget (the rest cut and the result marked truncated), only elements the caller's view holds, the stored relationships between them that the query declares (matching `rel` when given), and levels from the query or, where it gives none, breadth first from the anchors (else the nodes no link leads to). Groups do not apply, since the query already chose what to show. A drill (`ids`) on a projection lens runs from the node as before. The query writer in the lens editor asks whether the query gives Anchors or a Projection and swaps an untouched starter. The `weight` column is not used yet. | The query author chooses the nodes and links, but the server still loads every element and relationship itself, in view and in the workspace, so a projection cannot invent data or reach past what the caller can read; the catalog's review stays the gate on the Cypher. |
| D95 | 2026-11-08 | **Lens slice 4, third part: layers.** A lens may keep its steps to some of the metamodel's layers (`layers`, checked against `metamodel.layers` when saved), such as Business and Strategy for a business view of an architecture. `lensSpec` takes the metamodel's layer types from the host (`MetamodelRegistry.typesInLayers`, subtypes included): each step keeps to the types of those layers that it may reach; a step that reaches none ends the chain there, and when the first one would, the lens follows any relationship to the layers' types. The roots are as the contour says, in any layer. Nothing new reaches the read endpoints: the client sends the narrowed steps, which the server checks as before (a step may now name up to 200 types). The lens editor's Traversal section has Keep to layers, and says which step the layers stop. | Layers are what every metamodel already declares, so the same choice works on every pack without a list of types per lens. Narrowing the steps on the client keeps one place, `lensSpec`, where a lens becomes its traversal. |
| D96 | 2026-11-08 | **Lens projections: the weight column.** A projection query may return `weight`, a number per node (the highest when a node is on several rows). The budget keeps the anchors first, then the highest weight, then row order; a node without one counts as 0. The result carries `weights` for the nodes shown, and the canvas lists heavier nodes first. A weight that is not a number fails the query with its row. | `weight` is the design's interest term for a query that knows better than the generic score what matters, such as exposure or spend; using it only for the cut and the order keeps the layout and the server checks as they are. |
| D97 | 2026-11-08 | **Lens time slice.** A lens may carry `time`, a range of business time (`from` included, `to` not, as `validFrom` and `validTo` are; checked when saved). The lens still draws everything it reaches; `timeMark` in `@d4/core` fades nodes not valid at any point of the range and marks those whose validity ends or starts inside it (ends wins), with the month on the card. The canvas node's `mark` (kind and label) is shared with the diff to come. The lens editor's Traversal section has Time slice. | The graph already keeps business time on every item, so the slice needs no new data or endpoint; drawing what falls outside faded, rather than dropping it, keeps the context the question is about ("what retires, and what does it leave?"). The model view's `asOf` still filters as before. |
| D98 | 2026-11-08 | **Graph Studio diff: changes since a day.** `POST /studio/changes` takes the ids the canvas shows (at most 400) and an instant. It reads the deleted links of the shown elements from the graph (soft-deleted items stay there, with deleted nodes at their far end, at most 100 links), then the event log for all of those items after the instant (`EventStore.forSubjectsSince`, at most 5000 events), folded by `changesSince` in `@d4/core` into one change per item: added, changed with its fields, or removed; an item created and deleted in the window is left out. The canvas's Changes since date marks nodes Added, Changed or Removed (over the time slice's marks), and draws the removed items faded. | Record time is already in the event log and the soft-deleted graph, so a diff needs no snapshots or replay. Asking only about what is shown keeps it bounded by the lens's budget. This is record time; the existing Compare page (`/diff`) still compares two business views. |
| D99 | 2026-11-09 | **Roadmap and dependency-risk metamodel: requirements.** `docs/roadmap-metamodel-requirements.md`. One element registry (applications and data) with lifecycle and dates; current, target and gap are views as of a date, with optional named transition states. Firm-wide direction (technology list, reference architectures, shared platforms, principles, blueprints) is a concern of its own. Risk is computed from structure; only human judgement is stored | The need is to trace roadmap risk to causes across initiatives, architecture, data and direction. Two separate current and target element sets would duplicate identity and ownership, and an independent review of roadmapping and enterprise-architecture practice (plateaus, baseline/transition/target) pointed to one registry with dated states |
| D100 | 2026-11-09 | **Dependencies are split into families:** structure (`partOf`, `uses`, `consumes`, `produces`), change (`delivers`, `replaces`, `wraps`, `retires`, `dependsOn`), conformance (`builtOn`, `follows`, `addresses`), lineage (`derivedFrom`) and external (`gatedBy`). Each has its own traversal direction; a slip propagates along `uses`, `consumes`, `delivers`, `replaces`, `dependsOn` and `gatedBy`, not along conformance or lineage. Data product dependencies target an output port and contract version | "Needs" and "builds on" overlapped, and lineage (data flow) is not delivery dependency; impact tracing needs one defined direction and propagation rule per kind |
| D101 | 2026-11-09 | **Timing:** a milestone carries date, confidence and `committed`. Only committed milestones are the dates that matter. Element ready-by comes from the milestone that delivers it; float is needed-by minus ready-by, negative means late. Roadmap items are milestones and high-level epics, not tasks. Baselines are named record times, facts are bitemporal (business time and record time), and slip is current forecast minus baseline. What-if and named scenarios (overlays, never written to the registry) are both in the first version | "By how much" is unanswerable without baselines; a computed critical path needs float and a defined "date that matters" |
| D102 | 2026-11-09 | **Debt is computed findings plus recorded items.** Non-conformance to firm direction is recomputed on every change and never stored; a person adopts a finding as a `DebtItem` (technology, architecture, system, data) with owner, severity, deadline and status (identified, planned, accepted, unplanned, resolved). An accepted item is an exception with an expiry, not a separate lifecycle. Exposure is computed from dependents. Every recorded item is planned, accepted or flagged unplanned | Stored derived debt drifts out of date; "accepted" and "exception" were two names for one thing; severity and deadline alone ignore blast radius |
| D103 | 2026-11-09 | **Blueprints are versioned sets of typed rules** (must use, must not use, must follow, principle) applying to use-case categories owned by the central teams. A use case, a need delivered by initiatives, declares one or more categories and must satisfy all of their blueprints; conformance is per rule and conflicts are computed. Technology direction keeps three axes (stance, internal lifecycle dates, vendor support dates); `SharedPlatform` is an element with `central = true`; external constraints (vendor, regulatory, funding, capacity) are one dependency type | Conflicts can only be detected between comparable rules, and partial satisfaction must be visible; stance, deadline and vendor support are different facts and risk uses the earliest binding date |
| D104 | 2026-11-09 | **Ownership and scope control.** Every node has a mandatory accountable owner in a dated Group → Division → Tower → Stream → Crew hierarchy (one parent per node); optional role owners; domain is a separate, optional concept that may coincide with an org unit. Rollups count distinct items for impact and sum allocations for debt. Every fact carries a last-verified date. Types are few and fixed; sub-types, levels, rule types and thresholds are configuration. Design is in `docs/roadmap-metamodel-design.md`, with five choices confirmed: `SharedPlatform` is an element with `central = true`, `Exception` is a `DebtItem` status, `Finding` is never stored, `Baseline` is a named record time, `follows` is derived from use-case categories. Mapping to the metamodel file and its version bump are not yet done | Domain and organisation sometimes coincide and sometimes do not; stale facts make computed risk look reassuring; a model that grows past the facts its risk signals need becomes an architecture repository |
| D105 | 2026-11-09 | **The roadmap metamodel is `packages/metamodel/roadmap.yaml` (`d4-roadmap` 0.1.0), a standalone metamodel loaded by `loadRoadmapMetamodel()`; it is not a pack on the starter and is not yet offered when a workspace is created.** Elements (`ApplicationElement`, `DataPlatform`, `DataSet`, `DataProduct`, `OutputPort`) extend one `Element` base with lifecycle dates. Business time, scenarios and record time come from the platform (`validFrom`/`validTo`, `scenarioId`, the event log), so ownership, parentage and links are dated without attributes of their own, a scenario is an overlay and a `Baseline` is a named record time. Findings, float, exposure and risk signals are computed, not stored. "Accountable owner on every node" is not a schema rule and is checked by a risk signal | A pack must extend the starter and may not redefine its types, which would have tied the design to a model it was written independently of. Reusing platform time and scenarios avoids a second, parallel time model |
| D106 | 2026-11-09 | **A shared component has one primary delivery.** `DELIVERS` carries a required `responsibility` (`PRIMARY`, `CONTRIBUTING`) and the rule `single-primary-delivery-per-element` allows at most one `PRIMARY` per element in any validity period; an element's ready-by comes from its primary delivery only. A component built by one platform and used by another stays `PART_OF` its builder only; the consumer `USES` it and its milestone `DEPENDS_ON` the builder's (kept in step by hand, as the model cannot enforce it). `CONTRIBUTING` is for genuinely joint delivery. `d4-roadmap` 0.2.0. First evaluation: `packages/metamodel/test/roadmap-eval-platforms.test.ts` (platforms X and Y, components A, B, C, E, five milestones in Q3 and Q4 2026) | The first version let two milestones both deliver the shared component B, so its ready-by was the earlier date and nothing said which platform owned the delivery. The platform already has `uniqueValuePerTarget` for this (as for single-master stores), so no new mechanism |
| D107 | 2026-11-09 | **The roadmap is one Gantt-style view, and the model changes to carry it.** A `Milestone` is a line item with `start` and a required `end`, part of an initiative; it contains `Epic`s (`start`, `end`), part of the milestone, so an epic is the detail of how a milestone is reached. `DEPENDS_ON` links initiatives, milestones and epics, with `dependencyType` (finish-start, start-start, finish-finish, start-finish) and `lagDays`, and is recorded at the finest level; a dependency between epics is rolled up to their milestones with the worst float. Float is computed from the bars, not from one date. Lanes (platform, use case, domain, organisation unit) and the focus window are chosen when the view is opened and are not stored. `REALISES` and `DELIVERS` accept milestones and epics, so a lane can be a use case. `d4-roadmap` 0.3.0. Evaluation: `packages/metamodel/test/roadmap-eval-platforms.test.ts` | A roadmap read as markers on a timeline cannot show duration, nested detail or float. One view with lanes, bars and epics inside milestones answers the questions without a separate lens shape per question; a coarse milestone-to-milestone dependency gives the wrong float (-14 days instead of +5 in the evaluation), so dependencies belong at the finest level. Supersedes the single `date` of D101 |
| D108 | 2026-11-09 | **The business side joins the roadmap model: capabilities, processes and roles.** `Capability` (optional anchor) and `Process` extend `Element`, so they have a lifecycle and dates and are delivered by milestones like any element; a process nests to step level (`ProcessLevel`: L1, L2, L3, STEP) and can have several parents, so a sub-process is shared. `Role` is separate from `OrgUnit` and carries no line of defence (the platform still accepts one as an undefined attribute, D80); `PARTICIPATES_IN` gives the kind of participation. A process `USES` its applications, and a step `READS` data through an output port or a data set (one under a data product, or a current one) and `WRITES` (create, update) data products or data sets, as many as it needs, one link each. `UseCase` is now a scoped change close to an initiative with no dates of its own, linked to an initiative, milestone or epic (`REALISES`) and acting on a process or capability (`CHANGES`, with a configurable `changeKind`). `d4-roadmap` 0.4.0. Supersedes the use-case definition of D103 (a need delivered by initiatives) | Risk should reach business outcomes: a late data product or application shows as a late process change, and a shared sub-process shows every process it serves. A data product's lifecycle includes the processes that create, read and update it |
| D109 | 2026-11-09 | **Dependencies in time are derived from `USES`, `READS` and `WRITES`, not entered twice.** Each end is taken to the line item that primarily delivers it (or the nearest part-of ancestor's), and float is computed finish-finish unless the link sets `dependencyType` and `lagDays`; for `READS` the process depends on the data, for `WRITES` the data product depends on the process. A recorded `DEPENDS_ON` between line items inside the two ends replaces the derived one. Evaluation 2: `packages/metamodel/test/roadmap-eval-process.test.ts`, with the shared kit `roadmap-eval-kit.ts` | The platform evaluation showed that "Y uses B" and "Y's milestone depends on X's milestone" were two facts to keep in step, and a coarse recorded dependency gave the wrong float; deriving the coarse one and letting a recorded finer one win removes the duplicate entry without losing precision |

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
  - deleting a Scenario (or subtype) also soft-deletes its elements, their relationships and its own relationships, each with an audited event (`reason: scenario-deleted`); the baseline is untouched
- **3e done:**
  - `@d4/core`: CRUD-I, capability × application (TIME classes), data store roles and lifecycle heat-map matrices with findings and CSV; `decisionLog` (options, chosen, decided elements, supersession, findings)
  - `GraphQueries.subgraphOf` and `lifecycleCounts`; `GET /v1/workspaces/{ws}/matrix/{kind}` and `/decisions` (REST, OpenAPI, GraphQL), all following `asOf` and `scenario`
  - web: Matrices page (sticky headers, grouped rows, legend, findings, CSV) and Decisions page (search, status filter, record view, "New decision" preselecting the type)
  - fixed the Roadmap scope search squeezing names into the layer-dot column
  - 9 core, 4 Neo4j, 1 API and 4 browser tests
- **Phase 3 (Planning) complete.**
- **Phase 4 plan:**
  - 4a: export formats (CSV, Mermaid, ArchiMate, Cypher) with scope and view; Explorer export control; CLI formats
  - 4b: Excel and CSV import with column mapping, dry run and a validation report (adds `exceljs`)
  - 4c: worker (BullMQ on Redis) for long imports/exports with artefacts in S3
  - 4d: renderer (headless Chromium) for PDF/PNG of graph views and roadmaps
  - 4e: scheduled reports
- **4e done:** `schedules` table and `jobs.schedule_id` (migration 0006), `ScheduleStore` and `claimDueSchedules`; cadence maths and the scheduler tick in `@d4/jobs`; worker polls every 30 s (`SCHEDULER_INTERVAL_MS`); `/schedules` API (list, create, change, pause/resume, delete, run now); "Schedule…" on the Roadmap page and in the Explorer's Export control; Reports page; 3 db, 5 cadence, 1 scheduler, 1 API and 1 browser test
- **Phase 4 (Delivery outputs) complete.**
- **Phase 5 plan:**
  - 5a: tenant administration (workspaces, members and roles)
  - 5b: webhooks from the event outbox (signed, retried, delivery log)
  - 5c: change proposals (draft changes reviewed before they apply)
  - 5d: usage metering and quotas
  - 5e: backup and restore (graph dumps to S3; rebuild a tenant graph from the event log)
  - 5f: per-tenant Neo4j provisioning (provisioner interface; Docker driver locally, Kubernetes/Helm later)
  - 5g: SDK from OpenAPI and ui-kit publishing
- **5a done:** `/v1/admin` workspaces (create on the active metamodel, rename, archive, restore), users, and members per workspace or tenant-wide (grant/revoke; self-lockout guard); Admin page (admins only); stores `listAll`, `update`, `setArchived`, `activeId`, `UserStore.list`, `RoleStore.bindings`; 2 db, 1 API and 2 browser tests
- **5g (ui-kit) done:** `@d4/ui-kit` with `Gantt`, `GraphCanvas` and `ResultTable` moved out of the web app (history kept) and decoupled from it (core types, a link-render prop, the theme event exported by the kit), `styles.css` with token fallbacks; the web app consumes it. 3 component tests (jsdom). Publishing it also needs `@d4/core`, `@d4/metamodel` and `@d4/render` published; the SDK has no dependencies
- **6f done:** `git` connector kind (`readGitModel`, `modelToMapped`) and model-mode kinds in the sync job (commit and files in the run result); `planSync` resolves relationship ends given as existing element ids; Git option in the Connectors form; `git` in the Docker images; 3 connector (real local repositories) and 1 jobs (Postgres + Neo4j) test
- **6g done:** banking and insurance packs (`packages/metamodel/packs/`), `composePack`, `loadMetamodelPack`, `describeMetamodelPacks`; workspace creation with `metamodel` (registers the pack and applies its schema), `GET /v1/admin/metamodel-packs`, metamodel shown per workspace; Admin page picker; fix: `applySchema` no longer drops relationship-id indexes other metamodels use. 3 metamodel, 1 schema, 1 API and 1 browser test
- **6a done:** `connectors` and `connector_items` (migration 0012); `@d4/connectors` (mapping, HTTP/JSON source with bearer/basic auth and link paging, `planSync`); sync jobs and scheduled syncs in the worker; admin `/connectors` API (kinds, CRUD, sync, dry run, runs) with OpenAPI and SDK; Connectors section on the Admin page; 7 connector, 3 jobs (Postgres + Neo4j) and 1 API test. Committed before the browser test (`connectors.spec.ts`) and the full suites had run, because Neo4j was restarting; the local stack was then slimmed for an 8 GB machine (Neo4j without the unused GDS plugin, ~1.2 GB, small transaction logs; db tests serialized)
- **Phase 6 plan:**
  - 6a: connector framework (per-workspace connectors, source config and credentials, field mapping, schedules; sync runs as jobs through the import planner with dry run, one atomic change, run log and conflict report) and a generic HTTP/JSON connector
  - 6b: ServiceNow CMDB adapter (applications, platforms)
  - 6c: DataHub and Collibra adapters (data products, lineage)
  - 6d: LeanIX adapter (capabilities)
  - 6e: Jira / Azure DevOps two-way deliverable status sync (first outbound writes)
  - 6f: Git model-as-code sync
  - 6g: industry metamodel packs (banking, insurance), chosen at workspace creation
  - 6h: performance for 1M-node tenants (synthetic generator, benchmarks against the targets, tuning)
  - Adapters follow each vendor's documented API and are tested against local fakes; each is marked unverified until run against a real instance
  - **Scope decision (2026-10-20): 6b, 6c, 6d, 6e and 6h are skipped for now; 6g, then 6f, are built**
- **Phase 5 (SaaS) complete** (both packages publishable with `pnpm pack`, still `private`)
- **5g (SDK) done:** `@d4/sdk` (generated `paths` types, `createClient`, `D4ApiError`, `allElements`, `waitForJob`), `apps/api/src/scripts/openapi.ts`, `/v1/me` documented, route-coverage and drift tests; the packed tarball installs into an empty project and talks to the local API. 6 SDK and 3 API tests
- **5f done:** `InstanceDriver` with a manual driver, `provisionTenant` (re-runnable; tenant kept suspended until ready), `checkTenant`, operator CLI `tenant-cli` (create, list, check, suspend, resume, delete) and `dev.sh tenant-create`, `tenant`, `tenant-remove`, `tenant-user`; `TenantGraphs` with `NEO4J_HOSTS` routing, `file:` secrets and the `:D4Tenant` claim check; jobs refused for inactive tenants; secrets mounted into api, worker, renderer and db-migrate. Verified live with a second tenant `t_acme` on its own Neo4j: separate workspaces, writes land only in its database, 404 across tenants, catalog and backups work. 2 routing, 3 isolation (Postgres + Neo4j) and 1 API isolation test. Not yet: a Kubernetes driver, deleting a tenant's data, per-tenant Keycloak realms. Also: Neo4j's off-heap memory is now capped (it was OOM-killed under test load), and the graph package runs its test files one at a time
- **5e done:** `graph_backups` and `workspaces.locked_reason` (migration 0011); `replayEvents`, `compareStates`, `canonical` in `@d4/core`; `readWorkspaceGraph`, `replaceWorkspaceGraph` in `@d4/graph`; backup, verify, restore and rebuild jobs, daily backups and pruning in the worker; `LOCKED` error (423) for writes during a restore; `/backups` API (admin) and a Backups section on the Admin page; jobs page wording; 4 core, 5 jobs (Postgres + Neo4j: drift, rebuild, restore with later changes, lock, damaged file), 1 API and 1 browser test. Verified on the dev workspace: 884 events replay to the live graph exactly. Known gap: if the queue delivers a restore job twice at once, the duplicate fails on the lock and can mark the job failed although the first run succeeded (verify shows the true state)
- **5d done:** `tenant_quotas` and `usage_daily` (migration 0010), `UsageStore`, operator tool `set-quota` (`deploy/dev.sh quota`); `@d4/jobs` limits, `GraphQuotaGuard` in the event sink, job/query-run/workspace checks, hourly `meterUsage` in the worker; `QUOTA_EXCEEDED` error; `GET /v1/admin/usage` and a Usage section on the Admin page (bars and 30-day trend); 4 jobs, 1 API and 1 browser test. Billing hooks beyond the daily readings are not built
- **5c done:** `change_proposals` (migration 0009), `ProposalStore`, `withLockedProposal`; `stageProposal` in `@d4/core` (staging repository that overlays reads, including rule checks such as one master per product and dependency cycles); `/proposals` API (list, create, get with a readable line per step and a live check, edit, delete, submit, back to draft, withdraw, approve, reject) and a `review` access level (architect, admin); Proposals page (list, step builder for new elements, attribute changes, connections and deletions, review box); 5 core, 1 API and 1 browser test. Not yet: proposing from the element editor, and comments beyond the review comment
- **5b done:** `webhooks` and `webhook_deliveries` (migration 0008), `WebhookStore`, `relayEvents`, `claimDueDeliveries`, `recordAttempt`; signing, URL checks and the sender pass in `@d4/jobs`, run by the worker every 5 s (`WEBHOOK_INTERVAL_MS`); `/v1/admin/webhooks` (list, create, change, turn on/off, delete, rotate secret, test ping, deliveries, send again); Webhooks section on the Admin page; 5 jobs (2 with Postgres and a real HTTP receiver), 1 API and 1 browser test (a signed ping to a receiver in the test). Known gap: DNS is resolved separately from the request, so a name that changes address between the check and the send is not caught
- **Phase 4 follow-ups done:** owner access re-checked on every scheduled run (realm roles stored at sign-in, migration 0007; schedule paused with a reason); report emails via SMTP with Mailpit locally (attachment up to 5 MB, else a link; delivery shown on Reports); import uploads deleted when the import ends and files pruned hourly after 30 days
- **4d done:** `@d4/render` (roadmap and graph SVG, radial layout with no overlaps, page wrapper with paper sizes); `render` jobs (`POST /jobs/render`: roadmap or graph, SVG/PNG/PDF, A4/A3/fit) on the `d4-render` queue; `apps/renderer` (Chromium via playwright-core 1.47.2, 2× PNG, inlined Source Sans 3) with Docker target and compose service (768 MB, one render at a time); Roadmap page and Explorer picture buttons; `renderer-local`; zod errors recognised by shape (dual CJS/ESM builds); 4 render, 1 jobs, 1 renderer (Chromium, in its image), 1 API and 2 browser tests
- **4c done:** `jobs` table (migration 0005) and `JobStore`; `@d4/jobs` (tenant routing and model handles moved out of the API, export and tabular-import work moved out of the controllers, S3 artefact store, BullMQ queue, `processJob`); `apps/worker` with health endpoint, Docker target and compose service; `POST /jobs/export`, `POST /jobs/import-tabular`, `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/artifact`; web "In background" for export and import plus a Jobs page; `worker-local`; 3 db, 6 jobs, 2 worker, 1 API and 2 browser tests (real Redis queue and S3 in tests)
- **4b done:** `@d4/codecs` tabular reading (RFC 4180 CSV, `.xlsx` via exceljs with dates/formulas), mapping suggestions (sheet name → type, headers → fields/attributes, real attributes before aliases), typed coercion with row/column issues, and Excel export; `POST /import/tabular/analyze` and `POST /import/tabular[?dryRun=true]`; Import wizard page (files → mapping per table → check → import); 7 codec, 1 API and 1 browser test, including CSV and Excel round trips of the sample with zero changes
- **4a done:** `@d4/codecs` exports with 7 tests; `GET /v1/workspaces/{ws}/export?format=&scope=&depth=&asOf=&scenario=` (file download with name; CORS exposes `content-disposition`); Explorer "Export" control (this graph or the whole workspace, in the current view); `d4 export --format … --as-of … --scope …`; 1 API, 1 CLI and 2 browser tests

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
