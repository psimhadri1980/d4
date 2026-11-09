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
| `Epic` | The detail inside a milestone: `start`, `end`, status. Part of a Milestone. |
| `Milestone` | A line item with `start` and `end` (required), `confidence` (high, medium, low), `committed` (bool). Part of an Initiative; contains Epics. |
| `UseCase` | A scoped change, with `painPoints`. No dates of its own; realised by an Initiative, Milestone or Epic. One or more UseCaseCategory. Acts on a Process or Capability (`changes`). |
| `UseCaseCategory` | Governed list owned by central teams. Links to Blueprints. |
| `TransitionState` | Named intermediate state tied to a Milestone. Owner. The long-term target is a TransitionState flagged `target`. |

### 3.1a Business (what the business does)

| Type | Key attributes |
|---|---|
| `Capability` | An `Element` (lifecycle and dates). Stable; an optional anchor of a view. Nests through `partOf`. |
| `Process` | An `Element`. `level` (L1, L2, L3, step; configurable). Shared: several parents through `partOf`. |
| `Role` | No line of defence. Separate from OrgUnit. |

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
| Structure | `reads` | Process → OutputPort or DataSet | A step can read many; one link each. A data set under a data product takes its timing from the product. The process depends on the data. `dependencyType`, `lagDays`, `strength`. |
| Structure | `writes` | Process → DataProduct or DataSet | One or many per step. `operation` (create, update). The data product depends on the process being live. |
| Structure | `participatesIn` | Role → Process | `participation` (performs, approves, reviews, oversees). |
| Structure | `realisesCapability` | Process → Capability | |
| Structure | `consumes` | element or DataProduct → OutputPort | Dependency targets the port and optional `contractVersion`. |
| Structure | `produces` | element → DataProduct or DataSet | |
| Change | `delivers` | Initiative, Epic or Milestone → element, DataProduct or OutputPort | Carries `responsibility`: `primary` (sets the element's ready-by and owns the delivery; at most one per element) or `contributing` (another platform or initiative helps). |
| Change | `replaces`, `wraps`, `retires` | element → element | Between distinct elements only. |
| Change | `contributesTo` | Initiative → Objective | |
| Change | `realises` | Initiative, Milestone or Epic → UseCase | Gives the use case its timing. An initiative can realise many use cases. |
| Change | `changes` | UseCase → Process or Capability | `changeKind` (automate, digitise, augment with AI, replace with an agent; configurable). |
| Change | `dependsOn` | Initiative, Milestone or Epic → Initiative, Milestone or Epic | Planning dependency, recorded at the finest level. Carries `dependencyType` (finish-start by default, start-start, finish-finish, start-finish), `lagDays` and `strength`. |
| Conformance | `builtOn` | element → Technology, ReferenceArchitecture or SharedPlatform | |
| Conformance | `follows` | UseCase → Blueprint (derived through its categories) | Derived, not edited. |
| Conformance | `addresses` | Initiative → DebtItem | |
| Lineage | `derivedFrom` | DataProduct or DataSet → DataSet or DataProduct | Data flow only. No timing meaning. |
| External | `gatedBy` | Milestone or element → ExternalConstraint | |
| Ownership | `ownedBy`, `inDomain` | any → OrgUnit, Domain | Dated. |

## 5. Timing model

- **ready-by** of an element or OutputPort = end of the Milestone whose `delivers` is `primary` (or the date `live` starts, if already live). Contributing deliveries do not set it.
- **float** of a `dependsOn` edge, from the bars: the dependent's start (finish-start, start-start) or end (finish-finish, start-finish) minus the prerequisite's end (finish-start, finish-finish) or start (start-start, start-finish), less `lagDays`. Negative float is a late dependency, and counts as a risk when the dependent line item belongs to a committed milestone.
- **Rolling up.** A dependency between epics of different milestones shows at milestone level with the worst float beneath it, so a collapsed milestone still draws its arrows. A dependency recorded only at milestone level gives a coarser, often wrong float.
- **Derived dependencies.** `uses`, `reads` and `writes` are structural facts; the dependency in time is derived, not stored. For a link, the dependent end and the prerequisite end are each taken to the line item that primarily delivers it (or the nearest part-of ancestor's), and float is computed with the link's `dependencyType` (finish-finish by default) and `lagDays`. For `reads` the process depends on the data; for `writes` it is reversed. A recorded `dependsOn` between line items inside the two ends replaces the derived one.
- **Roadmap view.** Lanes (platform, use case, domain, organisation unit) and the focus window are chosen when the view is opened; none is stored.
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
