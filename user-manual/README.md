# D4 User Manual

D4 (Design-to-Delivery Graph) captures your organisation's design elements — strategy, organisation, business, data, applications, technology, governance, design and planning — as one connected graph. You can explore it, ask curated questions of it, plan and schedule change against it, compare it over time, and export it.

This manual is for **people who use D4**, not for people who change its code (see [docs/DEVELOPER_GUIDE.md](../docs/DEVELOPER_GUIDE.md) for that). Screenshots were taken from the local stack with the illustrative UBS sample model; your data will differ.

## How to read this manual

- New to D4? Read [Getting started](01-getting-started/) in order, then pick a [user journey](07-user-journeys/) that matches your job.
- Looking for one screen? Use the feature chapters below.
- Stuck? See [Troubleshooting](08-reference/troubleshooting.md).

## Contents

### 1. Getting started
- [What D4 is and key concepts](01-getting-started/concepts.md)
- [Signing in](01-getting-started/signing-in.md)
- [A tour of the screen](01-getting-started/interface-tour.md)
- [Roles and what each can do](01-getting-started/roles-and-access.md)

### 2. Explore
- [The Explorer: find elements and read the graph](02-explore/explorer.md)
- [Creating, editing and deleting elements and relationships](02-explore/editing.md)
- [Time and scenarios: "As of" and what-if](02-explore/time-and-scenarios.md)
- [Compare two views](02-explore/compare.md)
- [Matrices](02-explore/matrices.md)
- [Queries: catalog, studio and stewardship](02-explore/queries.md)

### 3. Plan and govern
- [Roadmap](03-plan-and-govern/roadmap.md)
- [Decisions](03-plan-and-govern/decisions.md)
- [Change proposals](03-plan-and-govern/change-proposals.md)

### 4. Data management
- [Importing spreadsheets](04-data-management/import.md)
- [Exporting](04-data-management/export.md)
- [Connectors (admin)](04-data-management/connectors.md)
- [Backups (admin)](04-data-management/backups.md)
- [Model as code and the `d4` command line](04-data-management/model-as-code-and-cli.md)

### 5. Reporting
- [Scheduled reports](05-reporting/reports.md)
- [Background jobs](05-reporting/jobs.md)

### 6. Administration
- [Workspaces](06-administration/workspaces.md)
- [People and roles](06-administration/people-and-roles.md)
- [Webhooks](06-administration/webhooks.md)
- [Usage and limits](06-administration/usage-and-limits.md)

### 7. User journeys (end-to-end stories)
1. [Find out where a data product lives](07-user-journeys/01-find-where-data-lives.md) — viewer
2. [Add a new element and connect it](07-user-journeys/02-add-and-connect-an-element.md) — contributor
3. [Propose a change and get it reviewed](07-user-journeys/03-propose-and-review-a-change.md) — contributor + architect
4. [Plan a programme and spot schedule conflicts](07-user-journeys/04-plan-a-programme.md) — planner
5. [Model a what-if scenario and compare it](07-user-journeys/05-what-if-scenario.md) — planner / architect
6. [Write, review and publish a catalog query](07-user-journeys/06-publish-a-query.md) — author + steward
7. [Load an existing spreadsheet inventory](07-user-journeys/07-load-a-spreadsheet.md) — contributor
8. [Send a weekly roadmap PDF to stakeholders](07-user-journeys/08-weekly-roadmap-report.md) — planner
9. [Set up a workspace and onboard a team](07-user-journeys/09-set-up-a-workspace.md) — admin
10. [Keep D4 in sync with another system](07-user-journeys/10-sync-another-system.md) — admin
11. [Protect and recover a workspace](07-user-journeys/11-back-up-and-restore.md) — admin

### 8. Reference
- [Glossary](08-reference/glossary.md)
- [Element lifecycle](08-reference/lifecycle.md)
- [Keyboard shortcuts and URLs](08-reference/shortcuts-and-urls.md)
- [Troubleshooting](08-reference/troubleshooting.md)

## Regenerating the screenshots

Screenshots live in [images/](images/) and are captured from the running stack by [apps/e2e/screenshots/manual.shots.ts](../apps/e2e/screenshots/manual.shots.ts):

```bash
deploy/dev.sh up && deploy/dev.sh sample
deploy/dev.sh e2e -c screenshots.config.ts      # writes apps/e2e/results/shots/*.png
cp apps/e2e/results/shots/*.png user-manual/images/
```
