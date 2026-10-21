# ADR 0006: Conversational change workspace and agent platform

**Status:** Proposed, 2026-10-21. Extends [ADR 0005](0005-ai-assisted-ingestion.md); nothing here is built.

## Context
Users know what they want ("retire the two legacy payment systems and move their dependents to the new gateway") but not the metamodel, the import mapping or the proposal editor. Today they must pick the right page, learn its vocabulary and move between Import, Explorer, Roadmap and Proposals. ADR 0005 covers AI inside the import flow. This ADR covers the larger shape: one screen driven by plain English, backed by an agent platform made of many skills.

Requested technology: LangChain and LangGraph for the agent runtime, a skill per use case, and an MCP gateway that routes tool calls to the right MCP server.

## Decision

### 1. One screen: "Describe a change" (behaviours 1–5)
- **Intent.** The user types free text, optionally attaching a file or pasting data. The workspace, current selection and time scope are passed as context, not asked for.
- **Draft.** The selected skill produces a draft made only of existing change-proposal operations (D43) and import mappings (D36). Nothing touches the model.
- **Evolve.** Follow-up messages revise the same draft. The preview shows the diff (new / changed / removed), validation issues in plain language and on-demand analyses (section 5). The user can also edit operations directly; edits count as revisions.
- **Submit.** One action submits the whole set as one change proposal, reviewed and approved or rejected as a whole through the existing flow. The screen then shows status and reviewer comments, so the user never leaves it.
- **Placement.** A page in the "Plan and govern" nav group (`nav.tsx`), with the workspace route `/w/:ws/change`. Proposals and Import stay for direct, expert use.

### 2. The draft is a proposal in `draft` status
No new write path. The draft is a `change_proposals` row (D43) plus an append-only list of **revisions**: user message, skill used, operations before and after, validation result. Reasons: the proposal already replays steps through `ModelService` on a staging layer, so every check is the same as for a direct edit; revisions make a session reproducible and auditable. Each revision is stored with the model and prompt versions. A new table is expected; its design is deferred.

### 3. Agent runtime: LangGraph
- One **orchestrator graph** (LangGraph) with nodes: understand intent → select skill → run skill graph → validate → summarise for the user → wait for the next message. Conversation state is checkpointed per draft, so a session can resume after a restart.
- LangChain supplies model, structured-output and tool abstractions. The model sits behind the `AiProvider` interface from ADR 0005; the runtime must not depend on one vendor.
- **Language: LangGraph Python, as a separate service `apps/agent`.** It is not part of the API process: it needs long-lived streaming runs and its own scaling, and it must never hold database credentials. Reasons and trade-offs are in "Language choice" below.
- The agent calls D4 only through the public REST API with the **user's own token**, so tenant routing, roles, quotas and optimistic locking apply unchanged. It has no Neo4j, Postgres or S3 access.

### 4. Skills
A skill is a versioned, declarative unit:
- name, description for routing, and example requests;
- input schema and **output schema** (zod/JSON Schema), whose output is always proposal operations, an import mapping, or a question to the user;
- the **allowed tools** (by MCP server and tool name) and allowed operation kinds;
- required role, and whether it may use attached files;
- an evaluation set (requests with expected outputs).

Candidate first skills: import spreadsheet, rename / re-parent, retire a system and re-point dependents, add or remove dependencies, bulk attribute fix, lifecycle change, connector mapping (ADR 0005 item 4). Each skill is its own LangGraph subgraph. Skill selection is a router step with a confidence; below a threshold, or when two skills tie, the agent asks the user a plain-language question rather than guessing. Skills are registered per tenant and can be switched off.

### 5. Analyses
Analyses are tools, not free-form model output; they read from existing code and report numbers the model only narrates.

| Analysis | Served by |
|---|---|
| Diff of the draft against the live model | `stageProposal` (D43) |
| Rule and metamodel violations | `validateModel`, `rules.ts` |
| Impact on dependents / lineage | catalog queries (system pack), run through the catalog, never raw Cypher |
| Roadmap and date effects | roadmap engine in `@d4/core` (D31) |
| Compare with another scenario or date | model views and compare (D33) |
| Import dry run | `tablesToImport` / `planImport` (D36) |

### 6. MCP gateway
- All tools are exposed as MCP tools. A **gateway** is the agent's only tool endpoint. It routes by tool name to the owning MCP server, and enforces per-skill allow-lists, the user's identity and tenant on every call, rate limits and quotas, a call log, and a timeout / size cap on results.
- First servers: **D4 model server** (reads and the proposal-draft operations, a thin wrapper over the REST API); **analysis server** (section 5); **file server** (parse uploaded CSV / Excel into tables). Later: source-system servers (CMDB, Git, ticketing) that replace hand-written connector mappings.
- Third-party servers are untrusted: their output is data, never instructions, and they cannot reach the D4 token. Servers register through the gateway, not directly with the agent.
- The D4 server exposes **no tool that writes to the model**. The strongest tool is "update the draft proposal".

