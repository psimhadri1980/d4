# ADR 0005: AI-assisted data ingestion

**Status:** Proposed, 2026-10-21

## Context
Spreadsheet import (D36) and connectors (D48) are safe and idempotent, but the user does the hard part by hand:
- `suggestMapping` (`packages/codecs/src/tabular.ts`) looks at header names only, so cryptic headers, abbreviated type values and `Type: Name` references are missed.
- Dry-run issues are reported by row and column, but the fix is left to the user.
- Connector mappings are hand-written JSON against the `Mapping` schema (`packages/connectors/src/mapping.ts`).

A language model can close these gaps, but the model is untrusted: it must not weaken tenant isolation, the metamodel as source of truth, the "no raw Cypher" rule or the all-or-nothing import.

## Decision
**AI proposes; the existing pipeline disposes.** The model only produces artefacts a person could have typed: a `TableMapping`, a connector `Mapping`, or value corrections. Each goes through zod, the `MetamodelRegistry`, the dry run, `planImport` and an explicit user action to import. The model never writes to the graph, never emits Cypher and never sees credentials.

1. **Scope, in order:**
   1. Mapping suggestions for spreadsheet tables, with a confidence and a reason per column.
   2. Explanation and proposed fixes for dry-run issues (value maps, mapping changes, corrected cells).
   3. Value normalisation: free text to enum values and to existing elements. Deterministic similarity ranks candidates first; the model only breaks ties.
   4. A connector mapping assistant that drafts a `Mapping` from a sample response, validated by the schema and previewed with the sync dry run.
   5. Later: extraction from unstructured sources into a change proposal (D43), so review stays human.
2. **Package and provider.** A new `packages/ai` holds prompt builders, response zod schemas and an `AiProvider` interface. The Claude implementation sits behind it, so a tenant could point at another endpoint. A recorded-response fake provider serves unit and browser tests.
3. **Where it runs.** In the API, behind new endpoints under `/v1/workspaces/:ws/import/…`, with `WorkspaceAccess.resolve(write)`. The key is server-side only. Long inputs may use the worker and the jobs table (D37).
4. **Prompt context from the registry.** Types, attributes, enums and allowed relationships come from `MetamodelRegistry` at call time. No type list is hard-coded.
5. **Output handling.** Responses are parsed with zod and rejected, not repaired, when they fail the schema or name a type, attribute or enum value the registry lacks. Rejection falls back to the existing `suggestMapping`.
6. **Data governance.** Disabled by default, enabled per tenant by an admin with a disclosure of what leaves the deployment. Default payload: headers, the metamodel summary and at most 20 sampled rows per table, with an option to send headers only. Cell values are never written to logs.
7. **Accountability.** Each call records tenant, user, kind, model, token counts and outcome. A quota metric (`aiCallsPerDay`) is added in the style of D44. Mappings that began as a suggestion carry an "AI suggested" marker in the UI.
8. **UX rules.** Suggestions are editable pre-fills, never auto-applied. Changing a mapping clears the check, as today. The dry run remains the gate.

## Alternatives considered
- **Model emits ChangeSets or Cypher directly:** bypasses the planner's matching, validation and audit. Rejected.
- **Browser calls the model:** exposes the key and bypasses tenant, quota and logging. Rejected.
- **Fine-tuned or local-only model first:** heavier to operate; the provider interface keeps this open.

## Consequences
- Worst case for a bad suggestion is a rejected or visibly wrong mapping that the dry run catches; writes are unchanged.
- Cell values leave the deployment when sampling is on. Opt-in and header-only mode reduce this, but a tenant policy is needed before launch.
- Suggestion quality needs a small golden set of messy spreadsheets and a regression check, since model output is non-deterministic.
- New operating cost per call, bounded by the quota.

## Open questions
- Provider hosting: Claude API only, or a configurable endpoint for on-premises tenants?
- Is sampling of cell values acceptable by default, or opt-in per workspace?
- Redaction: pattern-based masking of obvious identifiers before sending?
