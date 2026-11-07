# Graph explorer products: interaction patterns and view authoring (researched 2026-11-07)

## Neo4j Bloom / Explore: perspectives, search phrases, scene actions, styling, expand, slicer, path search

### Takeaway
Bloom is the clearest model of "expert configures, analyst explores". An expert packages a **Perspective** (categories, styling rules, saved search phrases, scene actions). The analyst then works from one search bar that offers phrases, near-natural-language patterns, full-text matches and UI actions, plus right-click actions on the current selection.

### Cited Findings
- A Perspective saves the visualization setup: categories, formatting, saved searches, scene actions and more. It projects the right logical view of the graph to each audience. — [Neo4j blog](https://neo4j.com/?p=327759); [Bloom product brief](https://go.neo4j.com/rs/710-RRC-335/images/Neo4j_Product_Brief_Bloom.pdf)
- The search bar suggests matches from search phrases, graph patterns, full-text search and actions. TAB or click picks a suggestion, ENTER runs it. — [Bloom docs: search bar](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/)
- Graph patterns use a loose, near-natural-language syntax. Its vocabulary is built from labels, relationship types, property keys, indexed values and the Perspective's categories, and candidate matches are offered as suggestions. — [Bloom docs: search bar](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/)
- A search phrase is a saved alias for a Cypher query, which can be parameterised, stored in the Perspective. It can call algorithms or procedures, and can write if the user has write access. It is authored with "Add Search Phrase": the phrase text plus a Cypher box. — [Bloom docs](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/); [Neo4j blog](https://neo4j.com/?p=327759)
- If no suggestion fits, the search falls back to full-text search, which needs a native full-text index; without one Bloom searches all indexed string properties. — [Bloom docs](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/)
- Commands can be typed into the search bar: Expand selection, Fit to selection, Invert selection, Dismiss, Dismiss others, Clear Scene, Refresh Data, Undo/Redo. — [Bloom docs](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/)
- Scene Actions (since Bloom 2.2) run a Cypher query on the user's current selection of nodes and relationships. They appear in the right-click menu, and an availability rule shows them only when the selection contains the right types. — [Neo4j blog: Scene Actions](https://neo4j.com/?p=190025)
- Rule-based styling is data-driven, for highlighting influential nodes and relationships. Bloom 2.0 added histograms to filters and rule-based styling. — [Bloom product brief](https://go.neo4j.com/rs/710-RRC-335/images/Neo4j_Product_Brief_Bloom.pdf); [Bloom 2.0 blog](https://neo4j.com/blog/developer/integrating-graph-data-visualizations-no-code-workflows-bloom-2-0/)
- The Slicer filters on numeric or date properties ("Add range", then pick a property). It opens from the same menu as Filter. — [Neo4j blog](https://neo4j.com/?p=362261)
- Expand is a right-click action that offers one relationship type or all relationships. — [Community UI guide](https://wxzte24279.lithium.com/t5/community-suggestions/neo4j-bloom-user-interface-guide/m-p/8027)
- The 10,000-node limit applies per query result, not to the whole scene; users re-run the query or expand. A paging search phrase is one workaround. — [Neo4j Discourse](https://discourse.neo4j.com/t/bypass-10000-node-limit-in-bloom-neo4j-desktop/45670)
- Path search modes are specific path, shortest path and all paths. Bloom shows only one of several equal-length shortest paths. — [ithelp blog (third-party)](https://ithelp.ithome.com.tw/articles/10245747)
- The current docs (Bloom 2.x, around 2.34) have dedicated pages for graph pattern search, search phrases, scene actions, the slicer and perspectives. — [Bloom tutorial docs](https://www.neo4j.com/docs/bloom-user-guide/current/bloom-tutorial/)

### Inferences
- The search bar is the "one box", and it merges four sources (phrases, patterns, full-text, commands). Users don't have to know which mechanism answers them.
- Scene actions gated by selection type are a strong pattern for context menus that only show what applies.

### Gaps
- I did not verify how the newer "Neo4j Explore" (the Aura-integrated Bloom) differs from Bloom.
- I did not get the exact defaults for expand limits or the depth of undo history.

## Linkurious Enterprise: query templates, visual query builder, alerts, expand

### Takeaway
Linkurious turns Cypher into **query templates**: buttons and forms, run on a right-clicked node or from a menu, and shared across a team. Its **No-Code Query Builder** (generally available in 4.2) lets non-experts build queries and preview results live. Alerts run queries on a schedule and feed a case list.

### Cited Findings
- Query templates are pre-formatted Cypher applied to a node, run by right-clicking it and picking the template name. They can be shared with a team, and the query page shows each template's owner. — [Linkurious 2.10](https://linkurious.com/blog/linkurious-enterprise-2-10-more-expressive-visualizations-powerful-query-templates-and-improved-indexing-strategies/); [Linkurious 2.4](https://linkurious.com/blog/linkurious-2-4-query-templates-ibm-compose-janusgraph/)
- Templates turn graph queries into buttons and forms, for tasks such as a constrained shortest path or a node's dependencies. — [Top 10 query templates](https://linkurious.com/blog/top-10-query-templates-to-accelerate-your-investigations/)
- The No-Code Query Builder builds queries visually with no Cypher and previews results as the query is refined. It opens from quick actions or the query panel, and became generally available in 4.2. — [No-code query builder](https://linkurious.com/blog/no-code-query-builder/); [Linkurious 4.2](https://linkurious.com/blog/linkurious-enterprise-4-2/)
- Alerts can pre-process data: queries run and write their results back to the graph. Analysts investigate alert cases by running queries from the case, there is a unified case list (4.2), and closed alerts record who closed them and when. — [Linkurious 4.1](https://linkurious.com/blog/linkurious-enterprise-4-1/); [4.2](https://linkurious.com/blog/linkurious-enterprise-4-2/)
- Selective Expand stops too many neighbours being added at once. The user can choose the least-connected neighbours and change the maximum number retrieved. — [Linkurious manual: expand](https://doc.linkurious.com/user-manual/2.9/expand) (older manual version; see also [3.1](https://doc.linkurio.us/user-manual/3.1/expand))

### Inferences
- Templates bound to the right-click menu work like Bloom scene actions. Both products converge on "parameterised query = context-menu verb".

### Gaps
- I did not check whether the no-code builder can save its output as a template or alert rule.
- I did not research Linkurious styling or grouping (virtual nodes) in detail.

## Cambridge Intelligence KeyLines / ReGraph: combos, time bar, sequential layout, big graphs

### Takeaway
**Combos** are Cambridge Intelligence's main tool for "detail on demand". Groups can be opened, closed and nested, and the time bar filters or fades items by time. The company's guidance on large graphs: don't show everything; reveal it progressively.

### Cited Findings
- Combos group and combine nodes so charts stay readable. The "detail on demand" approach brings items in only when needed. — [Introducing combos](https://cambridge-intelligence.com/?p=7419)
- KeyLines 4.0 overhauled combos: they can be opened, closed and nested, and analysts reveal detail at their own pace. — [Cambridge Network: KeyLines 4.0](https://www.cambridgenetwork.co.uk/news/cambridge-intelligence-reveals-keylines-40)
- Combo styling: dashed borders mark combos as flexible, so data can move in and out. — [5 quirky ways to style combos](https://cambridge-intelligence.com/5-quirky-ways-to-style-combos-for-maximum-impact/)
- KeyLines can combine nodes by one or more pre-defined attributes, then open a node for detail. — [Bloor Research, 2018 (older)](https://www.bloorresearch.com/solutions/keylines/)
- ReGraph 2.0 added rectangular combos, which pair well with the sequential layout. It also added a stretch option for spacing between levels, and deprecated the "hierarchy" layout in favour of sequential. — [ReGraph v2 release notes](https://developers.cambridge-intelligence.com/downloads/release-notes/regraph/v2)
- ReGraph's Combos and Timebar story fades nodes outside the range instead of removing them. — [ReGraph v1 release notes](https://developers.cambridge-intelligence.com/downloads/release-notes/regraph/v1)
- Time bar products: [time bar page](https://cambridge-intelligence.com/timebar); [KronoGraph time bar example](https://developers.cambridge-intelligence.com/examples/kronograph/js/timebar); [time-based data visualization](https://cambridge-intelligence.com/time-based-data-visualization/)
- On scale: many huge graphs are too densely connected to view usefully in one go. Solutions should degrade gracefully and show a loading indicator during heavy work. — [Graph visualization at scale](https://cambridge-intelligence.com/visualize-large-networks/)

### Inferences
- Fading rather than removing keeps the user's mental map stable when a time filter changes, which makes it a good default for time slicing.

### Gaps
- I did not read the full big-graph article for its specific expand-limit tips.

## yFiles: folding, hierarchic and incremental layout, drill-down

### Takeaway
yFiles pairs **folding** (collapse a group into a folder node, expand it again) with **incremental layout**, which places new elements without rearranging existing ones, so the drawing stays stable during drill-down.

### Cited Findings
- `IncrementalHierarchicFoldExpandDemo` runs an incremental hierarchic layout automatically after a folder is expanded or a group collapsed. It uses orthogonal routing and recursive group layering, and its toolbar offers both a full and an incremental relayout. The source is yFiles for Java 2.14 (2017), so it is older. — [yFiles demo source](https://docs.yworks.com/yfiles/doc/demo/layout/hierarchic/IncrementalHierarchicFoldExpandDemo.java.html)
- yWorks defines an incremental layout as one that inserts new elements into an existing diagram without rearranging the existing ones. It points to the Hierarchic Grouping sample. — [Collapsing groups](https://www.yworks.com/pages/collapsing-groups-in-diagrams); [yfiles.com how-to](https://www.yfiles.com/resources/how-to/collapsing-groups-in-diagrams)
- A Collapsible Tree sample covers subtree collapse; its source is on the yWorks GitHub. — [Collapsing subtrees](https://www.yworks.com/pages/collapsing-subtrees-in-diagrams)
- Users asked for better neighbourhood, successor and predecessor views in yEd. — [yEd Q&A](https://yed.yworks.com/support/qa/6108/better-neighborhood-successors-predecessors-view)

### Gaps
- I did not verify current yFiles for HTML demo URLs.

## Other products: GraphXR, Graphistry, Gephi, Tom Sawyer, Memgraph Lab, TigerGraph, Stardog, metaphactory, Palantir

### Takeaway
Graphistry leads on histogram-driven filtering. metaphactory leads on **wizards** that generate search and facet UIs, and Stardog on automatic grouping and inferred edges. TigerGraph caps how many edges each vertex expands. Memgraph Lab uses a styling DSL (Graph Style Script).

### Cited Findings
- **Graphistry:** a histogram can chart any attribute (for example `point:degree`) and colour the graph by it. Clicking a bin, or dragging across several, filters the graph. Clustering can be toggled on and off. — [Graphistry docs: histograms](https://graphistry.infra-prod.blackbird.ai/docs/ui/histograms) (a customer-hosted copy of the official docs)
- **Memgraph Lab:** styling uses the Orb library and Graph Style Script (GSS). Rules set colour, size and labels, either for all elements or filtered ones. — [Memgraph blog via plushcap](https://www.plushcap.com/content/memgraph/blog/memgraph-how-to-style-your-graphs-in-memgraph-lab)
- **TigerGraph GraphStudio:** Expand from Vertices can limit the edges per vertex, so high-degree vertices don't pull in all their neighbours. — [TigerGraph docs 3.6](https://docs.tigergraph.com/gui/3.6/graphstudio/explore-graph/expand-from-vertices) (3.x docs, older)
- **GraphXR:** the "Shortcut" transform links a node's neighbours to each other. The API's `aggregate` rolls neighbour properties up onto a node, and Grove offers reactive `observe`/`onChange` cells. — [Kineviz visual language](https://medium.com/kineviz/a-visual-language-for-exploratory-graph-data-analytics-e953c5e61ced); [graphxr-api](https://npmjs.com/package/@kinevizjs/graphxr-api)
- **Stardog Explorer:** search and visualization with no code or queries. It groups nodes of the same class that share incoming and outgoing relationships, and shows relationships inferred by the reasoning engine. — [Stardog docs 7.9 (archived)](https://docs.stardog.com/archive/7.9.0/stardog-applications/explorer/); [Stardog blog](https://stardog.com/blog/discover-connections-in-your-data-fabric-with-stardog-explorer/)
- **metaphactory:** 4.2 added wizards for low-code search and authoring interfaces. A wizard configures semantic search for business users and generates an HTML5 component configuration to insert into a page. Facets refine results without changing the base query. 4.3 added a pathfinding interface. — [metaphacts wizards blog](https://blog.metaphacts.com/building-a-knowledge-graph-application-is-easier-than-ever-with-metaphactory-s-intuitive-wizards); [Searching with metaphactory](https://blog.metaphacts.com/searching-with-metaphactory-an-overview); [4.3 pathfinding](https://metaphacts.com/metaphactory-4-3-delivers-new-pathfinding-interface-for-investigative-knowledge-graph-exploration-targeted-problem-solving); [3.6](https://www.metaphactory.com/metaphactory-3-6)
- **Tom Sawyer Perspectives:** a low-code platform and SDK for graph applications. Release 13.0 aimed at insight without knowing Gremlin or Cypher. — [Perspectives 13.0](https://tomsawyer.com/news/perspectives-13.0.0-release)
- **Palantir Vertex:** users explore graphs their organisation has published or build new ones (+ New Graph). Right-clicking a node or group opens selection, layout and exploration options. — [Palantir Vertex docs](https://palantir.com/docs/foundry/vertex/explore-object-relationships/)

### Gaps
- I found no public documentation on Palantir Gaia.
- I did not research Gephi: its filters panel and statistics are well known but uncited here.
- The GraphXR and Tom Sawyer mechanics are thinly sourced.

## Recurring UI patterns and what makes authoring easy

### Takeaway
The patterns that recur across these products:
- Expand from the context menu, with per-node caps and a choice of which neighbours.
- Grouping or combos opened on demand.
- Histogram filters and range sliders, including over time.
- Commands on the current selection.
- Dismiss and undo.
- Saved bundles of style plus queries (perspectives).

Authoring is easiest when an expert wraps a parameterised query as a named phrase or verb, and a wizard or no-code builder previews results live.

### Cited Findings
- Expand caps: Linkurious Selective Expand ([manual](https://doc.linkurious.com/user-manual/2.9/expand)), TigerGraph edges per vertex ([docs](https://docs.tigergraph.com/gui/3.6/graphstudio/explore-graph/expand-from-vertices)), and top-N neighbours ranked by weight with the rest in a scrollable list ([Graphiy proposal](https://graphiy.readthedocs.io/en/latest/_sources/src/app/interface/Graph%20visualization.rst.txt)).
- Saved views or bundles: Bloom perspectives ([blog](https://neo4j.com/?p=327759)), shared Linkurious templates ([2.10](https://linkurious.com/blog/linkurious-enterprise-2-10-more-expressive-visualizations-powerful-query-templates-and-improved-indexing-strategies/)), metaphactory generated configurations ([wizards](https://blog.metaphacts.com/building-a-knowledge-graph-application-is-easier-than-ever-with-metaphactory-s-intuitive-wizards)).
- Histograms and filters: Bloom 2.0 ([blog](https://neo4j.com/blog/developer/integrating-graph-data-visualizations-no-code-workflows-bloom-2-0/)), Graphistry ([docs](https://graphistry.infra-prod.blackbird.ai/docs/ui/histograms)).
- Undo, dismiss and "dismiss others" are typed or shortcut actions in Bloom ([docs](https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/search-bar/)).

### Inferences
- What makes authoring easy, as these products show it:
  - Typed parameters with autocomplete from the schema (Bloom's vocabulary).
  - Context gating, so an action appears only when the selection fits (scene actions).
  - A live preview while building (Linkurious).
  - A generated config that can be edited by hand (metaphactory).
  - Sharing with ownership shown (Linkurious).
- For D4: a "lens" maps naturally to a Perspective-like bundle: styling rules, named catalog queries as phrases, and selection-gated actions. Fading items outside a time range beats removing them.

### Gaps
- None of the sources had usability studies measuring how easy authoring is.
- I did not cite any product's breadcrumb or exploration history beyond undo and redo.
