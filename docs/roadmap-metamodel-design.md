# Roadmap and dependency-risk meta model: design

Implements [roadmap-metamodel-requirements.md](roadmap-metamodel-requirements.md). Designed from those requirements only; no existing D4 metamodel was consulted. Notation here is neutral. Mapping to the metamodel file format, and its version bump, is a separate step.

## 1. Design principles

1. **One registry of things, many views.** Current landscape, target state and gap are queries over one set of nodes, as of a date.
2. **Facts are stored, risk is derived.** Findings, float, exposure and risk signals are computed. Only human judgement (recorded debt, exceptions, notes) is stored.
3. **Every fact has two times.** Business time (when it is true) and record time (when we knew it). Baselines and scenarios are built on that.
4. **Types are few and fixed; sub-types and rules are configuration.**

## 2. Common attributes

Every node carries:

| Attribute | Notes |
|---|---|
| `id`, `name`, `description` | |
| `accountableOwner` | Mandatory: reference to an OrgUnit. |
| `roleOwners` | Optional list of (role, party): technical owner, data owner, steward. |
| `domain` | Optional reference to a Domain. Independent of the owner. |
| `lastVerified`, `verifiedBy` | Freshness. |

Every **node attribute that changes over time** (lifecycle, owner, parent) and every **edge** carries `validFrom`, `validTo` (business time) and `recordedAt`, `supersededAt` (record time). Deleting a fact closes it; nothing is overwritten.

## 3. Node types

### 3.1 Why (initiatives side)

| Type | Key attributes |
|---|---|
| `Objective` | statement, period. Parent Objective optional. |
| `Initiative` | `level` (portfolio, initiative, sub-initiative; configurable), status. Nests through `partOf`. |
| `Epic` | High-level scope of an initiative. Part of an Initiative. |
| `Milestone` | `date`, `confidence` (high, medium, low), `committed` (bool). Belongs to an Initiative or Epic. |
| `UseCase` | A business need. `categories` (one or more UseCaseCategory). Delivered by Initiatives. |
| `UseCaseCategory` | Governed list owned by central teams. Links to Blueprints. |
| `TransitionState` | Named intermediate state tied to a Milestone. Owner. The long-term target is a TransitionState flagged `target`. |

### 3.2 Elements (what we build and what exists)

All carry a `lifecycle`: a sequence of phases (`planned`, `building`, `live`, `phasingOut`, `retired`) each with dates. **Current** means live at the as-of date; **target** means live or planned at a TransitionState.

| Type | Key attributes |
|---|---|
| `ApplicationElement` | `subtype` (configurable: application, platform, component, module, AI use case, AI app), parent through `partOf`. |
| `DataPlatform` | Hosts DataSets and DataProducts. |
| `DataSet` | Existing data in its current form. `major` (bool, by threshold). |
| `DataProduct` | `level` (source-aligned, aggregate, consumer-aligned), purpose, domain mandatory. Composes other products. |
| `OutputPort` | Part of a DataProduct. `contractVersion`, `sla`. The unit consumers depend on. |
| `ExternalConstraint` | `kind` (vendor, regulatory, funding, capacity), `date`, owner. |

### 3.3 Firm direction (what we build on)

| Type | Key attributes |
|---|---|
| `Technology` | `stance` (adopt, tolerate, phase out, retire; configurable), `internalLifecycle` dates, `vendorSupport` dates. Three axes kept separate. |
| `ReferenceArchitecture` | Versioned. |
| `SharedPlatform` | An `ApplicationElement` or `DataPlatform` with `central = true`, owned by a central team. It is both an element and a direction artefact. |
| `Principle` | Statement, policy reference. |
| `Blueprint` | Versioned. Applies to one or more UseCaseCategories. Made of BlueprintRules. |
| `BlueprintRule` | `ruleType` (mustUse, mustNotUse, mustFollow, principle), `target` (Technology, SharedPlatform, ReferenceArchitecture or Principle), `validFrom`, grace period. |

### 3.4 Ownership, debt and time

| Type | Key attributes |
|---|---|
| `OrgUnit` | `level` (Group, Division, Tower, Stream, Crew; configurable). One parent at a time (dated). |
| `Domain` | Business area. May be mapped to OrgUnits; the mapping is optional. |
| `DebtItem` | `kind` (technology, architecture, system, data; each defined), `severity`, `deadline`, `status` (identified, planned, accepted, unplanned, resolved), affected element, what it falls short of. Created from a Finding or by judgement. |
| `Exception` | A `DebtItem` in status `accepted`, plus `expiry`. Not a separate lifecycle. |
| `Baseline` | Name, `recordedAt` cut-off, scope (portfolio or initiative). A named record time, not a copy of data. |
| `Scenario` | Name, base (as-of or baseline), a set of overlay changes (shifted dates, cancelled or deferred initiatives, replaced links). Never written to the main registry. |

**Not stored:** `Finding`. It is computed (section 6).

## 4. Edges, by family

Direction reads source → target. Every edge has `strength` (`hard`, `soft`) unless noted.

