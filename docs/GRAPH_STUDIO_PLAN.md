# Graph Studio: execution plan

Source: the *Graph Studio Requirements* design canvas (Draft 4), sections A to N, decisions Q1 to Q14,
and its prototype boards (Studio, GraphCanvas, GraphView, Lens smart bar, Lens editor). Requirement ids
(FN-, GV-, TV-, DP-, CT-, FK-, DD-, GC-, LS-, LE-, ZM-, OV-, CG-) are quoted from there.

Graph Studio is a new page in the **Explore** module (`apps/web-explore`), route `/w/:ws/graph-studio` (`/studio` belongs to Query Studio),
nav item "Graph Studio". The existing Explorer stays until Graph Studio covers it; retiring it is a
separate decision.

## Where things go

| Piece | Home | Why |
|---|---|---|
| `GraphCanvas`, `GraphSearch`, `GraphInspector` | `packages/ui-kit` | CT-1/CT-5: shared with Ingestion Studio; the host owns all state |
| Layouts, elbow routing, semantic-zoom levels, tree flattening | `packages/render` (pure TS, no DOM; already a domain package modules may import) | Unit-testable without a browser; no new package or lockfile change |
| Lens model, lens evaluation, attribute-filter kinds | new `packages/lens` (pure TS) | Same evaluation for preview and search (LE-8) |
| Lens search, subgraph by roots | API `model` feature + `packages/graph` queries | FB-5: no raw Cypher; only `TenantGraphService` opens connections |
| Node-type `role` | `packages/metamodel` schema + `starter.yaml` (version bump) | LS-1, CG-2, Q12 |
| Saved lenses | Postgres (`packages/db` migration) | Session-only in the prototype (LS-7); persisted from phase 6 |
| Studio page, search bar, lens editor | `apps/web-explore/src/studio/` | Module rules: imports only web-platform, ui-kit, sdk, domain packages |

Three components, named after the prototype's panels:
- **`GraphCanvas`**: the whole result. The prototype's GraphView (graph and table) is merged into it,
  with the top bar, option bar, status bar and, later, the Overview. One contract: CT-2…CT-4 plus
  GC-5's view, layout, depth, maxDepth, crumbs and caption.
- **`GraphSearch`**: the search panel (Layer/Type/Name first, the lens smart bar from phase 5).
- **`GraphInspector`**: the details panel beside both tabs (DP-1…DP-5).

The Explorer's Cytoscape graph, which held the name `GraphCanvas`, is renamed `CytoscapeGraph`.
It is deleted once Explorer moves to the new `GraphCanvas`.

## Phases

Each phase is one or more commits that build, test and deploy on their own (CLAUDE.md: local tests,
then `podman:<app>:deploy` and its e2e specs).

### Phase 0: groundwork (API and metamodel): done
Done as planned with one change: the subgraph is expanded one hop per query (`StudioQueries` in
`packages/graph/src/studio.ts`) rather than with a variable-length path, whose cost explodes at
depth 6. Above the node limit the endpoint returns `tooLarge` and no nodes. The endpoint is
`POST /v1/workspaces/{ws}/studio/search`; the explore client is `exploreApi.studioSearch`.

- Metamodel: optional `role: contour | facet | both` (default `both`) on node types; schema, registry
  accessor, `starter.yaml` roles for the obvious contours (ApplicationComponent, Capability, Server…),
  version bump to 0.3.0. Tests in `packages/metamodel/test`.
- Graph query `subgraph(roots, depth)`: several roots, both directions, depth 1–6 (today `MAX_DEPTH`
  is 3), returns `{nodes, edges, rootIds, truncated}` with the 1,000-node cap checked server side
  (GV-6: no silent truncation).
- API `POST /v1/workspaces/{ws}/studio/search` with a lens-shaped body (contour type, facets, attribute
  filters, name text, depth). Zod schema, OpenAPI entry, typed client in `@d4/sdk`/web-platform.
- Tests: `api:test`, `api:test integration` against Neo4j.

### Phase 1: GraphCanvas, graph view (ui-kit + render): done
`canvasGeometry` in `packages/render/src/canvas-layout.ts` places cards for the five layouts and
routes connectors; `GraphCanvas` in ui-kit draws them as SVG. Connectors within one row run through
the gap below the row, so they never cross the cards between their ends. Connectors that skip rows
can still pass beside cards in between; avoiding those fully is left for phase 4, with dragging.
The table view, `view` and `expandedIds` come with phase 2; the legend with the status bar in phase 3.
- Contract per CT-2…CT-4: `nodes`, `edges`, `rootIds`, `selectedId`, `view`, `layout`, `expandedIds`,
  `fill`, `loading`, `maxNodes`; events `onSelect`, `onViewChange`, `onDrill`, `onExpandedChange`.
- SVG cards (GV-2), solid/dashed directed edges with labels (GV-3, GV-3a), five layouts (FB-3):
  hierarchical, flow, by layer, radial, force. Elbow routing with per-edge ports and label nudging.
- Selection, double-click drill (GV-4, GV-5a), too-large state (GV-6), layer colours from tokens (CT-5).
- Unit tests for every layout and the router (no overlaps, edges end on box edges: ZM-5).

### Phase 2: GraphCanvas table view and GraphInspector: done
The tree (`CanvasTree` in `packages/render/src/canvas-tree.ts`) gives a node, under each root, the
neighbours one hop further from that root, so cycles end by themselves and rows are built only
under open paths. Another root reached from a root shows there too, tagged Root. Expand all opens
at most 5,000 paths. Expand all and Collapse all sit above the tree for now; phase 3 moves them to
the option bar (GC-2). `GraphInspector` also lists attributes the metamodel does not define (D80).
- Indented tree (TV-1…TV-7): chevrons, expand/collapse all, repeats tagged, cycles stopped, virtual
  scrolling to 1,000 rows, tree keyboard pattern.