### 7. Permissions and approval
Drafting needs write access to the workspace; submitting is the author's action; approval needs architect or admin and never the author (D43). A skill cannot grant itself more than the user's role. The approver sees the original request, the revision history and the final operations, not only the result.

### 8. Failure, governance and cost
- Output that fails schema or registry validation is **rejected, not repaired**. The agent retries up to a fixed limit with the error, then tells the user what it could not do; it never submits a partial draft silently.
- Per-run limits on steps, tool calls, tokens and wall time, plus the tenant quota from ADR 0005 (`aiCallsPerDay`, later counting runs).
- Off by default per tenant. Same data disclosure as ADR 0005; attached file contents leave the deployment only to the configured provider.
- Each run records tenant, user, skill, model, tool calls and token counts; prompts and results are not written to general logs.
- Tracing (LangSmith or OpenTelemetry via the existing collector) must be self-hostable; no trace may leave a tenant's boundary without the same opt-in.

## Language choice
**Decision: LangGraph Python (with LangChain Python) as its own service.** Decided 2026-10-21.

Why Python:
- LangGraph and LangChain are developed Python-first. Checkpointers, streaming modes, human-in-the-loop interrupts, the evaluation tooling and most documentation and examples arrive there first, so we avoid building on the lagging port.
- The agent will accumulate skills that benefit from Python libraries (document and table parsing, fuzzy matching, evaluation harnesses).
- The agent is isolated from the monorepo's CommonJS/ESM and zod quirks (DEVELOPER_GUIDE §9).

Costs we accept, and how we contain them:
- **No shared code with the TypeScript packages.** The contract between the two sides is generated, not copied:
  - The agent's D4 client is generated from the API's OpenAPI document (`packages/sdk/openapi.json`, already committed and checked by `apps/api/test/openapi.test.ts`).
  - Proposal operation schemas and skill input/output schemas are published as JSON Schema from the zod definitions and loaded as Pydantic models in the agent. A contract test fails when the two drift.
  - D4 remains the only authority on validity: the agent's own checks are advisory, and `stageProposal` (D43) decides.
- **A second toolchain**: Python version and lockfile (uv or pip-tools), a Docker target, ruff, mypy, pytest, and a CI job. It is wired into `deploy/dev.sh` (`agent-up`, `agent-test`), and the agent service sits behind a compose profile so the base stack stays within the 8 GB budget (D49).
- **Two languages for contributors.** Skills are the main extension point, so a skill is a declarative package (schemas, prompts, tool allow-list, evaluation set) with a small Python subgraph only where a skill needs custom logic.

Boundaries that keep the choice reversible: the agent talks to D4 only through REST with the user's token, and to tools only through the MCP gateway (section 6). The web screen talks to the agent through a thin proxy in the API, so the browser has one origin, one auth path and one quota check, and the agent's address stays internal.

Spike (acceptance for this ADR, not a language gate; it also confirms the njs points above): one skill, "retire a system and re-point dependents", must route from plain English, produce a valid draft through the gateway with the user's token, resume from a Postgres checkpoint after a restart, stream progress to the browser through the API proxy, and run its evaluation set in CI against the fake provider.

## Alternatives considered
- **Agent writes to the model directly:** removes review. Rejected.
- **LangGraph JS in the monorepo:** shares schemas and the SDK, but trails Python in features and community answers. Rejected in favour of Python; the shared-contract cost is handled by generated schemas.
- **Agent inside the API process:** couples release cycles and gives the agent database reach. Rejected.
- **Direct tool wiring per skill, no gateway:** repeats auth, limits and logging in every skill. Rejected.
- **Free-form analysis by the model:** unverifiable numbers. Rejected; analyses are tools.

## Consequences
- A new Python service (own image, uv lockfile, CI job), an MCP gateway and servers to run, secure and observe; heavier local stack (8 GB laptop limit, D49), so the agent service is optional in `docker-compose` (profile).
- Quality depends on per-skill evaluation sets and a routing evaluation; model output is not deterministic.
- Revision history grows storage; retention needs a rule.
- New skills are additive: schema + tool allow-list + evals, no change to the approval flow.

