# Journey 9 — Set up a workspace and onboard a team

**Who:** admin.

1. **Admin › Workspaces**: enter name "Retail Banking", slug `retail-banking`, Metamodel **Banking**, **Create workspace**.

   ![Create workspace](../images/admin-workspaces.png)
2. Switch to the new workspace in the rail.
3. **Admin › People and roles**: set **Roles for** to the new workspace and grant:
   - the data team: **contributor**,
   - architects: **architect** (so they can review proposals),
   - everyone else: **viewer**.

   ![Grant roles](../images/admin-people.png)
   People appear in the list after their first sign-in; ask them to sign in once.
4. Load starting content with [Import](07-load-a-spreadsheet.md) or `d4 import`.
5. Optionally add a [webhook](../06-administration/webhooks.md) for downstream tools, and check **Usage** now and then.
6. Grant **query-author**/**query-steward** to the people who curate the query catalog.