- `GraphInspector` (DP-1…DP-5): attributes from the metamodel, dashes for empty, direct relationships,
  link to the element editor.

### Phase 3: Studio page, first usable slice: done
`apps/web-explore/src/GraphStudio.tsx` at `/w/:ws/graph-studio`, nav item "Graph Studio" (icon
`affiliate`, added to the shell). The search endpoint gained `ids` for drill-downs. A node or
relationship counts as planned when it starts after the viewed date, as in the Explorer. Reset
layout and the Overview tab come with phases 4 and 7. Specs: `apps/e2e/tests/graph-studio.spec.ts`.
- `GraphCanvas` bands (GC-1…GC-5): top bar with breadcrumb, option bar with Graph/Table tabs,
  Depth 1–6, Layout icons, Reset layout, Expand/Collapse; status bar with summary chips and legend.
- `GraphSearch` with Layer, Type and Name (FN-2…FN-4, FB-1, FB-4).
- Page `/w/:ws/graph-studio`: empty state "Find a node to start" (FN-1), a plain type + name search on the
  phase 0 endpoint, every match a root (FN-5), empty/loading/error states (Q-1), tab switches keep
  state with no refetch (Q-2), tablet layout (Q-4).
- Drill down and Focus path breadcrumb with per-step restore (DD-1…DD-3).
- e2e: `apps/e2e/tests/graph-studio.spec.ts`, mapped in `apps/web-explore/component.yaml`.

**Milestone A:** a user can search, see graph and table, select, inspect and drill. Demo here.

### Phase 4: canvas interaction: done
In three commits: Show only (`applyCanvasFilter` in `packages/render/src/canvas-filter.ts`; roots
always stay), dragging (`canvasPlacement` split from `canvasGeometry`, which applies adjustments in
one stable coordinate space), and zoom (`GraphCanvasGraph`: the SVG is drawn at zoom × size inside a
scroll pane, so the scrollbars stay real; box sizes follow the level, so connectors keep touching).
A result opens fitted, but never below the Dot level (35 %); wider ones centre on the first root.
The page keeps adjustments per layout and step, and the viewport per step (closes DD-4); a new
layout or depth opens fitted again.
- Drag nodes, arrow keys, reset layout (GV-5); connector bend and label drag (GV-5b), kept per layout
  and per focus step.
- Zoom and pan (ZM-1, ZM-2, ZM-6), semantic zoom levels Dot/Label/Card/Detail with direct jump
  (ZM-3), Follow selection (ZM-4); pan/zoom stored per focus step (closes DD-4).
- "Show only" inclusion filter with counts, badge and chips (FK-1, FK-2).

### Phase 5: lens search: done
The lens model is in `@d4/core` (`packages/core/src/lens.ts`) rather than a new `packages/lens`:
core is already a domain package every module may import, so no new package or lockfile change.
`GraphSearch` is the smart bar; five predefined lenses for the starter metamodel are in
`apps/web-explore/src/lenses.ts` (a lens whose types the metamodel lacks is left out). Counts for
"Not sure yet" come from `POST /v1/workspaces/{ws}/studio/counts` (roots only, capped at 1,000).
Quick filters offered are the contour's pick-list attributes, values taken in turn from each.
Not yet: the Connections quick filter (needs a degree count in the query), docking the search
panel left (LS-8, Should), and opening large results in the Overview (LS-6, with phase 7).
- `packages/lens`: lens model (LS-2), evaluation, attribute-filter kinds from the metamodel (LE-8).
- `GraphSearch` becomes the smart bar (LS-3…LS-5, the chosen "Lens smart bar" board): lens picker, locked chips, quick filters,
  cross-lens counts only for "Not sure yet" (an API `lens-counts` call), Clear resets everything (LS-8).
- Lens defaults for depth, layout, view (LS-6); predefined lenses for the starter data.

### Phase 6: lens editor and saved lenses
- Full-screen editor (LE-1…LE-7, LE-9, LE-10): contour picker for 30–40 types, link-aware facet
  suggestions, attribute filters with ranked suggestions, About, When opened, roles table, sticky
  preview with funnel and load meter, Start from…
- Persist lenses (Postgres table per workspace, owner and visibility; API CRUD), Save as lens (LS-7).

### Phase 7: large results
- Overview tab: one bubble per type sized by count, type-to-type edges, opens above 150 nodes, Isolate
  (OV-1, OV-2); compact nodes for dense results (OV-3, ZM-7).

### Phase 8: credit graph (section N)
- The `d4-credit-graph` pack, `samples/credit-graph.yaml` and the 11 credit lenses are **not in this
  repository** (CG-5 mentions another worktree). Bring them in as `packages/metamodel/packs/credit-graph.yaml`,
  register in `METAMODEL_PACKS`, add the sample and its lenses, run the metamodel tests.

### Later (not in this plan)
- Ingestion Studio adopting GraphCanvas: needs a wider `state` input first (CT-6).
- Retiring the Cytoscape Explorer graph.

## Open points to settle before the phase that needs them
1. Phase 0: does the API cap stay at 1,000 nodes for every role, or per tenant setting?
2. Phase 1: is Cytoscape kept for the force layout's maths, or a small force simulation in
   `@d4/render`? Plan assumes our own (no DOM dependency).
3. Phase 6: lens visibility values (private, workspace, published?) and who may publish.
4. Phase 8: where the credit-graph files are today.
