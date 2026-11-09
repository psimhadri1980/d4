# Roadmap and dependency-risk meta model: statement of need

Status: requirements, revised after an independent review (web research on roadmapping, enterprise architecture, data product and debt practice) and the author's answers to each review point. Design follows.

## 1. Purpose

A meta model that lets us **define a roadmap and see what it depends on**. When the roadmap is at risk, it must let us trace the risk to its cause and to everything downstream of it. The roadmap must also reflect the firm's technology direction and the debt we carry.

## 2. Core questions

1. What is on the roadmap, at what level, and when?
2. What does each roadmap item depend on, in architecture, data and external constraints?
3. If a component, data asset or external constraint slips, which initiatives are affected, and by how much against the baseline?
4. Which dependencies are critical: shared by many initiatives, or on the path to a committed milestone?
5. What exists today and what is planned, as of any date? Where is the gap?
6. What does the firm direction say we should build on, and where do we diverge (debt)?
7. If X slips by N weeks, or a plan changes, what is affected?

## 3. Structure: one element registry, five concerns

**Initiatives and objectives (the "what and why")**
- Objectives or outcomes that initiatives contribute to.
- Big rocks, sub-initiatives and epics, nested so the roadmap reads at portfolio, initiative or epic level. The roadmap is one **Gantt-style view**: lanes of line items on a time scale. A **milestone** is a line item with a start and an end; the **epics** inside it show how it is reached. Neither goes down to task detail.
- A **use case** is a scoped change close to an initiative, triggered by pain points: it automates, digitises or augments a process or capability. An initiative can drive many use cases. A use case has **no timeline of its own**: it is linked explicitly to an initiative, a milestone or an epic, and takes its timing from them; milestones can be planned around it. It declares one or more categories (section 6).
- Debt remediation and alignment work are initiatives too.

