# ADR 0007: Skill Hub

**Status:** Proposed, 2026-10-21. Builds on [ADR 0006](0006-conversational-change-workspace.md); nothing here is built.

## Context
ADR 0006 defines skills as versioned, declarative units and says they ship in the repository. That ties every new or fixed skill to an agent release and gives no place to search, review, evaluate or retire them. We want skills delivered to the agent from a remote URL, discovered and fetched when needed, under operational governance covering create, update, evaluate, archive and discover. This component is the **Skill Hub**.

A remote source of instructions and tool permissions is a supply-chain risk: a changed skill changes what the agent may do. The Hub therefore borrows the controls the Query Catalog already uses (ADR 0002, D28, D29).

## Decision

### 1. What the Hub is
A service with a REST API (control plane) and a web area, owning the skill registry, plus a CDN-like static delivery of the skill packages (data plane, section 5). The agent is configured with the Hub's base URL and fetches from it; it holds no skills of its own except those built into its image (section 8). It runs in the same tenancy and auth model as D4 (Keycloak token, `tenant` claim), as its own deployable (`apps/skill-hub`), with metadata in Postgres and package files in S3.

### 2. Skill package
An immutable, content-addressed bundle (canonical-JSON SHA-256, as D29) containing declarative data and, optionally, **scripts** (section 8):
- manifest: id, version, title, description, example requests, owner, required role, risk class;
- input and output schemas (JSON Schema) and the allowed operation kinds;
- prompts and few-shot examples;
- **tool allow-list** by MCP server and tool name (what the gateway will permit for this skill);
- dependencies: minimum agent version, MCP servers required;
- optional `scripts/` with the declared capabilities of each (section 8);
- the evaluation set and the latest evaluation report.

### 3. Lifecycle (enforced by service and database trigger, like D28)
`draft → in_review → approved → published → deprecated → archived`. In review can return to draft. Published versions are immutable; a change is a new version. Deprecated versions still run for drafts that pinned them but are not offered for new work. Archived versions are hidden from search and refused for new drafts; they are never deleted, so history stays reproducible.

### 4. Operations and who may do them

| Operation | What happens | Role |
|---|---|---|
| Create | New skill and first draft version, from a template | `skill-author` |
| Update | New draft version from a published one; diff against the previous version is shown | `skill-author` |
| Evaluate | Runs the evaluation set against a chosen model and fixed fake tools; stores a report (valid-draft rate, routing accuracy, invalid submissions, cost) | automatic on submit, and on demand |
| Review | Checks the diff, the tool allow-list and the evaluation report; approves or sends back with a reason | `skill-steward`, never the author (admins excepted) |
| Publish | Enables a version for a scope (section 6); needs a passing evaluation and, for the first release, the human review sample (ADR 0006, decision 6) | `skill-steward` |
| Deprecate / archive | Withdraws a version or a whole skill, with a reason | `skill-steward` |
| Discover (search) | Full-text and example-based search over title, description and example requests, filtered by use case, status, risk class and tag; shows usage and evaluation score | any signed-in user |
| Audit | Every transition, evaluation and fetch is logged with actor and version | `skill-steward`, admin |

Widening a tool allow-list or raising the risk class always needs a steward review, even for a one-line change. This reverses nothing in ADR 0006 decision 2 except where skills live: authors are still a small trusted group, now using the Hub instead of pull requests.

### 5. Delivery: the Hub behaves like a CDN
Delivery is split into a **control plane** (the Hub API: lifecycle, review, evaluation, search) and a **data plane** (static, cacheable skill content). The agent's runtime path touches only the data plane, so the Hub can be down or busy without stopping agents.

