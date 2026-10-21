# Journey 10 — Keep D4 in sync with another system

**Who:** admin. **Goal:** import applications from a CMDB's JSON API every night.

1. **Connectors › Add connector**, Source type **JSON API**.

   ![Connector](../images/connector-form.png)
2. Name "CMDB", key `cmdb`, the source URL, authentication (bearer token), conflict policy **Keep the D4 version and report it**.
3. Edit the **Mapping**: `itemsPath`, entity type, id, name, attributes (translate status codes with `map`), related records.
4. Create it, then press **Dry run** and read the report of what would change.
5. Press **Sync now**. Check the result bar and the **needs attention** list.
6. Search the Explorer for an imported application: its *external key* starts with `cmdb`.
7. When happy, give the connector a schedule.

Elements an owner edits in D4 are not overwritten on later syncs unless you chose **Take the source version**.