**Business: capabilities, processes and roles (what the business does, and who does it)**
- **Capability:** what the firm can do. Stable, separate from a process, and an **optional anchor** of a view.
- **Process:** a business process, sub-process or step. A process realises a capability. Sub-processes are **shared**: one sub-process can be part of several processes. Levels are configurable and go down to step; the model does not hold flow or sequence (no BPMN detail).
- **Role:** a kind of user a process needs. A role is separate from the organisation unit that employs the people, and **does not carry a line of defence** (one can still be recorded as an undefined attribute). A role performs, approves, reviews or oversees a process or step.
- **Support:** a process uses the applications that support it, with dated links, so a planned change is a link that starts in the future.
- **Data interaction:** a step **reads** data (through a data product's output port, a data set under a data product, or a current data set) or **creates or updates** it. A step can touch **many** data products and data sets, one link each. From the data product side this shows every process that touches a product and how, which is part of the product's lifecycle.
- **Evolution:** a process has a lifecycle and dates like any element. As-is and to-be are the same process at two dates. A use case changes a process or capability with a kind of change (for example automate, digitise, add AI, replace with an agent; configurable values). The process change is delivered by a milestone or epic, which gives it a go-live.

**Elements (what we build and what exists)**
- **One registry.** Current and target are not separate sets. Each element has one identity, one accountable owner and a **lifecycle with dates**: planned, building, live, phasing out, retired. "Current landscape" and "target state" are views of the registry as of a date. The gap between them is **derived, not stored**.
- Two kinds of element, linked:
  - **Applications:** applications, platforms, sub-components, modules, AI use cases, AI apps.
  - **Data:** data platforms, data sets and data products in data mesh terms. A data product has an owner, a consumer-facing purpose, defined output ports or contracts and explicit dependencies. Three levels: source-aligned, aggregate, consumer-aligned. Products compose. Current data is not forced into the data-product shape.
- Depth: platforms and applications, plus major data platforms and data sets. No integration, infrastructure or table-level detail.
- **Transition states:** a long-term target plus optional named intermediate states tied to milestones, each with an owner. The target can change over time.
- "Available" means **live and usable by its consumers today**. Replaces, wraps and retires are links between distinct elements, not between two records of one element.

**Firm-wide direction (what we build on)**
Set by central teams, consumed by everyone else. Five artefact types:
- recommended technology list
- reference architectures
- shared platforms
- principles and policies
- blueprints (section 6)

Technology direction keeps **three separate axes**: the firm's **stance** (adopt, tolerate, and so on), **internal lifecycle dates** (phase out, retire), and **vendor support dates**. Risk signals use the earliest binding date.

**External constraints**
- One type covering vendor, regulatory, funding and capacity constraints, each with an owner and a date. They take part in timing risk like any other dependency.

## 4. Ownership

- **Organisation:** Group → Division → Towers → Streams → Crews. One parent per node, with effective dates so reorganisations are represented.
- **Domain:** a business area that owns data products and architecture elements. Domain and organisation are separate concepts that sometimes coincide; an element can have both an owning domain and an owning Crew.
- **Roles:** a mandatory **accountable owner** on every element, data product and debt item; other roles (technical owner, data owner, steward) are optional.
- **Rollups:** rollups for impact count **distinct items**; rollups for debt **sum allocated quantities**. Each rollup states which it is.

## 5. Dependencies

Dependencies are first-class facts, split into families, each with its own traversal direction and a rule for whether timing risk propagates along it:
- **Structural:** consumes, produces, uses.
- **Change:** delivers, replaces, retires, wraps (initiative or element changing another).
- **Conformance:** built on a firm-direction artefact.
- **Data lineage:** recorded only between data sets and data products, kept apart from delivery dependency.
- **External:** element or initiative → external constraint.

Further rules:
- Strength: hard blocker or soft.
- A dependency on a data product targets an **output port or contract version**, not the product as a whole.
- An element's **ready-by** is the end of the milestone that primarily delivers it.
- Dependencies are recorded between line items (initiatives, milestones, epics) **at the finest level**, with a type (finish-start, start-start, finish-finish, start-finish) and a lag in days. A coarser dependency is rolled up from those beneath it.
- Only **committed milestones** are the dates that matter when judging lateness.
- Dates carry a simple **confidence** (for example high, medium, low).
- **Derived dependencies:** an element **uses** another, a process **reads** data (it depends on the data being ready), or a process **writes** data (the data depends on the process being live). The dependency in time is **derived** from these facts between the line items that deliver the two ends, finish-finish unless the link says otherwise, so nobody records it twice. A dependency someone records between line items inside the two ends replaces the derived one.
- Float is computed per dependency from the bars: the dependent's start or end against the prerequisite's start or end, less the lag.
- Granularity varies freely; rollups must not lose or double-count.

## 6. Blueprints and use-case categories

- A blueprint is an architecture or set of patterns that a specific category of use cases should adhere to.
- It is a **versioned set of typed rules**: must use, must not use, must follow a reference architecture, principle. It can draw on the other four firm-direction artefacts.
- A use case declares **one or more categories** and must satisfy the blueprints of all of them. Conformance is assessed **per rule**, so partial satisfaction is visible. A **conflict** is two rules that contradict, and is computed.
- The category list is a governed list owned by the central teams. Blueprint changes roll out with grace periods.
- Elements inherit blueprints through the use cases they deliver, and the model shows which use case each came from.

## 7. Debt and exceptions

- **Derived findings:** non-conformance to firm direction is computed automatically and recomputed whenever direction or elements change. When direction changes (for example a technology gets a retirement date), findings appear in dependent elements without anyone touching them.
- **Recorded debt items:** a person takes a finding on, or records debt found by judgement. Each has an accountable owner, an affected element, what it falls short of, and one lifecycle: identified, then planned (linked to an initiative), accepted (as an exception) or unplanned, then resolved.
- **Kinds:** technology, architecture, system and data debt. Data debt means data that is undocumented, unowned or unfit to become a product, distinct from data quality. Each kind has a definition.
- **Measure:** severity, deadline, and **exposure** (computed from the number of dependents and affected initiatives).
- **Debt must be in the roadmap:** every recorded item is planned, accepted or flagged as unplanned. Roadmaps include the debt of what they build on or touch.
- **Exceptions:** a formally accepted deviation from firm direction, with owner and expiry. "Accepted" debt is an exception.

## 7a. The roadmap view

- **One view**, not several shapes: lanes, line items as bars, epics inside their milestone, dependency arrows between line items at either level, with float derived from the bars. A collapsed milestone still draws the arrows of the epics inside it.
- **Lanes are chosen when the view is opened:** by platform, by use case, or by another grouping such as domain or organisation unit. The model stores no fixed lane.
- **The window is chosen too:** the user picks the period to focus on, and only line items overlapping it are drawn.
- Overlays on the same view: baseline bars for slip, the as-of date, scenarios, confidence and committed marks, and debt and external constraints as flagged items.

## 8. Time, baselines and what-if

- **Baselines:** dated snapshots of the roadmap. Slip is current forecast minus baseline.
- **Bitemporal facts:** dates and links keep when a fact is true and when it was recorded, so "what did we believe last quarter" is answerable.
- **As-of view:** any query can be asked as of a date.
- **What-if:** a transient analysis of any date or element shift.
- **Scenarios:** named, saved scenarios (cancel, defer, alternative plans) that branch the plan and compare against the baseline. Both are in scope now.

## 9. Freshness and definitions

- Every element and link carries a **last verified** date and a confirming owner. Stale facts raise a risk signal.
- Thresholds ("heavily shared", "major data set", "no clear owner") are **configurable parameters**.
- Every computed signal can show the path that explains it.

## 10. Risk is computed from structure

Stored notes are only for human judgement. Signals:
- a dependency ready after the committed milestone that needs it (negative float)
- a target element or data product with no initiative building it
- a heavily shared dependency
- an element or data product with no accountable owner
- a current element the plan relies on but nobody owns or plans to evolve
- an element built on something firm direction is retiring, with no initiative to move it
- debt whose deadline is earlier than the roadmap item that depends on it
- new capability planned on an element with unaddressed debt
- a target element that diverges from firm direction with no accepted exception
- a use case in several categories whose blueprints conflict, or that satisfies only some rules
- a process that goes live before the data product it reads is ready (negative float), or a data product whose content waits for a process that is not yet live
- a live process whose supporting application is being retired with no replacement
- a process or step with no role, or a role with no process
- a shared sub-process whose change reaches many processes
- an external constraint date earlier than the milestone it gates
- facts not verified within the freshness limit

## 11. Users

Leadership and portfolio owners (high-level roadmap), initiative and programme leads (epics and use cases), architects and data owners (landscape accuracy), and central teams (publishing direction and seeing who is affected).

## 12. Scope control

Non-goals: not a project-management tool, not a full enterprise architecture repository, not a detailed data catalogue.

- Fixed types: element lifecycle, dependency families, debt item, exception, baseline, milestone, external constraint.
- Configurable: element sub-types, data product levels, debt kinds, blueprint rule types, organisation levels, thresholds.
- The **minimum facts** needed for the section 10 signals are: element lifecycle dates and owner, milestone dates with confidence and committed flag, dependencies with family and strength, firm-direction dates, debt items, and last-verified dates. Anything beyond that must justify itself against a signal or a core question.

## 13. Next steps

1. Design the meta model from this statement.
2. Record the decisions in the decision log.