- **Immutable objects at content-addressed URLs.** Each package is served at `/skills/<id>/<version>/<sha256>/package.tgz` and its signed manifest next to it, with `Cache-Control: public, max-age=31536000, immutable`. Because the hash is in the path, any cache, mirror or browser can hold it forever and a changed skill is a new URL.
- **Small mutable pointers, short TTL.** A **channel index** per tenant scope (`/channels/<scope>/stable.json`, `/channels/<scope>/index.json`) lists published `id@version` with hashes, summaries and tool allow-list digests. It is the only mutable object, served with a short TTL (about 60 s), an `ETag` and `stale-while-revalidate`, and carries a sequence number and signature so a stale or replayed index is detectable.
- **Edge and mirror tiers.** The data plane is plain HTTP files, so it can sit behind nginx caching (`proxy_cache`, `proxy_cache_use_stale`, request coalescing) in each deployment, a regional mirror, or a real CDN. An on-premises tenant runs a **mirror** that pulls platform skills from the origin Hub and serves its agents locally; the mirror needs no trust beyond the signing key, because every object is verified by signature and hash.
- **Verify, don't trust the path.** The agent verifies the manifest signature (Ed25519, trusted public key configured in the agent, never from the response) and the package hash, then caches by hash on disk. A cache or CDN can therefore be untrusted.
- **Discovery.** Plain listing and browsing use the channel index. Request-to-skill matching is a control-plane call (`POST /v1/skills/match` with the text and context, ranked published summaries for the tenant); its result names `id@version`, and the agent fetches that version from the data plane. Tenant text goes only to the control plane, never to caches.
- **Pinning.** A draft records the `id@version` used for each revision. Follow-up turns use the same version even if a newer one is published; rebasing may move it only on user request. Because versions are immutable and cached, a pinned version stays fetchable for as long as it is not archived-and-purged.
- **Withdrawal.** Deprecating or archiving a version publishes a new channel index without it and adds it to a signed **revocation list** (same TTL as the index). Agents check the list on each new draft and on resume, and refuse revoked versions; the immutable object may stay cached but is never offered. A purge request is sent to the caches for cleanup, but correctness does not depend on it.
- **Failure.** If the origin is unreachable the agent uses the last good channel index within a grace period and any cached package, so pinned drafts continue; it cannot start work that needs an uncached skill or a revoked-status check beyond the grace period (fail closed past it).

