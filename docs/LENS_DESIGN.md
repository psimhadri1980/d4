# Graph Studio lenses: the common design (D85)

Status: agreed direction, not built. Research behind it:
[`reports/Graph lens interaction patterns.md`](../reports/Graph%20lens%20interaction%20patterns.md)
(sources and citations), notes in `research_notes/Graph lens interaction patterns/`.

## 1. The problem
Today a lens is a filter: a contour type, attribute filters and linked/not-linked facets pick the
roots, and the Studio draws them with their neighbourhood at depth N. Every node gets the same
weight, nothing is folded away, and there is no direction, so a hierarchy or a flow cannot be
shown and a user cannot drill down. Most real questions have a shape (a tree, a flow, an impact
cone, a matrix) and care about a few nodes and how they connect.

## 2. The principle
**A lens is a viewpoint: a small, declarative spec over the metamodel. A lens opened on an anchor
is a view.** (ISO 42010's split; Ardoq viewpoints work the same way.) Every visual pattern is a
renderer of that one spec, and every authoring surface (search phrase, template, wizard, Cypher)
is an editor that produces it. The server compiles the spec into bounded, checked traversals, so
users get rich traversals without sending query text (CLAUDE.md: never raw Cypher).

Three rules from the research shape everything below:
1. **Search first, show context, expand on demand** (van Ham & Perer), not "overview first":
   start from an anchor, fill a budget by degree of interest, fold the rest.
2. **Nothing disappears silently.** Every cut shows as a group with a count or a truncation mark.
3. **The layout stays put.** Expanding pins existing nodes and animates only the new ones;
   re-layout is an explicit action (mental-map studies).

## 3. The lens spec
```yaml
lens:
  name, description, visibility            # as today (D82)
  anchor:                                  # where the question starts; one of
    pick: true                             #   the user picks or searches nodes at run time
    set: { type, attributes[], facets[] }  #   today's contour and facets
    query: { id, version?, params }        #   a reviewed catalog query (D84)
  steps:                                   # the traversal, in order; may be empty (ego)
    - from: <type | any>
      via: <relationship name | kind:<kind> | any>
      to: <type | any>
      direction: out | in | both
      depth: 1 | "1..3" | "1..*"           # the server caps "*"
      where: <attribute filters on the target>
      require: exists | absent             # optional: a gap/coverage check, not a hop
      stage: <label>                       # optional: column or swimlane name
  shape: ego | flow | tree | nested | matrix | paths | table | timeline
  shapeOptions:                            # per shape, e.g. matrix rows/cols, flow axis
  disclosure:
    budget: 150                            # visible items; hard stop 350 nodes / 1,000 edges
    initialDepth: 1                        # levels drawn before the user opens more
    perNodeCap: 25                         # neighbours one expand adds; the rest fold
    groupBy: [type, <attribute>]           # how folded siblings split into groups
    importance: <rule>                     # overrides the metamodel's default (see section 5)
  encodings: { colour, size, badge, label } # bound to attributes or relationship presence
  actions: [ { name, when: <selection type>, open: <lens id> } ]
  time: { asOf | range }                   # optional, needs history
  layer: business | technical              # optional granularity
```
Today's lens maps onto this without loss: the contour and its filters and facets become
`anchor.set`, the "not linked" facet becomes `require: absent`, depth N becomes `steps: [{via:
any, direction: both, depth: N}]`, and layout becomes `shape`. Stored lenses are migrated by that
rule when they are read; `studio_lenses` keeps its jsonb body.

## 4. The patterns
Each pattern is a preset of the spec: a starting set of steps, a shape and disclosure settings.
Ranked by how often enterprise questions need it.

| # | Pattern | Question | Spec preset | Shape |
|---|---|---|---|---|
| 1 | **Ego** | "Show me X and what is around it" | no steps; expand by kind on demand | ego (radial, grouped by relationship) |
| 2 | **Lineage / impact** | "Where does this come from?" / "What breaks if it goes?" | `via: kind:flow` or `kind:dependency`, `in` or `out`, `1..*` | flow, left (upstream) to right (downstream), with an impact table |
| 3 | **Viewpoint traversal** | "Capability → Application → Interface → Data → Owner" | a chain of typed steps, each with a `stage` | flow in columns, one per stage |
| 4 | **Landscape** | "What is in this domain, and what state is it in?" | one grouping step (`kind:containment`) | nested boxes, coloured by an attribute (heatmap) |
| 5 | **Matrix** | "Which X relate to which Y?" | anchors × one step's targets | matrix, cells coloured |
| 6 | **Connection** | "How are A and B connected?" | `mode: paths` between anchors, typed steps optional | ranked path list with a small graph |
| 7 | **Hierarchy** | "What is X made of?" | `kind:containment`, `out`, `1..*` | indented tree with attribute columns |
| 8 | **Rollup** | "What kinds of things are here?" | anchor set grouped by type or attribute | groups with counts; drill to members |
| 9 | **Layers** | "From system down to column" | the same steps at business or technical layer | any; a layer toggle |
| 10 | **Time slice** | "What retires in 2027, and what does it leave uncovered?" | any, with `time` | the same shape, items outside the range faded |
| 11 | **Diff** | "What changed between two versions?" | any, over two snapshots | the same layout, marked added, removed and changed |

Gap/coverage ("capabilities with no application") is not a pattern of its own: it is
`require: absent` on a step, usable in any of the above.

Worked lenses on the credit graph, the first set to ship:
- **Client exposure (ego):** a client, its group, facilities, collateral and limits; drawdowns fold
  into "▸ 37 drawdowns".
- **Limit breach impact (impact):** a limit, downstream to facilities, drawdowns and margin calls,
  with the impact table exported.
- **Group structure (hierarchy):** client group → clients → accounts, tree with exposure columns.
- **Collateral cover (matrix):** facilities × collateral agreements, cells coloured by coverage.
- **How are these two clients linked? (connection):** shared collateral, guarantees and accounts.
- **Report figure lineage (lineage, BCBS 239):** an RWA or PD figure upstream to the system where
  the data is captured, each step showing its owner, any manual step and its data quality control.

## 5. What the metamodel declares
Patterns name relationship kinds, not relationship names, so they run on any metamodel. Added to
`starter.yaml` and the packs, with a version bump:
- On a relationship:
  - `kind`: one of `containment`, `dependency`, `flow`, `ownership`, `association` or
    `classification`. A relationship has one kind; the default is `association`.
  - `forward`: whether the stored direction reads as "down" or "downstream".
- On a type:
  - `label`: the attribute that names a node.
  - `importance`: an attribute and its ordering, e.g. `criticality: [HIGH, MEDIUM, LOW]`.
  - `groupBy`: default attributes for grouping.
  - `stage`: its order in flows, e.g. Source < Store < Product < Report.
- On an attribute: `time: validFrom | validTo`, when the type has validity dates.

A metamodel that declares none of this still works: every relationship is an association, so
Ego, Viewpoint, Matrix, Connection and Rollup work, and the editor greys out Hierarchy, Lineage
and Landscape with the reason. The existing type `role` (contour/facet/both) stays as the hint
for what the editor offers as an anchor.

**Degree of interest** decides what fills the budget, and in which order expand adds nodes:

    interest = importance (lens rule, else metamodel, else 0)
             + structure (fan-in; on a path between anchors)
             + user (search match, pinned)
             − distance (hops from the nearest anchor)

Anchors and pinned nodes are always shown.

## 6. Disclosure
One engine on the server for every shape:
1. Run the steps level by level from the anchors, to `initialDepth`.
2. Score each node by interest. Fill the budget, highest first.
3. Fold what does not fit into **group stubs** per parent, split by `groupBy`: "▸ 14 DataStores ·
   3 RESTRICTED". A stub carries its count, a breakdown and a cursor.
4. Return a **projection**: visible nodes, stubs and the edges between them, plus truncation
   marks where the server's caps cut a step.

Opening a stub or a deeper level is another call with the cursor, so a large graph never comes
back whole. The current depth-N neighbourhood fetch becomes this call with a single step.

## 7. The interaction vocabulary
The same verbs in every shape, so users learn one grammar and every new relationship kind appears
in the menus without new code:

| Verb | What it does |
|---|---|
| Search | One box: lens phrases, names, attribute values |
| Expand | Adds neighbours by kind and direction. The count shows before the click; the result is capped |
| Collapse / group | Folds siblings into a stub |
| Open / drill | Opens a stub in place, or drills in: the node becomes the anchor and is added to the breadcrumb |
| Focus path | Dims everything off the path to the selected node ("why is this here?") |
| Filter | Facet chips, plus histograms and range sliders on attributes |
| Dismiss / dismiss others | Prunes the scene |
| Pin | Keeps a node visible and in place, and raises its interest |
| Undo / redo, breadcrumb | Steps through history |
| Switch shape | The same result as graph, table, tree or matrix |
| Open as | A selection-gated action: runs another lens with the selection as its anchor |
| Export | Impact table as CSV; image |

Hovering a node shows its card (owner, state, quality). Nodes the user may not read appear masked
and cannot be expanded past.

## 8. Authoring: five rungs, one spec
1. **Save the view:** the current anchor, filters, grouping and styling become a private lens.
2. **Templates:** a lens with typed anchor slots, run from a right-click on a node or from a form.
3. **Search phrases:** named phrases bound to a lens and its slots, such as "impact of
   $application" or "lineage of $report". Typing in the search box offers them.
4. **Wizard:** pick a pattern, then the anchor, then the steps. The steps are offered from the
   kinds and relationships valid at that type, with counts from the data profile. Then the shape,
   grouping and colour, all with a live preview.
5. **Viewpoints and text:** admins publish a default lens per type. Power users write a compact
   text form modelled on dbt selectors (`2+Application+3 via dependency`) that compiles to the
   same spec.

6. **Cypher (Query Authors):** the expert rung. The author writes Cypher in the lens editor, and it
   follows the catalog path of D7 and D84:
   1. **Write:** the Cypher, the parameters it declares, and the role it plays in the lens, either
      **Anchors** or **Projection** (table below). The editor offers a starter for each role, and
      `$workspace` is supplied.
   2. **Check as you type:** the `@d4/cypher` checks run on the draft, so a write clause, a
      missing `$workspace` filter or a missing `node`/`id` column shows straight away.
   3. **Test run:** uses the catalog's existing test run for drafts. The author can run the draft,
      and a steward can run a version in review. Runs are checked first and limited to 100 rows
      and 10 s. The result is drawn in the lens preview through the disclosure engine, so the
      author sees the real first screen. The steward reviews with the same preview.
   4. **Submit for review:** a steward reviews the Cypher, and the role and columns it declares,
      in the catalog. Until a version is published, the lens works only for its author, through
      the test run and under its limits, with a "draft query" banner. Everyone else sees it as
      waiting for review.
   5. **Publish:** the lens points at a published version. A new edit starts a new draft version
      and leaves the published one running.

   Anyone else uses a Cypher lens as they would any lens. They can fill in its parameters, use its
   quick filters and use every verb, but they never see or change the Cypher.

**Cypher lenses** (D84) feed the same spec. The usual form is a reviewed query that supplies the
anchors. A query may also return a projection, which the `@d4/cypher` check verifies when it is
submitted:

| Column | Meaning |
|---|---|
| `node` | an element (required) |
| `parent` or `from` | edge source, giving a tree or a DAG |
| `rel` | relationship name or kind |
| `level`, `stage` | layering |
| `weight` | interest |
| `anchor` | true for starting nodes |

The disclosure engine then folds and budgets its result like any other lens. A query that returns
only `id` or `node` is today's anchors-only form.

## 9. Build order
- **Slice 1 (done, D86 and D87):** relationship `kind` and `forward` in the metamodel; the spec in `@d4/core`, with
  today's lenses migrated; the server disclosure engine with group stubs and cursors; Ego and
  Hierarchy shapes; Expand, Open, Drill with breadcrumb and Pin. This answers the original
  complaint: few nodes first, then drill down.
- **Slice 2 (done, D88):** Lineage/impact flow with the impact table; viewpoint chains with stages;
  the editor's Traversal section (pattern, steps, live first-screen preview). A step's `to` is
  `types`; `where`, `require` and depth ranges per step are not built yet.
- **Slice 3:** Matrix, Landscape, Connection; search phrases and templates; selection-gated actions.
  Connection is done (D89): shortest paths between the selection and a pinned node.
- **Slice 4:** Cypher projections; layers; the text form.
- **Later:** time slice and diff, which need history in the graph.

## 10. Open points
1. Budget, per-node cap and depth ceilings are starting values. Log truncations, expands and
   shape switches per lens and tune them.
2. Relationships with two natural kinds (ownership that is also containment): one kind plus an
   explicit step for now; revisit if packs need both.
3. Whether a lens may override importance freely, or only choose between rules the metamodel
   declares.
4. Diff and time slice need versioned or dated graph data; out of scope until the graph keeps
   history.
