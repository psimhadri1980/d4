# Enterprise architecture tools: viewpoints, views and visual idioms over a metamodel-driven graph

Research date: 2026-11-07. About 14 tool calls. Several primary sources could not be fetched: the Open Group ArchiMate HTML spec now redirects to an SSO login, help.sap.com rendered empty, and the Archi blog returned 404. Findings rely on search snippets where noted.

## ISO/IEC/IEEE 42010 viewpoints vs views; ArchiMate viewpoints; Archi

### Takeaway
42010 separates the *viewpoint*, a reusable specification of conventions framing a set of concerns, from the *view*, that viewpoint applied to one system. ArchiMate adopts this and adds a "viewpoint mechanism" that limits which concepts may appear. Archi implements a viewpoint as a per-diagram setting that restricts the allowed concepts.

### Cited Findings
- 42010:2022 sets requirements for the structure and expression of an architecture description. Its conformance covers AD, ADF, ADL, architecture viewpoint and model kind. — [iTeh catalog, ISO/IEC/IEEE 42010:2022](https://standards.iteh.ai/catalog/standards/iso/5fed7736-385f-477c-9133-5ba449a3c3b8/iso-iec-ieee-42010-2022)
- A viewpoint is a set of conventions for representing an architecture with respect to one set of concerns. A view is the result of applying a viewpoint to a particular system of interest. These come from secondary sources, not the normative text. — [Eclipse Papyrus AF viewpoint wiki](https://wiki.eclipse.org/Papyrus/Oxygen_Work_Description/NewFeature/PapyrusAFViewpointSwitch); [Wikipedia: View model](https://Www.Wikipedia.org/wiki/View_model)
- The ArchiMate 3.2 specification covers stakeholders, architecture viewpoints and views, and "the ArchiMate viewpoint mechanism". 3.2 is a minor release (Oct 2022) that refines 3.1. — [ArchiMate 3.2 Specification listing](https://www.frankwatching.com/?p=777871); [Visual Paradigm guide](https://guides.visual-paradigm.com/?p=4632)
- Archi's scripting API exposes `isAllowedConceptForViewpoint(conceptName)`. A view's viewpoint can be set or cleared (an empty string means no viewpoint), so a viewpoint is a property of each diagram that filters concepts. — [archi-scripting-plugin wiki: View](https://github.com/archimatetool/archi-scripting-plugin/wiki/View)
- The Archi User Guide has "Setting the Viewpoint" and "Viewpoint Filter" sections. — [Archi User Guide PDF](https://www.ArchiMatetool.com/downloads/archi/Archi%20User%20Guide.pdf)

### Inferences
- In 42010 and ArchiMate, a viewpoint is a *concept whitelist plus presentation conventions*, defined against metamodel concepts rather than instances. This is the same pattern as Ardoq's type triples (next section).
- My understanding, not verified this session: Archi ghosts concepts the viewpoint disallows, both in the palette and in existing views.

### Gaps
- Normative 42010 wording for "model kind" (clauses 3 and 8.2) is paywalled.
- ArchiMate 3.2 chapter text (viewpoint categories, example viewpoints) sits behind the Open Group SSO and was not fetched.

## Ardoq: viewpoints, presentations, perspectives, views, Gremlin, surveys

### Takeaway
An Ardoq viewpoint is a chain of metamodel triples (source type, reference type, target type) with a view style and grouping/formatting rules. Ardoq computes the traversal from whichever component the user starts at. This is the clearest example found of views defined purely on metamodel semantics.

### Cited Findings
- A viewpoint is "a group of components and references of a specific type that can be individually visualized" in Ardoq Discover. Admins build viewpoints in the Viewpoint Builder. They are sets of queries against the database. — [Ardoq: Understanding viewpoints](https://help.ardoq.com/en/articles/43962-understanding-viewpoints)
- Each link in a viewpoint is a triple (source component type, reference type, target component type), chained so that all types connect. Triples allow, for example, "Flows To" between processes without "Flows To" between applications. — [Ardoq: Understanding viewpoints](https://help.ardoq.com/en/articles/43962-understanding-viewpoints)
- Users may enter the chain at any point: "Ardoq will automatically calculate the route through the data based on the user's start point." A bidirectional reference needs one triple per direction. Grouping steps fetch all components of one set of triples before the next set is followed. — [Ardoq: Understanding viewpoints](https://help.ardoq.com/en/articles/43962-understanding-viewpoints)
- Grouping and formatting rules are part of each viewpoint. Core Ardoq additionally offers view styles, quick filters, perspectives (including conditional formatting) and view modifiers. — [Ardoq: Understanding viewpoints](https://help.ardoq.com/en/articles/43962-understanding-viewpoints)
- A perspective is the grouping, formatting and filter settings applied to a view. Perspectives can be saved. — [Ardoq: Saved perspectives](https://help.ardoq.com/en/articles/44111-saved-perspectives)
- Presentations stay live with the data. Slides only show components from the workspaces open when the slide was made, and what viewers see depends on their role. From end-2026, new slides can no longer be saved from Workspace Mode views. — [Ardoq: create and share a presentation](https://help.ardoq.com/en/articles/44181-how-to-create-and-share-a-presentation); [Ardoq Summer 2026 updates](https://help.ardoq.com/en/articles/810446-summer-2026-recent-updates)
- A default viewpoint can be set per component type. — [Ardoq: default viewpoint for a component type](https://help.ardoq.com/en/articles/43924-how-to-set-up-a-default-viewpoint-for-a-component-type)
- Common viewpoints:
  - Application Lifecycle Ownership: when apps retire and who owns them (Person, Application, supplier org).
  - Business Capability Realization: capability parent hierarchy, apps, experts.
  - Application Integration Owners and Experts: apps, interfaces, data, owners. Its audience is described in terms of business impact and data lineage.
  - Company/Department Objectives (OKRs).
  - Application and Infrastructure Cost Roll-ups, starting from Business Capability.
  — [Ardoq: Five commonly used viewpoints](https://help.ardoq.com/en/articles/176967-five-commonly-used-viewpoints-in-ardoq-and-how-to-create-them)
- Dependency Map shows dependencies across or within workspaces. It has grouping rules (default "Group by Parent All"), multiple degrees of traversal, and conditional formatting such as colouring apps by total direct cost. — [Ardoq: Dependency map](https://help.ardoq.com/en/articles/44007-dependency-map)
- Treemap is a zoomable view of a workspace's components, good for aggregating field values. Swimlanes is a standard view. — [Ardoq: How to visualize your data](https://help.ardoq.com/en/articles/44161-how-to-visualize-your-data); [Ardoq views portfolio status](https://help.ardoq.com/en/articles/63592-ardoq-views-portfolio-status)
- Graph Search uses Gremlin. Example queries include application cost totals and capabilities with no linked applications. — [Ardoq: Gremlin graph search examples](https://help.ardoq.com/en/articles/44074-gremlin-graph-search-examples)
- Ardoq has in-view data modelling (editing the model from a view). — [Ardoq: in-view data modeling](https://help.ardoq.com/en/articles/627199-new-ardoq-experience-get-started-with-in-view-data-modeling)

### Inferences
- The traversal design suits a D4-style "lens":
  - The lens is declared as typed edge patterns.
  - The root is chosen at run time.
  - Edge direction is explicit.
  - Expansion is staged breadth-first.
  - Grouping (for example, by parent) and conditional formatting are separate layers over the result set.
- Ardoq lets users run raw Gremlin. That is the opposite of D4's rule against raw Cypher, so a D4 lens should keep Ardoq's declarative triple model, not its query console.

### Gaps
- Not covered: the full list of Discover view styles (block diagram, matrix, capability map), how survey-based data collection works, and the semantics of swimlane and matrix configuration. Survey docs were not fetched.

## SAP LeanIX: fact sheets, reports, views/heatmaps, metamodel

### Takeaway
LeanIX reports are generic over fact-sheet types and relations. A landscape report clusters by relation or single-select field. A matrix report lets each axis be any relation, field or tag group. The "View" dropdown colours cards by any attribute or relation, which is the heatmap.

### Cited Findings
- Standard reports: Landscape, Matrix, Portfolio, Circle Map, Cost, Roadmap, World Map. Sources disagree on counts (four types at creation, five defaults, plus radars). — [LeanIX docs: Reports](https://docs-eam.leanix.net/docs/reports); [Using LeanIX Reports](https://docs-eam.leanix.net/docs/how-to-use-leanix-reports); [SAP PRESS blog](https://blog.sap-press.com/using-the-sap-leanix-application); [SAP Learning: Understanding Reports](https://learning.sap.com/courses/presenting-sap-leanix-for-fact-sheet-owners/understanding-reports-2)
- The Landscape Report gives a high-level view of the IT landscape at a point in time or over a time frame. It clusters via parent/child-style relations, and only single-select fields can be used for clustering. — [Using LeanIX Reports](https://docs-eam.leanix.net/docs/how-to-use-leanix-reports)
- A "view" means attributes or relations shown as colour coding. Landscape, Matrix, Roadmap and Circle Map reports can show selected fields and relations in a side panel. — [Using LeanIX Reports](https://docs-eam.leanix.net/docs/how-to-use-leanix-reports)
- Matrix Report: a colour-coded grid relating three fact-sheet types. In the Application Matrix, apps are the base and relations form the X and Y axes. In the lifecycle view, end-of-life apps show red. — [LeanIX: Matrix Report](https://docs-eam.leanix.net/docs/matrix-report)
- The new matrix report lets each axis be a different relation, field or tag group, and supports all relations, not only constraint relations. — [LeanIX update: new matrix report](https://updates.leanix.net/announcements/new-matrix-report)
- Landscape drill-downs can display chosen relations and colour drill-down items through the View dropdown. — [LeanIX update](https://updates.leanix.net/announcements/ann_qrMfJYIFGfZJW)
- Lifecycle and Quality Seal can be used as clustering options and as views. — [LeanIX update: cluster by lifecycle](https://updates.leanix.net/announcements/cluster-by-lifecycle-and-quality-seal-in-reports)
- The roadmap report shows fact-sheet types on each line. — [LeanIX update](https://updates.leanix.net/announcements/fact-sheet-types-visible-on-each-roadmap-report-line)
- Fact-sheet types:
  - About 12 predefined types (SAP Learning).
  - Core types: Application, Business Capability, Organization.
  - Advanced types: IT Component, Tech Category, Platform, Initiative.
  — [SAP Learning: Introducing SAP LeanIX](https://learning.sap.com/courses/presenting-sap-leanix-for-fact-sheet-owners/introducing-to-sap-leanix); [LeanIX Academy: modeling basics](https://academy.leanix.net/modeling-basics); [LeanIX Academy: fact sheet types](https://academy.leanix.net/modeling-fact-sheet-types)
- Custom reports can be built on the matrix pattern. — [LeanIX: matrix custom report](https://docs-eam.leanix.net/docs/matrix-custom-report)

### Inferences
- LeanIX gets its metamodel-agnostic behaviour by parameterising every report over (base type, cluster relation or field, colour view, drill-down relations).
- The single-select restriction on clustering means grouping keys must be functional: each element falls into one cell. A D4 grouping relationship should have the same cardinality constraint, or define how elements that belong to several groups are handled.

### Gaps
- LeanIX docs now redirect to help.sap.com, which rendered empty here. Interface Circle Map and saved-report/bookmark specifics were not verified in full.

## Sparx EA, BiZZdesign Horizzon, MEGA Hopex, Alfabet, iServer, ABACUS

### Takeaway
Primary evidence found was thin. Alfabet has a diagram designer for application landscape diagrams. Sparx Prolaborate provides web dashboards and APM views. Nothing reliable was found this session on Horizzon, Hopex, iServer or ABACUS heatmaps.

### Cited Findings
- The Alfabet Diagram Designer models IT landscape assets. Saved diagrams appear under Diagrams > Application Landscape Diagram. — [Alfabet docs: Design diagrams of your IT landscape](https://documentation.alfabet.com/en/UserGuide_GS_DiagDes.html)
- Sparx Prolaborate:
  - Web visualization and collaboration on EA models.
  - Customisable dashboards with charts, including hierarchical charts.
  - Prolaborate 5 supports Application Portfolio Management.
  — [Prolaborate: EA charts and visualizations](https://prolaborate.sparxsystems.com/?p=13887); [sparxsystems.eu](https://sparxsystems.eu/?p=5114)
- iServer imports Visio diagrams in their native format. — [CIO Korea](https://www.cio.com/article/3502093/)
- An ABACUS user named the catalog and diagrams as its most valuable features. — [PeerSpot](https://www.peerspot.com/products/comparisons/avolution-abacus_vs_iserver_vs_mega-hopex)

### Gaps
- Not verified: BiZZdesign Horizzon's colour/label views and generated heatmaps; MEGA Hopex's generated diagrams; ABACUS's auto-generated "nested box" views. Search returned no vendor documentation for any of these. Do not cite any of them without further research.

## Most-used visual idioms and how views bind to metamodel concepts

### Takeaway
The recurring idioms across Ardoq and LeanIX:
- Nested-box landscapes or capability maps (cluster by a parent or grouping relation) with heatmap colouring.
- Matrices (two relations or fields as axes).
- Dependency or interface maps (typed traversal with depth).
- Roadmaps/timelines (lifecycle dates).
- Treemaps (aggregation).

Each one is defined by naming metamodel relations and fields, never hard-coded types.

### Cited Findings
- Grouping/nesting comes from relations: LeanIX clusters via parent/child relations or single-select fields ([Using LeanIX Reports](https://docs-eam.leanix.net/docs/how-to-use-leanix-reports)). Ardoq's default grouping is "Group by Parent All" ([Ardoq: Dependency map](https://help.ardoq.com/en/articles/44007-dependency-map)).
- Colour comes from fields or relations: the LeanIX View dropdown ([Using LeanIX Reports](https://docs-eam.leanix.net/docs/how-to-use-leanix-reports)) and Ardoq conditional formatting by cost ([Ardoq: Dependency map](https://help.ardoq.com/en/articles/44007-dependency-map)).
- Inclusion is defined by typed relationship patterns: Ardoq triples ([Understanding viewpoints](https://help.ardoq.com/en/articles/43962-understanding-viewpoints)) and the ArchiMate/Archi allowed-concept sets ([archi-scripting wiki](https://github.com/archimatetool/archi-scripting-plugin/wiki/View)).
- Use cases with sources:
  - Lifecycle and ownership of applications, retirement timing ([Ardoq five viewpoints](https://help.ardoq.com/en/articles/176967-five-commonly-used-viewpoints-in-ardoq-and-how-to-create-them)).
  - Capability realization ([same](https://help.ardoq.com/en/articles/176967-five-commonly-used-viewpoints-in-ardoq-and-how-to-create-them)).
  - Integration and data lineage ([same](https://help.ardoq.com/en/articles/176967-five-commonly-used-viewpoints-in-ardoq-and-how-to-create-them)).
  - End-of-life heatmap in a matrix ([LeanIX Matrix](https://docs-eam.leanix.net/docs/matrix-report)).
  - Finding capabilities with no applications ([Ardoq Gremlin examples](https://help.ardoq.com/en/articles/44074-gremlin-graph-search-examples)).

### Inferences
- A metamodel-agnostic lens spec could be a tuple of:
  - root selector (a catalog query);
  - typed edge patterns with direction and depth (Ardoq triples);
  - a grouping relation for nesting, which should be functional;
  - colour or label bindings to fields;
  - a layout idiom (nested boxes, matrix, force/dependency, timeline, treemap).
- "Impact of retiring a system": combine a dependency traversal from the app (interfaces, processes, capabilities) with lifecycle colouring. This is assembled from the cited features, not a vendor-documented recipe.

### Gaps
- No usage statistics were found on which idiom is most used; the ranking above is inferred from how prominent each is in the docs.
- No banking-specific vendor examples were found (for example, a payments capability map or a core-banking retirement case).