## Decisions on the former open questions (2026-10-21)
1. **Gateway: nginx reverse proxy** (changed 2026-10-21 from "adopt an open-source MCP gateway"). nginx is already in the stack (web, deploy/nginx), so there is nothing new to vet or run. It routes `/mcp/<server>/` to the owning MCP server and covers transport concerns:
   - routing by path to each MCP server, with Streamable HTTP / SSE support (`proxy_buffering off`, long `proxy_read_timeout`, HTTP/1.1 upstream);
   - TLS, per-tenant and per-user rate and connection limits (`limit_req`, `limit_conn`, keyed on headers the policy step sets), request and response size caps and timeouts;
   - structured access logs with tenant, user, skill and server (JSON log format);
   - the caller's user token forwarded unchanged to the server.

   nginx alone cannot read MCP calls: the tool name is inside the JSON-RPC body, and it has no native JWT or per-skill policy. **Policy is written in njs** (nginx JavaScript, loaded with `js_import` from `deploy/nginx/`), so the gateway is one process with no extra service to run:
   - A `js_content` handler on the `/mcp/` locations reads the request body (size-capped by `client_max_body_size`), parses the JSON-RPC message, and for `tools/call` checks the tool name against the calling skill's allow-list. A JSON-RPC **batch** is checked item by item; one denied item denies the whole batch. Anything it cannot parse, or any method not on a short allow-list (`initialize`, `tools/list`, `tools/call`, `ping`, notifications), is refused (fail closed).
   - It verifies the bearer token (RS256 through `crypto.subtle`) against Keycloak's JWKS, fetched with `ngx.fetch` and cached in a `js_shared_dict_zone` with a short TTL and a forced refresh on an unknown `kid`. It checks issuer, expiry and the `tenant` claim exactly as `AuthService` does.
   - The skill name arrives in a header signed by the agent (HMAC with a key shared only by the agent and the gateway); an unsigned or unknown skill is refused. The allow-lists are a JSON file generated from the skills at build time and loaded when nginx starts.
   - On success it sets `X-D4-Tenant`, `X-D4-User` and `X-D4-Skill` for limits and logs, and hands the request to the proxy location with `r.internalRedirect`, so the response **streams through nginx's own proxying** rather than being buffered by njs. The tool list (`tools/list`) is answered from the static registry, filtered to the skill's allow-list.
   - Servers still re-check the token and tenant themselves; the gateway is not the only line of defence.

   Consequences and limits of njs:
   - njs is a restricted JavaScript subset with no npm packages, a single thread per worker and no blocking I/O, so the handler must stay small and fast; heavy logic does not belong in it.
   - Keeping the policy as pure functions (token claims, message, allow-list in; decision out) lets it be unit-tested in plain Node without nginx, plus a container-level test through real nginx.
   - Whether `r.internalRedirect` keeps the already-read request body for the proxied request, and how Streamable HTTP / SSE behaves through it, must be confirmed in the spike. If either fails, the fallback is the `auth_request` pattern with the same njs code, or a small policy service.
   - No tool aggregation or per-tool metrics; if richer MCP features are needed later, replace the njs policy with an MCP-aware proxy behind the same nginx front.
2. **Skill authors: developers only.** Skills are reviewed and gated by evals; the skill format stays declarative so tenant authoring could be added later. Since [ADR 0007](0007-skill-hub.md) (which also allows sandboxed scripts), skills are authored, governed and delivered through the Skill Hub rather than shipped in the repository; authors remain a small trusted group.
3. **Draft scope: mixed, and drafts can be merged.** One draft may combine import-derived and conversational operations. Two drafts (or proposals) can be merged into a new draft; the merge is a revision like any other, and operations that touch the same item (D43: each item changes once per proposal) are reported as conflicts for the user to resolve, never auto-resolved.
4. **Large drafts: staging runs as a background job** (jobs table and worker, D37). The screen shows progress and the draft is read-only while staging runs. Small drafts may stage inline under a size threshold set by configuration.
5. **Concurrency: the model is snapshotted when the draft starts.** The draft's base is a fixed model view (D33, as-of time plus scenario), so previews and analyses are repeatable. One agent run per draft at a time. The user can **rebase** explicitly; the rebase re-stages on the live model and lists changes that moved underneath. Approval still replays on the live model and refuses stale items (D43), so a snapshot can never apply something the live model would reject.
6. **Evaluation gate: eval set plus human review sample.** Each skill ships an evaluation set, and CI blocks release below the skill's pass bar (valid draft rate, zero invalid submissions, correct skill routing). Before general enablement, a reviewer checks a sample of real drafts during a pilot. Evals re-run on any prompt, model or schema change.
7. **Contract tooling: `zod-to-json-schema`, committed output, checked in API CI.** Schemas are generated in the TypeScript build and committed like `openapi.json`; API CI fails if stale. Agent CI generates Pydantic models from the committed files.
8. **Python tooling: uv with Python 3.12.**

## Consequences of these decisions
- Snapshot plus merge needs a defined meaning for merging drafts with different bases: the merged draft takes the newer base and re-stages (a rebase), so a merge may surface moved items.
- Background staging adds a job kind and a progress channel to the screen; quotas count staging jobs under `jobsPerDay`.
- The njs policy is new security-critical code: it needs its own tests (allow-list bypass, malformed bodies, batch requests, oversized bodies, expired or foreign-tenant tokens, unsigned skill header) and must fail closed.

## Open questions
1. **Skill-header signing:** key distribution and rotation between the agent and the gateway, and how the gateway's allow-list file is reloaded without dropping streams.
2. **Staging limits:** the inline-versus-background staging threshold, and the per-draft operation cap.
3. **Retention:** how long revision history, prompts and results are kept.
4. **Script sandbox in the harness:** outcome of the sandbox evaluation spike ([ADR 0007](0007-skill-hub.md), section 8), what `runsc` needs from the host (privileges, kernel settings) in SaaS versus on-premises, and how the harness keeps the user token out of the sandbox child.
