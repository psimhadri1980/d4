# Academic foundations of interaction patterns for exploring large graphs

Scope note: about 12 searches. Most sources reached were abstracts, bibliographic records, author pages and lecture slides, not full texts. Treat effect sizes and fine mechanics as unverified unless stated. URLs marked "(well-known URL, not fetched this session)" are canonical author or publisher pages that I did not open in this session.

## Taxonomies: which graph tasks map to which interactions?

### Takeaway
Use three layers. Lee et al. sort graph tasks into topology, attribute, browsing and overview. Yi et al. give seven interaction intents: select, explore, reconfigure, encode, abstract/elaborate, filter and connect. Shneiderman's mantra (overview first, zoom and filter, then details on demand) and Brehmer & Munzner's why/how/what typology connect the two. A lens can be specified as task + intent + view.

### Cited Findings
- Lee, Plaisant, Parr, Fekete & Henry, "Task Taxonomy for Graph Visualization", BELIV 2006 (DOI 10.1145/1168149.1168168). It sorts tasks into topology-based, attribute-based, browsing and overview groups. It extends Amar et al.'s low-level tasks with graph-specific ones such as "find adjacent nodes". Its stated goal is to help designers improve graph systems and help evaluators compare them. — [Microsoft Research](https://www.microsoft.com/en-us/research/publication/task-taxonomy-graph-visualization/); [PDF](https://scispace.com/pdf/task-taxonomy-for-graph-visualization-26ohwxohpw.pdf)
- Group-level extension: a later taxonomy covers tasks on groups and clusters, which is relevant to aggregated views. — [Saket et al., arXiv 1403.7421](https://arxiv.org/pdf/1403.7421)
- Yi, Kang, Stasko & Jacko (TVCG 2007), "Toward a deeper understanding of the role of interaction in information visualization", give seven intents: Select (mark items), Explore (look at a different subset, e.g. pan), Reconfigure (change the spatial arrangement, e.g. sort or re-layout), Encode, Abstract/Elaborate, Filter, Connect. — [Stasko lecture notes](https://faculty.cc.gatech.edu/~stasko/7450/13/Notes/interaction.pdf); [course slides](https://chenhe-infoviz.netlify.app/slides/Interaction.pdf)
- Shneiderman's mantra, "Overview first, zoom and filter, then details-on-demand", comes from "The Eyes Have It" (1996) and adds relate, history and extract. — [Shneiderman 1996 (well-known URL, not fetched this session)](https://www.cs.umd.edu/~ben/papers/Shneiderman1996eyes.pdf)
- Heer & Shneiderman, "Interactive Dynamics for Visual Analysis" (ACM Queue 2012), group 12 task types into three categories: data and view specification (visualize, filter, sort, derive); view manipulation (select, navigate, coordinate, organize); and process and provenance (record, annotate, share, guide). — [ACM Queue (well-known URL, not fetched this session)](https://queue.acm.org/detail.cfm?id=2146416)
- Brehmer & Munzner, "A Multi-Level Typology of Abstract Visualization Tasks" (InfoVis 2013), split each task into why (consume or produce; search: lookup, browse, locate, explore; query: identify, compare, summarize), how (encode, manipulate, introduce) and what (inputs and outputs). — [UBC page (well-known URL, not fetched this session)](https://www.cs.ubc.ca/labs/imager/tr/2013/MultiLevelTaskTypology/)
- The von Landesberger et al. survey (CGF 2011) arranges large-graph techniques by graph type, then by interaction, then by the algorithms that support each analysis stage. It updates Herman et al. (techniques up to 2000) and Diaz (layouts up to 2002). — [Eurographics DL](https://diglib.eg.org:443/handle/10.1111/v30i6pp1719-1749); [PDF](https://bib.dbvis.de/uploadedFiles/egstar10.pdf)

### Inferences
- How the four task groups could map to interactions:
  - Topology (adjacency, accessibility, common connection, connectivity): expand-neighbours, path-between, ego view.
  - Attribute: filter, encode, sortable tables.
  - Browsing (follow path, revisit): history and breadcrumbs.
  - Overview: aggregation and semantic zoom.
- Heer & Shneiderman's process category (record, annotate, share) argues for saved, shareable lens states.

### Gaps
- I did not open the full Lee et al. task list, so the exact low-level task names are not quoted.

## Progressive disclosure (DOI, search–show context–expand)

### Takeaway
For huge graphs, start from search instead of an overview. Show a small subgraph chosen by a degree-of-interest (DOI) score and expand it on demand. This pattern is proven at millions of nodes. Clustered drill-down in the style of ASK-GraphView is the top-down alternative.

### Cited Findings
- van Ham & Perer, "Search, Show Context, Expand on Demand" (TVCG 15(6) 2009, pp. 953–960, DOI 10.1109/TVCG.2009.108). They adapt Furnas' tree DOI function to graphs to pull out a contextual subgraph around chosen nodes, limit visual complexity and point users to interesting data. Their demonstration uses a legal-citation database of more than 3 million documents. — [researchr](https://researchr.org/publication/HamP09)
- Furnas, "Generalized fisheye views" (CHI 1986): DOI(x | focus) = a-priori importance(x) − distance(x, focus). — [bibliographic reference in Juniper record](https://www.bohrium.com/paper-details/juniper-a-tree-table-approach-to-multivariate-graph-visualization/867770708749451665-108610) (the formula comes from my background knowledge; I did not verify it against the full text)
- Abello, van Ham & Krishnan, ASK-GraphView (TVCG 12(5) 2006): clustering plus interactive navigation of graphs up to 16 million edges, with drill-down through clusters, filtering, colouring, annotation and cluster labels. The authors note that users lose context in deep cluster hierarchies. — [PDF](https://typeset.io/pdf/ask-graphview-a-large-scale-graph-visualization-system-4a2xp4v4yh.pdf)

### Inferences
- Lens DOI = a-priori interest (type importance from the metamodel, or degree/centrality) + user interest (search hits, pins) − graph distance from the focus. Show the top-k nodes and add the next ones on expand. Because the score uses only generic signals, it stays metamodel-agnostic.
- Keep a visible breadcrumb or cluster path, because ASK-GraphView found that users lose context in deep hierarchies.

### Gaps
- I did not verify the exact van Ham & Perer DOI components (the weighting of the API/UI/distance terms and how diffusion is applied) from the full text.

## Aggregation and semantic zoom

### Takeaway
Reduce clutter by replacing structure with glyphs or groups: motif glyphs, compound and cluster nodes, and edge bundling. Make the grouping reversible (expand in place).

### Cited Findings
- Dunne & Shneiderman, "Motif simplification", CHI 2013 (DOI 10.1145/2470654.2466444), replace fans, connectors and cliques with glyphs to improve readability. — [dblp](https://dblp.uni-trier.de/rec/conf/chi/DunneS13.html); [bibtex](https://bibtex.github.io/CHI-2013-DunneS.html)
- Holten, "Hierarchical Edge Bundles" (TVCG 2006): each adjacency edge is drawn as a B-spline bent along the hierarchy path between its endpoints, and a strength parameter controls how tight the bundles are. It reduces clutter with many edges. The evaluation was informal. — [TU/e](https://research.tue.nl/en/publications/hierarchical-edge-bundles-visualization-of-adjacency-relations-in/)
- ASK-GraphView's hierarchical clustering is the aggregation-based drill-down example. — [PDF](https://typeset.io/pdf/ask-graphview-a-large-scale-graph-visualization-system-4a2xp4v4yh.pdf)

### Inferences
- Lenses could fold the same-type neighbours of a node into a "fan" glyph with a count (for example, 230 Applications), which expands on click. This is metamodel-agnostic because it groups by type and relationship.

### Gaps
- I did not research Koala, GrouseFlocks, quantified semantic-zoom evidence, or the Dunne & Shneiderman study results.

## Hierarchy views

### Takeaway
Little direct evidence was gathered. Hierarchical edge bundling shows how to overlay non-tree links on any tree layout.

### Cited Findings
- Holten's bundling works with any standard tree layout (radial, balloon, treemap). — [TU/e](https://research.tue.nl/en/publications/hierarchical-edge-bundles-visualization-of-adjacency-relations-in/)
- Juniper extracts a spanning tree from a query subgraph and lays it out as an indented linear tree, with each node aligned to a table row of attributes. It handles non-tree edges separately. — [Juniper PDF](https://visdesignlab.tugraz.at/papers/2018_infovis_juniper.pdf); [JKU page](https://jku-vds-lab.at/publications/2018_infovis_juniper/)

### Inferences
- An indented tree plus an attribute table (Juniper) is a strong default for containment and decomposition lenses because it scales to long lists and supports sorting.

### Gaps
- I found no controlled comparisons of icicle, sunburst, treemap and indented trees this session.

## Matrix and hybrids

### Takeaway
Matrices beat node-link diagrams on most tasks once graphs pass about 20 nodes or become dense. Path finding is the exception, where node-link wins. NodeTrix combines the two: node-link for the sparse global structure and matrices for dense communities.

### Cited Findings
- Ghoniem, Fekete & Castagliola (InfoVis 2004; extended in the Information Visualization journal 2005) tested seven generic tasks. Above about 20 vertices, matrices did better on most tasks. Only path finding consistently favoured node-link. — [HAL](https://hal.archives-ouvertes.fr/hal-00343819); [Fekete slides](https://aviz.fr/~fekete/Visualization%20of%20Graphs.pdf)
- For directed graphs, node-link beat matrices, especially on path and cycle tasks (GD 2014 poster). — [GD14 poster](https://mozart.diei.unipg.it/gd/gd2014/data/uploads/posters/gd14-poster-1.pdf)
- NodeTrix (Henry, Fekete & McGuffin, TVCG 13(6) 2007) starts from the observation that social networks are globally sparse but locally dense. It shows dense groups as adjacency matrices inside a node-link layout, and users drag selections between the two forms. — [arXiv 0705.0599](https://arxiv.org/abs/0705.0599v2); [PDF](https://vis.pku.edu.cn/course/datavis_f23/material/nodetrix.pdf)

### Inferences
- Provide a "matrix lens" for dense bipartite questions (for example, which applications use which data entities). Keep node-link for dependency and path questions.

### Gaps
- I did not cover MatrixExplorer details or matrix reordering evidence.

## Path finding and connection views

### Takeaway
Show paths as a ranked list of linear rows with attributes, linked to a small node-link context. Do not draw the whole graph.

### Cited Findings
- Pathfinder (Partl et al., EuroVis 2016, Honorable Mention) queries paths under constraints. Results appear in two linked views: a ranked path list with node and edge attributes, and a node-link diagram for topological context. Paths are ranked by length, average degree or attribute scores. Results arrive incrementally, which lets it scale to tens of thousands of nodes and edges. — [JKU VDS](https://jku-vds-lab.at/publications/2016_eurovis_pathfinder/); [PMC full text](https://pmc.ncbi.nlm.nih.gov/articles/PMC5146994)
- Juniper (InfoVis 2018) uses a tree plus table for multivariate neighbourhoods. — [arXiv](https://arxiv.org/abs/1804.03261v2)

### Inferences
- An "impact/connection" lens can be a list of ranked paths, with rows aligned by hop and streamed as they are found.

### Gaps
- I did not cover PathLine. I gathered no user-study numbers for Pathfinder.

## Ego networks, layered DAGs and flows

### Takeaway
Not researched in depth this session. The patterns are standard (ego views at 1–2 hops, Sugiyama layering for dependencies), but I gathered no citations for them here.

### Cited Findings
- Ego-style browsing of a node's immediate neighbourhood is the core of the van Ham & Perer model. — [researchr](https://researchr.org/publication/HamP09)

### Inferences
- A one-hop ego lens with DOI-limited expansion is the natural default lens.

### Gaps
- I found no sourced evidence on Sugiyama layering, Sankey diagrams or ego-layout comparisons.

## Graph comparison and diff

### Takeaway
Every comparison design is built from juxtaposition (side by side), superposition (overlay) and explicit encoding (computed difference). For graph diffs, explicit encoding (added, removed and changed marks) is usually clearest once the relationship is complex.

### Cited Findings
- Gleicher et al. (2011) taxonomy: juxtaposition, superposition, explicit encoding. Gleicher (TVCG 2018) adds that a summarisation strategy can lead naturally to explicit encoding. — [Considerations for Visualizing Comparison](https://pages.graphics.cs.wisc.edu/VisSnacks/papers/comparison); [NSF PAR](https://par.nsf.gov/servlets/purl/10062070)
- L'Yi, Jo & Seo (TVCG 2021) review comparative layouts. Against the general consensus that superposition is better for small differences, recent studies show juxtaposition can also be effective. — [arXiv 2009.00192](https://arxiv.org/pdf/2009.00192)

### Inferences
- A diff lens: superpose two snapshots in one stable layout, colour added and removed elements explicitly, and offer side-by-side as a fallback.

### Gaps
- I did not research graph-specific diff tools.

## Mental map, animation and cognitive limits

### Takeaway
Small multiples are faster than animation. Animation is more accurate for "what changed together" tasks. Preserving the mental map helps orientation and memorability but has small measured effects on task performance. Too much stability that causes node overlap hurts.

### Cited Findings
- Archambault, Purchase & Pinaud (TVCG 2011): small multiples were significantly faster than animation overall and on all five tasks. Small multiples had more errors when identifying nodes or edges added in the same timeslice, so animation is preferable when accuracy matters more than speed. Mental-map preservation had little effect on errors or time. — [Monash](https://research.monash.edu/en/publications/animation-small-multiples-and-the-effect-of-mental-map-preservati/); [Swansea](https://cronfa.swan.ac.uk/Record/cronfa13909)
- Archambault & Purchase (PacificVis 2012): no significant time or error difference from preserving the mental map, but qualitative data suggest it makes memorability easier. Another study found the mental map significantly helps orientation, and strong preservation can hurt readability when nodes overlap. — [Glasgow eprints](https://eprints.gla.ac.uk/66915); [Springer](https://rd.springer.com/content/pdf/10.1007/978-3-642-36763-2_42.pdf)
- Archambault & Purchase (Information Sciences 2016): when layout stability is low and key nodes cannot be highlighted, animation can improve performance over small multiples. — [Glasgow eprints](https://eprints.gla.ac.uk/108352)
- The node-link to matrix readability crossover at about 20 nodes is the one size threshold found. — [HAL](https://hal.archives-ouvertes.fr/hal-00343819)

### Inferences
- On expand, keep existing nodes pinned and animate only new ones in. Highlight newly added nodes, which addresses the accuracy weakness of small multiples. Offer "re-layout" as an explicit action instead of doing it automatically.

### Gaps
- I found no sourced figure for how many nodes users can handle in node-link views beyond the matrix crossover. Huang/Eades-style cognitive-load studies were not retrieved.
