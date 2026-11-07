# Data lineage and data catalog visualisation and interaction patterns

## Lineage UIs across vendors (DataHub, OpenLineage/Marquez, Collibra, Atlan, dbt, Purview, Manta, Solidatus, Unity Catalog)

### Takeaway
Every major tool converges on the same core: a left-to-right (upstream-left, downstream-right) graph centred on one asset, revealed incrementally with "+" expanders one hop at a time, with columns expandable inside table nodes, and an "impact" list or table (exportable to CSV) beside the graph. They differ on abstraction layers (Collibra business vs technical, Manta layers) and on how they cap graph size.

### Cited Findings
- DataHub exposes lineage in three places: the entity Lineage tab, an Explorer visualisation, and an Impact Analysis tool; the entity sidebar also shows a quick impact summary — [DataHub lineage guide](https://docs.datahub.com/docs/features/feature-guides/lineage)
- DataHub: expand a table's columns in the table-level graph to see column lineage; hover/click highlights connected columns; a breadcrumb on a column opens a view focused on that single column when the graph gets crowded or points at hidden assets — [DataHub lineage guide](https://docs.datahub.com/docs/features/feature-guides/lineage)
- DataHub pipelines render tasks inside a central box; only one task's upstreams and one task's downstreams can be expanded at a time "to keep the view manageable"; expand buttons show a dependency count — [DataHub lineage guide](https://docs.datahub.com/docs/features/feature-guides/lineage)
- DataHub time picker hides edges last updated outside a window (it does not show historical lineage) — [DataHub UI lineage](https://docs.datahub.com/docs/features/feature-guides/ui-lineage)
- DataHub lineage can be edited manually from the graph; manually added edges carry a user avatar showing who added it and when; needs "Edit lineage" privilege on both ends — [DataHub UI lineage](https://docs.datahub.com/docs/features/feature-guides/ui-lineage)
- DataHub Impact Analysis filters: degree of dependency (1 hop, 2 hops, all), entity type, platform, domain, owner; a column-lineage toggle in the same view; CSV export capped at 10,000 records and for columns lists impacted entities, not the column-to-column path (GraphQL needed for paths) — [DataHub support article](https://support.datahub.com/hc/en-us/articles/50281784462363-Generating-Impact-Analysis-and-Lineage-Reports) (single source; version-dependent)
- DataHub marketing claims impact analysis across up to 1,000 hops / 40,000 relationships per query (promotional, unverified) — [DataHub lineage software](https://datahub.com/?p=10101)
- Marquez (OpenLineage reference implementation) models lineage as a bipartite graph of jobs and datasets; UI defaults to the current graph; job version history can reveal other nodes per version — [Marquez on ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2FMarquezProject%2Fmarquez); [OpenLineage getting started](https://openlineage.io/getting-started)
- A lineage API with a `depth` parameter (e.g. depth=3) is shown in a third-party blog; not confirmed against Marquez docs — [Iceberg Lakehouse blog 2026-05-24](https://iceberglakehouse.com/posts/2026-05-24-openlineage-observability/)
- Collibra: technical lineage targets engineers/architects and shows all data objects in sources whether or not catalogued; business lineage shows only Collibra assets that represent those objects and is a summary of technical lineage; built from the "Data Element sources/targets Data Element" relation — [Collibra docs: diagram differences](https://productresources.collibra.com/docs/collibra/latest/Content/CollibraDataLineage/ref_technical-lineage-diagram-differences.htm)
- Collibra distinguishes lineage (facts of flow) from traceability (role-specific views adding which policies/standards applied; can assess impact of a new policy or asset) — [Collibra blog: lineage vs traceability](https://www.collibra.com/blog/the-difference-between-lineage-and-traceability)
- Atlan: "+" beside the base asset expands upstream (left) or downstream (right); "Expand all"; "Show all" loads more vertically, with a prompt above 100 assets — [Atlan view lineage](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md)
- Atlan column lineage: column menu on each asset with count of columns that have lineage; column search/sort, default 10 shown; sidebar Lineage tab with "View impact" and an eye icon setting Depth up to a Max Depth; "Show hierarchy" and "Show process nodes" toggles — [Atlan view lineage](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md)
- Atlan focus tools: a Visibility slider dims assets outside the selected path; "Find in canvas"; refocus to selected/base node; hover popover with owners, usage, certificate, data quality; minimap, legend, fullscreen — [Atlan view lineage](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md)
- Atlan export: View/Download impact (CSV, Google Sheets, Excel online), download graph as image — [Atlan view lineage](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md); [Atlan impact analysis tag](https://docs.atlan.com/tags/impact-analysis)
- dbt column-level lineage lives on the column card in Catalog; a "column evolution" lens marks columns as transformed vs reused (passthrough/rename), colour-coded; a Transformation column previews the formula; CLL does not reflect joins/filters usage — [dbt column-level lineage](https://docs.getdbt.com/docs/explore/column-level-lineage)
- Paradime (dbt catalog): lens strip, depth controls and Graph/Table toggle above the canvas; "Hide indirect edges" removes joins/filters/grouping edges to show pure value flow — [Paradime CLL](https://docs.paradime.io/products/data-catalog/lineage/column-level-lineage)
- Microsoft Purview: "Switch to asset" navigates from a lineage node to its catalog page; hover a column to see column mapping; filter columns by name; a toggle filters nodes — [Purview lineage user guide](https://learn.microsoft.com/ar-SA/purview/catalog-lineage-user-guide)
- Purview community answer: no UI switch to hide column-level relationships; everything scanned shows — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5845759/request-for-guidance-simplifying-data-lineage-visu)
- Manta (IBM): each element belongs to a layer (physical: tables, files; business: assets); with several layers the UI shows layer tabs and selecting one hides the others — [MANTA Flow Visualization docs (IBM PDF)](https://ibm.com/support/pages/system/files/inline-files/MANTA%20Flow%20Visualization%20User%20Documentation.pdf)
- Unity Catalog: Lineage tab shows one level by default; "+" on a node reveals more; clicking a column highlights related columns; clicking an edge opens a connection panel naming notebooks/jobs; nodes without BROWSE/SELECT appear masked and cannot be expanded past; lineage also in system tables `system.access.table_lineage` / `column_lineage` — [Databricks lineage docs](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage.html)
- Solidatus 2026 positioning: "Connected Catalog", "Data Map", an AI Lineage Assistant drafting mappings and impact with sandboxed human-in-the-loop approval — [Solidatus AI product page](https://www.solidatus.com/product/agentic-ai/); [Solidatus ECB blog](https://www.solidatus.com/blog/detailed-expectations-around-data-lineage-and-bcbs-239-from-the-european-central-bank-ecb/)

### Inferences
- The de facto pattern for a D4 lens: centre node, directional layout, per-node "+" expanders with counts, column drill-down inside nodes, and a synchronised impact table with export.
- Permission-aware masking (Unity Catalog) and edge provenance (DataHub avatars) are cheap, high-trust features worth copying.

### Gaps
- Could not retrieve Solidatus "sheets/layers" specifics, Alation and Informatica UI docs, or dbt Explorer's own lineage-bar documentation within budget.

## Interaction mechanics: hop expansion, granularity, filtering, grouping, path highlighting, impact tables

### Takeaway
Mechanics are: hop-limited expansion (1/2/all, or a depth slider), granularity switching (system/table/column, or layer tabs), filters by type/platform/domain/owner/time, grouping by container (pipeline box, hierarchy), path focus by dimming, and a tabular impact list that is the real deliverable.

### Cited Findings
- Hop filter 1/2/all plus type/platform/domain/owner filters — [DataHub support](https://support.datahub.com/hc/en-us/articles/50281784462363-Generating-Impact-Analysis-and-Lineage-Reports)
- Depth slider up to max depth; visibility slider dims off-path assets — [Atlan](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md)
- Layer tabs as granularity switch — [MANTA docs](https://ibm.com/support/pages/system/files/inline-files/MANTA%20Flow%20Visualization%20User%20Documentation.pdf)
- Collibra lineage tree view "particularly useful if there are many nodes"; "Collapsed attributes" to show only chosen columns; browse pane to scope part of the graph — [Collibra technical lineage graph](https://docs.collibra.com/Content/CollibraDataLineage/ref_technical-lineage-graph.htm)
- Graph/Table toggle — [Paradime](https://docs.paradime.io/products/data-catalog/lineage/column-level-lineage)

### Inferences
- Offering both a graph and an equivalent tree/table view is a common answer to scale.

### Gaps
- No vendor documentation found for automatic "group by system" collapse in the visual graph beyond layers and containers.

## Business vs technical lineage; zoom from system to column

### Takeaway
Business lineage is a summary/projection of technical lineage onto curated catalog assets (Collibra), or a separate layer (Manta); regulators require attribute-level lineage, so system-level views are only an entry zoom level.

### Cited Findings
- Business lineage summarises technical lineage, showing only catalogued assets — [Collibra](https://productresources.collibra.com/docs/collibra/latest/Content/CollibraDataLineage/ref_technical-lineage-diagram-differences.htm)
- General metamodel: business layer, conceptual and logical levels, physical level (IT assets) — [Solutions Review](https://solutionsreview.com/thought-leaders/?p=770)
- ECB: system-level lineage is insufficient; lineage at data attribute level — [Solidatus on ECB RDARR](https://www.solidatus.com/blog/detailed-expectations-around-data-lineage-and-bcbs-239-from-the-european-central-bank-ecb/)

### Inferences
- A lens model where business lineage is a derived projection (collapse technical nodes onto business terms/CDEs) matches Collibra's approach.

### Gaps
- No primary source on smooth semantic zoom (continuous) vs discrete levels.

## "Where did this number come from" / "what breaks"; BCBS 239 and CDE tracing

### Takeaway
Regulators (ECB RDARR Guide, May 2024) expect complete, up-to-date, attribute-level, end-to-end lineage from data capture to report for CDEs behind key risk indicators, including manual steps, owners and DQ controls at each step. Upstream lineage answers provenance; downstream impact lists answer "what breaks".

### Cited Findings
- ECB: data capture is the lineage start point; lineage for CDEs of key risk indicators; complete end-to-end; ad hoc lineage rejected as it slows stress reporting; documentation covering systems, manual steps, business and technical owners, and DQ controls and requirements at each step; "complete and up-to-date" — [Solidatus on ECB RDARR](https://www.solidatus.com/blog/detailed-expectations-around-data-lineage-and-bcbs-239-from-the-european-central-bank-ecb/)
- Attribute-level lineage covering ETL, per EDM Council presentation — [EDM Council webinar PDF](https://edmcouncil.org/wp-content/uploads/2025/02/EDMWebinar_Solidatus_02-26-FINAL-Presentation.pdf)
- The 2013 BCBS 239 text does not use the word "lineage"; supervisors read it in from outcome principles — [DataHub BCBS 239 blog](https://datahub.com/?p=15324)
- Lineage as the answer to "show me how this number came to be"; CDE-first prioritisation rather than mapping everything — [Collibra BCBS 239 blog](https://www.collibra.com/blog/bcbs-239-explained-how-banks-can-prove-data-integrity-to-regulators)
- Map CDEs to report outputs and require lineage evidence before submission — [Gable BCBS 239 metrics](https://www.gable.ai/b/bcbs-239-compliance-metrics-what-to-measure-how-and-why)
- EY (2026) on sustaining lineage value in banks — [EY UK PDF](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-uk/industries/banking-capital-markets/documents/ey-uk-sustaining-the-value-of-data-lineage-03-2026.pdf) (not read in full)
- Pre-merge schema-change impact checks via DataHub column lineage (unofficial project) — [blastradius](https://github.com/himanshu748/blastradius)

### Inferences
- For credit-risk use: a lens rooted at a report line/CDE (e.g. RWA, PD) traversing upstream to capture systems, annotating each hop with owner, manual-step flag and DQ control status, directly maps to ECB documentation expectations.

### Gaps
- Primary BCBS 239 (bis.org) and ECB RDARR texts not fetched directly; quotes come via Solidatus.

## Pitfalls: spaghetti, too many hops, performance

### Takeaway
Vendors cap rendering and force scoping: Collibra hard-caps at 350 nodes / 1,000 edges and auto-truncates depth; Atlan pages at 100 assets; DataHub restricts pipeline expansion; Unity shows one level by default.

### Cited Findings
- Collibra: graph above 350 nodes or 1,000 edges is too large; typical cause is showing all columns of a table; auto-adjusts flow depth, marks truncated connections with an icon; uncatalogued temp tables shown grey add clutter — [Collibra technical lineage graph](https://docs.collibra.com/Content/CollibraDataLineage/ref_technical-lineage-graph.htm)
- Atlan: "Show all" prompt beyond 100 assets; columns default to 10 — [Atlan](https://docs.atlan.com/product/capabilities/lineage/how-tos/view-lineage.md)
- DataHub single-task expansion in pipelines; single-column focus view — [DataHub](https://docs.datahub.com/docs/features/feature-guides/lineage)
- Purview users ask for simplification; no column-hide switch — [Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5845759/request-for-guidance-simplifying-data-lineage-visu)
- Unity: one level by default — [Databricks](https://docs.databricks.com/aws/en/data-governance/unity-catalog/data-lineage.html)
- Paradime "Hide indirect edges" reduces noise — [Paradime](https://docs.paradime.io/products/data-catalog/lineage/column-level-lineage)

### Inferences
- Explicit node/edge budgets with visible truncation markers are better than silent dropping.

### Gaps
- No independent user-review data (G2 etc.) gathered on lineage usability complaints.

## dbt graph selector syntax as an authoring language

### Takeaway
dbt's compact operators (`+model`, `model+`, `n+model+m`, `@model`) express root plus directional, depth-bounded traversal in a single string, a proven, widely known notation for lens definitions.

### Cited Findings
- `my_model+` descendants; `+my_model` ancestors; `+my_model+` both; `my_model+1` first-degree; `2+my_model` parents and grandparents; `3+my_model+4` bounded both ways; `@my_model` descendants plus all their ancestors (front-only, used in CI) — [dbt graph operators](https://docs.getdbt.com/reference/node-selection/graph-operators)
- `*` is a name wildcard, not a graph operator; method selectors (tag:, path:) are on separate pages — [dbt graph operators](https://docs.getdbt.com/reference/node-selection/graph-operators)

### Inferences
- A D4 lens DSL could adopt `n+root+m` for depth and `@` for "closure needed to rebuild", combined with type filters akin to dbt methods.

### Gaps
- Set operators (union via space, intersection via comma, `--exclude`) not re-verified in this pass.
