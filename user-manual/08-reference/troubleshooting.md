# Troubleshooting

| What you see | Why and what to do |
|---|---|
| Menu items such as Admin, Connectors or Backups are missing | You lack the admin role. Ask an admin ([People and roles](../06-administration/people-and-roles.md)) |
| "Administration needs the admin role" | Same |
| An edit is refused as forbidden | You need contributor, planner, architect or admin |
| **Version conflict** when saving | Someone changed the element after you opened it. Reload, redo your change |
| **Rule violation** naming a rule | The change breaks a metamodel rule (for example two masters). Adjust dates or roles |
| **Lifecycle cannot move from X to Y** | Not an allowed move; see [lifecycle](lifecycle.md) |
| "Workspace is being restored or rebuilt" | Writes are paused until the backup job ends; watch Jobs |
| **Quota exceeded** | A tenant limit was reached; see [Usage](../06-administration/usage-and-limits.md) |
| A query says a required parameter is missing | Choose an entry in the picker (not "— none selected —") |
| A query fails the checks | Read the ✗ lines: add `$workspace` filter, `LIMIT`, remove write clauses, declare parameters |
| Import says nothing is written | By design: every row must be valid. Fix the listed rows and Check again |
| The graph looks crowded | Lower depth, try **Hierarchy**, press **Fit**, or double-click only the nodes you need |
| A file on Jobs says "File expired" | Files are kept 30 days. Run the export again |
| Scheduled report is paused | Its owner lost access to the workspace; the reason is shown |
| Page stuck on "Signing in…" | Reload; local installs must use `http://localhost:5173` |
| Search finds nothing for a new element | Search indexes after a moment; retry, or check filters (layer/type, As of, Scenario) |

If the problem persists, note the time, the page URL and the message, and contact your D4 administrator.
