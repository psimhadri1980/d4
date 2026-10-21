# Backups (admin)

![Backups page](../images/backups.png)

Every workspace is backed up automatically each day. The **Backups** page (admins only) shows the backups of the current workspace — when taken, kind (manual or scheduled), contents (counts of elements and relationships, including soft-deleted ones) and a checksum — and offers:

| Action | What it does |
|---|---|
| **Back up now** | Takes a backup immediately |
| **Check against the event log** | Compares the current graph with what the append-only event log says it should be. Reports "Matches the event log" or lists the differences |
| **Restore…** (per backup) | Loads that backup, then **replays every change recorded after it**, so nothing done since is lost |
| **Rebuild from the event log…** | Throws away the workspace graph and rebuilds it entirely from the event log |

Restore and rebuild ask you to **type the workspace slug** to confirm, and first save the current graph as a backup. While one runs, the workspace is **locked**: edits are refused with a "workspace is being restored" message and resume when the job finishes. Progress and results appear on [Jobs](../05-reporting/jobs.md) and in a status bar on the page.

See the journey [Protect and recover a workspace](../07-user-journeys/11-back-up-and-restore.md).
