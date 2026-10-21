# Journey 3 — Propose a change and get it reviewed

**Who:** a contributor (author) and an architect or admin (reviewer). **Goal:** add "Client Consents" and connect it, as one reviewed change.

## Author

1. Open **Proposals**, type the title "Add a data product for client consents" and press **Create**.

   ![New proposal](../images/proposal-empty.png)
2. Under **Add a change** choose **New element**, type DataProduct, name Client Consents, **Add to proposal**.
3. Add a second change, **Connect two elements**: From = the data store, relationship `HOLDS`, To = the new element (choose it under "new in this proposal"), role MASTER.
4. Confirm the green line "✓ Every change applies to the model as it is now."

   ![Draft proposal](../images/proposal-draft.png)
5. Press **Submit for review**.

## Reviewer

1. Open **Proposals › Waiting for review** and select it.
2. Read the numbered steps and the check result.
3. Add a **Review comment** and press **Approve and apply** (or write a reason and **Reject**).
4. The proposal becomes **applied**; both changes are in the model at the same instant. Use **open** next to a created element.

**Result:** a reviewed, atomic change with the reviewer's comment on record.