| Family | Edge | Source → Target | Notes |
|---|---|---|---|
| Structure | `partOf` | any child → parent of its own kind | Initiative tree, element tree, org tree, product composition. |
| Structure | `uses` | element → element | Runtime dependency of one element on another. |
| Structure | `consumes` | element or DataProduct → OutputPort | Dependency targets the port and optional `contractVersion`. |
| Structure | `produces` | element → DataProduct or DataSet | |
| Change | `delivers` | Epic or Milestone → element, DataProduct or OutputPort | Sets the element's ready-by. |
| Change | `replaces`, `wraps`, `retires` | element → element | Between distinct elements only. |
| Change | `contributesTo` | Initiative → Objective | |
| Change | `realises` | Initiative → UseCase | A use case is delivered by initiatives. |
| Change | `dependsOn` | Initiative or Milestone → Initiative or Milestone | Planning dependency. |
| Conformance | `builtOn` | element → Technology, ReferenceArchitecture or SharedPlatform | |
| Conformance | `follows` | UseCase → Blueprint (derived through its categories) | Derived, not edited. |
| Conformance | `addresses` | Initiative → DebtItem | |
| Lineage | `derivedFrom` | DataProduct or DataSet → DataSet or DataProduct | Data flow only. No timing meaning. |
| External | `gatedBy` | Milestone or element → ExternalConstraint | |
| Ownership | `ownedBy`, `inDomain` | any → OrgUnit, Domain | Dated. |

## 5. Timing model

- **ready-by** of an element or OutputPort = date of the earliest Milestone that `delivers` it (or the date `live` starts, if already live).
- **needed-by** of an edge = date of the earliest **committed** Milestone of the Initiative whose work depends on it.
- **float** = needed-by minus ready-by, per structure, change and external edge. Negative float is a late dependency.
- **Propagation.** A slip travels along `uses`, `consumes`, `delivers`, `replaces`, `dependsOn` and `gatedBy` toward whatever needs the slipped thing. It does not travel along `builtOn`, `derivedFrom` or `follows`; those raise findings (section 6) but do not move dates.
- **Confidence.** A milestone's confidence lowers the weight of its signals; it never changes dates.
- **Critical** = on a path to a committed Milestone with float below a threshold, or having a number of dependents above a threshold. Both thresholds are configuration.

## 6. Computed views

| View | How it is computed |
|---|---|
| **Landscape as of T** | Nodes with a lifecycle phase live (or phasing out) at T; edges valid at T and recorded by the as-of record time. |
| **Target at a TransitionState** | Nodes planned or live at that state's milestone date. |
| **Gap** | Target minus current: new, retired, replaced, changed elements. Not stored. |
| **Slip** | Current forecast minus the same fact in a Baseline's record time. |
| **Findings** | (a) `builtOn` something whose stance, internal lifecycle or vendor date makes it `phase out` or `retire`; (b) UseCase category rules not satisfied by the elements delivering it, per rule; (c) two applicable BlueprintRules that contradict. Recomputed on every change. |
| **Exposure** | Count of distinct dependents and affected Initiatives reachable from a DebtItem or Finding. |
| **Rollups** | Impact counts distinct nodes in a subtree. Debt sums allocated quantities. Each rollup is labelled with which it is. |
| **What-if / Scenario** | The same computations run over the main registry plus a Scenario's overlay. |

## 7. Risk signals (requirements section 10)

Each signal is a query returning the nodes, the path that explains it, and its confidence.

| Signal | Basis |
|---|---|
| Late dependency | Negative float on a committed Milestone. |
| Nothing builds a target | Planned element with no `delivers` edge. |
| Heavily shared | Dependents above threshold. |
| No accountable owner | Missing mandatory owner. |
| Relied on but unowned or unevolved | Live element, no `delivers` or `addresses` edge, depended on by a planned item. |
| Built on something retiring | Finding (a) with no `addresses` Initiative. |
| Debt deadline before dependent milestone | DebtItem deadline earlier than the Milestone that reaches it. |
| Capability on indebted element | `delivers` into an element with an unaddressed DebtItem. |
| Diverges with no exception | Finding with no accepted Exception. |
| Blueprint conflict or partial satisfaction | Findings (b) and (c). |
| External constraint earlier than gate | `gatedBy` date before Milestone date. |
| Stale | `lastVerified` older than the freshness limit. |

## 8. Configuration, not types

Initiative levels, application subtypes, data product levels, org levels, debt kinds, stance values, blueprint rule types, UseCaseCategory list, thresholds (shared, critical float, major data set, freshness) and the meaning of "major". Changing these needs no structural change to the model.

## 9. Requirement coverage

| Requirement | Where |
|---|---|
| One registry, views as of a date | 2, 3.2, 6 |
| Transition states | 3.1 `TransitionState` |
| Dependency families | 4 |
| Data product port or contract dependency | 3.2 `OutputPort`, 4 `consumes` |
| External constraints | 3.2, 4 `gatedBy` |
| Debt: computed and recorded, exposure | 3.4, 6 |
| Blueprints as typed rules, conflicts computed | 3.3, 6 |
| Baselines, bitemporal, scenarios | 2, 3.4, 6 |
| Ownership: org vs domain, mandatory owner | 2, 3.4 |
| Three technology axes | 3.3 `Technology` |
| Freshness | 2, 7 |
| Scope control | 8 |

## 10. Design choices (confirmed by the author, 2026-11-09)

1. `SharedPlatform` is an element with `central = true`, not a separate node type.
2. `Exception` is a DebtItem status, not a node type.
3. `Finding` is never stored; a person adopts one by creating a DebtItem.
4. `Baseline` is a named record time, not a data copy.
5. `follows` is derived from use-case categories, never edited.

## 11. Not decided here

Storage and query technology for bitemporal data and scenario overlays, the mapping to the project's metamodel file format and its version bump, and how the roadmap is rendered.
