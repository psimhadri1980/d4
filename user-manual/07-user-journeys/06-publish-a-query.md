# Journey 6 — Write, review and publish a catalog query

**Who:** a query-author and a query-steward (an admin can do both, but cannot be the *only* check in a real team). **Goal:** share an "Applications by lifecycle" list with all viewers.

## Author

1. **Queries › Studio › + New query**: Title "Applications by lifecycle", tags "inventory, applications", **Create**.

   ![New query](../images/studio-new.png)
2. Paste the Cypher:
   ```cypher
   MATCH (n:Application)
   WHERE n.workspaceId = $workspace AND n.deleted = false
   RETURN n.name AS name, n.lifecycle AS lifecycle
   ORDER BY name
   LIMIT 100
   ```
3. **Save draft**; make sure the checks say "✓ All checks pass". **Test run** to see the rows.

   ![Test run](../images/studio-test-run.png)
4. **Submit for review**.

## Steward

1. Under **Stewardship** open the waiting query.

   ![Review](../images/stewardship-review.png)
2. Compare Cypher, run a **Test run**, then **Publish** (or **Send back** with a note).
3. In **Who can run it** tick **viewer** (and others) and **Save grants**. Optionally **Certify**.

## Consumer

A viewer opens **Queries › Catalog**, picks the query and presses **Run**.

**Result:** a governed, fingerprinted query that everyone with the grant can run, and whose runs are logged.
