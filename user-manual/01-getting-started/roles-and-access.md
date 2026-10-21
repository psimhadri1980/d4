# Roles and what each can do

Your roles come from your organisation's identity provider and, in addition, from **role bindings** an administrator grants you in D4 for the whole tenant or for one workspace ([People and roles](../06-administration/people-and-roles.md)). You get the combination of both.

| Role | Can do |
|---|---|
| **viewer** | Read everything in the workspace; run catalog queries that are granted to viewers; export; use Compare, Matrices, Roadmap, Decisions |
| **contributor** | Everything a viewer can, plus create, edit and delete elements and relationships; import; draft change proposals |
| **planner** | As contributor, aimed at roadmap and scenario work |
| **architect** | As contributor, plus **review** change proposals (approve/reject) |
| **query-author** | Write catalog queries in the Query studio and submit them for review |
| **query-steward** | Review, publish, grant, certify, deprecate and retire catalog queries |
| **admin** | Everything, including Admin pages, Connectors, Backups, workspaces, webhooks; may also review any query or proposal |

Rules of thumb:

- **Writing to the model** needs contributor, planner, architect or admin.
- **Reviewing proposals** needs architect or admin, and never your own proposal.
- **Reviewing a query** needs query-steward (or admin); only admins may review their own query.
- A **viewer** who tries to write is refused with a clear message.
- Access is per workspace: you only see workspaces you can access, and other organisations' data is never visible.

Which catalog query you can *run* depends on grants a steward sets per role (see [Queries](../02-explore/queries.md)).