### 6. Scope and tenancy
Skills are **platform** (published by the product team for all tenants) or **tenant** (private to one tenant, authored by that tenant's `skill-author`s). A tenant admin enables platform skills per workspace and may disable any skill. A tenant skill can only reference tools the tenant is allowed; it cannot widen platform tools. Tenant data in evaluation sets never leaves the tenant.

### 7. Link to the gateway
The tool allow-list in each published package is the source of the gateway's allow-list file (ADR 0006, decision 1). A publish or archive regenerates that file and triggers a reload in the nginx gateway. The gateway never reads the Hub at request time. The agent's skill header (signed) must name a published `id@version` the gateway knows.

### 8. Scripts delivered by the Hub
A skill may include scripts for work a model should not do itself: parsing a file format, fuzzy-matching names, computing a diff, calling a deterministic transformation. Scripts travel in the same signed, hashed package and the same CDN-like delivery, so they are versioned, reviewed and revocable like the rest of the skill.

**The script sandbox is part of the agent harness.** The harness starts it for a run with the package hash, the script name and a JSON input; scripts never run in the API or the gateway. Because the harness process holds the user's token, the sandbox is an isolated child of it, not a thread or module inside it:
- fresh isolated environment per run (container with a user-space kernel or microVM, read-only root, empty scratch directory, non-root, all capabilities dropped);
- **no network, no credentials, no D4 token, no access to Postgres, Neo4j, Redis or S3**; input and output are the only channels;
- hard limits on CPU time, wall time, memory, processes, input and output size, set per skill within platform maxima;
- supported languages: **Python 3.12 and TypeScript** (further languages need a new ADR). TypeScript runs on Deno, executed inside the same isolation boundary; **Libraries and files belong to the skill and its owner, not to the platform:** the package vendors its own pinned dependencies (wheels or sources with hashes) and data files, and the sandbox installs nothing at run time and has no shared site-packages;
- **per-tenant separation:** the sandbox's package cache, scratch space and any cached libraries are keyed by tenant and skill `id@version`; a tenant's libraries and files are never visible to another tenant's runs, and sandboxes are not reused across tenants;
- the result is JSON validated against the script's declared output schema. It is data, never instructions: it feeds the skill's normal draft step and can only become proposal operations after the usual schema and registry checks (ADR 0006 section 8).

**Declared capabilities.** Each script declares what it needs (runtime, limits, `network: none`, optional read of the user's attached files). Anything beyond the default minimum, such as an outbound allow-list of hosts, is a higher risk class, must be approved by a steward and enabled by the tenant admin, and is refused for tenant skills unless the platform allows it. Scripts that need a source system's data get it through a gateway tool in the skill's allow-list, not by calling out themselves.

**Size limit.** A skill package, including its scripts, vendored libraries and data files, is at most **10 MB in total**. The cap is checked on the unpacked contents (so compression cannot hide size), together with limits on file count, path depth and no links or device files; the Hub refuses larger packages at upload and the agent refuses them at fetch.

**Ownership.** The skill owner (the `skill-author` group of the owning tenant, or the platform team for platform skills) owns the scripts, vendored libraries and files of a skill: they update them, respond to vulnerability notices, and are accountable for their licences. The Hub records the owner on every version. An archived or revoked skill's files are removed from the sandbox caches.

**Governance on top of section 4.**
- A skill with scripts is risk class **executes code**. It needs the author, a steward, and security approval from **both the tenant and the platform operator** (`skill-security` role held on each side) before publishing; none may be the author. Each side is accountable for its own approval: the tenant for what its users' data is exposed to and what the skill does for its business, the platform operator for the safety of the shared harness and sandbox. Any version that changes scripts, dependencies or declared capabilities needs both approvals again; a text-only change (prompts, examples) needs the tenant's steward only. Platform skills are approved by the platform operator's two sides (author team and security).
- Submit runs an automatic scan: forbidden imports and calls, vulnerability and licence scan of the vendored libraries, hash check against the lockfile, secrets pattern scan, size limits. A scan failure blocks review.
- The evaluation runs the scripts in the sandbox, including adversarial cases (oversized input, infinite loop, memory spike, attempts to read the environment or reach the network) which must fail safely.
- A tenant admin must explicitly allow script-bearing skills per workspace; the default is off. Tenant-authored scripts follow from per-tenant ownership; see the open question on who performs the security review.
- Every execution logs tenant, user, skill `id@version`, script hash, limits, exit status, duration and byte counts; inputs and outputs are not logged.
- Revoking a skill version also revokes its scripts. The sandbox checks the revocation list before each run, so cached bundles cannot execute after withdrawal.

**Sandbox technology: evaluation (proposed choice: gVisor).** Requirements: strong isolation from the process holding user tokens; runs Python 3.12 and TypeScript with arbitrary vendored pure-code libraries; no network by default; start-up well under a second to a few seconds; open source with an active community; usable in SaaS and on-premises without nested virtualisation; manageable from the harness without root on the host.

| Option | Isolation | Fits the requirements | Weak points |
|---|---|---|---|
| **gVisor (`runsc`)** | User-space kernel intercepts syscalls; the host kernel is not exposed to the script | OCI container, any Python/Deno code and wheels, no KVM needed, per-run start in the order of 100s of ms, rootless mode available | Syscall overhead on I/O-heavy code; some syscalls unsupported; needs the host to allow `runsc` |
| Firecracker microVM | Hardware virtualisation, strongest boundary | Excellent isolation, fast boot | Needs KVM, so bare metal or nested virtualisation; a rootfs and guest agent to build; heavier to run on-premises and on laptops |
| Kata Containers | microVM behind the container API | Isolation like Firecracker with OCI tooling | Same KVM requirement; more moving parts |
| nsjail / bubblewrap with seccomp | Namespaces and syscall filter on the shared host kernel | Very light, fast, simple | A kernel bug is a host bug; weaker boundary for tenant-authored code |
| WebAssembly (Wasmtime; Pyodide, QuickJS) | Language-level sandbox, capability-based | Strong, no kernel exposure | Python wheels with native code mostly do not run; the TypeScript path differs; limited library compatibility with the vendored-library model |
| Deno permissions alone | Process-level flags | Good defence in depth for TypeScript | Not an isolation boundary on its own; Python has no equivalent |

Reasoning: tenant-authored code with vendored libraries rules out Wasm as the only mechanism, and bare process sandboxes rely on the host kernel. gVisor gives a strong boundary with ordinary container tooling and no KVM requirement. Deno's permission flags (no net, no env, no filesystem outside the scratch directory) and Python's restricted environment are layered inside it. Firecracker stays the upgrade path for deployments with KVM that want hardware isolation for the highest risk class.

Harness requirements that follow: the harness must **not** mount a container-engine socket (that is root on the host); it starts `runsc` directly with an OCI bundle it builds per run, rootless, with a seccomp profile, read-only root, no network namespace, a small tmpfs, cgroup limits and an empty environment. For local development on macOS or Windows, where gVisor is unavailable, a plain hardened container is used behind a compose profile and the isolation tests run only in Linux CI.

**Evaluation spike (acceptance before this ADR is accepted):** build the same adversarial script suite for Python and TypeScript (fork bomb, memory spike, infinite loop, network connect, reading `/proc` and the environment, writing outside scratch, symlink and path tricks, 10 MB package unpacking) and run it under gVisor, a hardened container baseline and, where KVM exists, Firecracker. Compare: all attacks contained, p50/p95 start-up and run overhead on a 100 ms script, memory per sandbox, concurrent runs on an 8 GB laptop and a 2-vCPU server. gVisor is confirmed if every attack is contained, p95 start-up is under 2 s, and 4 concurrent runs fit the budget; otherwise the next option in the table is evaluated.

**Code that is too deep for a script** (a dedicated graph or long-lived logic) still lives in the agent's codebase and is referenced from a manifest as `implementation: builtin:<name>@<version>`; the Hub can enable, evaluate and retire it but cannot change it.

### 9. Web area
A "Skills" area in the Hub UI, linked from the Describe a change screen: search, skill page (versions, diff, evaluation reports, usage), a test console that runs a draft version against sample requests without touching any model, and the review queue for stewards. Navigation follows the single-model rule in `nav.tsx`.

## Alternatives considered
- **Skills only in the repository (ADR 0006):** safe, but every skill change needs an agent release and there is no search or governance. Rejected as the end state, kept for built-in implementations.
- **Hub delivers code that runs inside the agent (plugins):** a remote code-execution path into a process holding user tokens. Rejected. Scripts are allowed only in the isolated sandbox with no credentials or network.
- **Declarative skills only, no scripts:** safest, but pushes every deterministic transformation into the model or into agent releases. Rejected in favour of sandboxed scripts.
- **Use a generic registry (OCI or package registry) with no Hub service:** gives storage and versions but no lifecycle, evaluation or search tailored to skills. Rejected; the package format can still be an OCI artefact later.
- **Agent reads skills directly from Git:** no review states or evaluation gate beyond PRs. Rejected.

## Consequences
- A new service, tables and web area to build and run; roles `skill-author`, `skill-steward` and `skill-security` are added to the role model.
- The agent depends on the Hub's control plane only for new matches; the cached data plane limits the impact of outages. Tenant-private packages need access control at the edge (signed, short-lived URLs), which a pure public CDN does not give.
- Signing and key management become an operational duty (rotation, revocation list for withdrawn versions).
- The sandbox lives in the agent harness, so a sandbox escape would reach the process that holds user tokens. Isolation must therefore rely on an OS-level boundary (container with a user-space kernel, or a microVM), with the user token never in the child's environment, memory or filesystem; the harness image is kept minimal and its dependencies are scanned.
- Skill owners carry the maintenance of their libraries; stale or vulnerable libraries are surfaced by a scheduled rescan that can deprecate a version. Locally it must fit the 8 GB budget (D49), so it sits behind a compose profile and runs one script at a time.
- Skill quality is governed by evaluation reports, so the evaluation runner must be deterministic enough to compare versions (fixed fake tools, recorded model settings).
- Evaluations cost model calls; they count against the tenant AI quota or a platform budget (see questions).

## Open questions
1. **Hosting model:** one origin Hub for all customers (SaaS) fronted by a CDN, with per-deployment mirrors for on-premises tenants, or per-deployment Hubs only? Which CDN or cache product serves the data plane, and are tenant-private packages served from the shared edge (signed URLs) or only from the tenant's own mirror?
2. **Signing:** who holds the signing key, how it is rotated, and how a withdrawn version is revoked in agents already running.
3. **Search:** Postgres full-text only, or embeddings for matching plain-English requests to skills? Embeddings send skill text, not tenant data, but add a model dependency.
4. **Evaluation budget and model:** who pays for evaluation runs, and which models must a skill pass on before it is published.
5. **Cross-tenant sharing:** can a tenant publish a skill to others or to the platform, and through what review?
6. **Risk classes:** the list of classes (read-only analysis, proposes changes, bulk changes) and what each requires to publish.
7. **Retention:** how long archived packages, evaluation reports and fetch logs are kept.
8. **Supply chain under the 10 MB cap:** the allowed licence list and rescan schedule. The cap rules out large native libraries (for example numerical or data-frame packages); should the platform offer a small set of shared, vetted libraries outside the cap, or do such skills belong in the agent codebase?
9. **Dual approval mechanics:** the service-level target and escalation for the platform operator's security approval, so tenant publishing is not blocked indefinitely.
10. **Human review pilot:** sample size, reviewers and exit criteria per skill before general enablement (ADR 0006, decision 6), and how pilot results are stored with the skill version.
