# Roadmap

The Roadmap draws the deliverables and milestones that change a chosen part of your landscape as a **Gantt chart**, scheduled with their dependencies.

![Roadmap for the Client Data Consolidation initiative](../images/roadmap.png)

## Choose a scope

In the **Scope** panel on the left tick one or more:

- **Initiatives**,
- **Divisions**,
- or search under **Any element** (for example "Legacy Client") to see all deliverables that change that element.

Chosen items appear as removable chips. Until you choose something the page shows only the instructions.

Then pick:

- **Lanes by**: Initiative, Division, Status, Type, Milestone or None. Lanes are the horizontal groups.
- **Zoom**: Week, Month or Quarter.

Scope, lanes and zoom live in the URL, so you can share the exact view.

## Read the chart

Legend (bottom left of the panel):

| Mark | Meaning |
|---|---|
| Green bar | Scheduled work |
| Dashed outline | The plan differs from what the dependencies allow ("planned" vs earliest possible) |
| **Red** bar | On the **critical path**: any slip delays the end date |
| Diamond | Milestone |
| Arrows | Dependencies between deliverables |
| Dotted vertical line | Today |

The header above the chart summarises the date range, number of items, items on the critical path and number of conflicts.

## Conflicts

Below the chart, **Conflicts** lists problems, for example:

- **Planned too early**: "Migrate client master to MDM Hub is planned 30 days too early for Publish Client Master contract v2" — it starts before something it depends on can finish.
- **Misses milestone**: "finishes 29 days after Client master cut-over".

If there are none the page says "No conflicts. The plan is consistent with its dependencies." Conflict rows and chart bars have a red marker; click either to inspect.

## Inspect an item

Click a bar to open the details pane on the right.

![Selected deliverable](../images/roadmap-item.png)

It shows planned dates, **earliest** dates, duration and **slack**, what it **depends on**, what **needs it**, the elements it **changes** (with the action such as INTRODUCE or MODIFY and the target lifecycle), and any conflicts. **Open in Explorer** and **Edit dates** take you to the element.

## Export and share

Above the chart:

- **Export CSV** and **Export Mermaid** download the schedule immediately.
- **Picture: PDF / PNG / SVG** renders in the background; the file appears in [Jobs](../05-reporting/jobs.md).
- **Schedule…** creates a recurring report ([Scheduled reports](../05-reporting/reports.md)).

## How the data is modelled

A roadmap item is a **Deliverable** (or Milestone) with planned start and end dates. Dependencies come from `DEPENDS_ON` relationships, and "changes" from `CHANGES` relationships to the elements being introduced, modified or retired. To change the plan, edit the dates in the Explorer or through a [change proposal](change-proposals.md).
