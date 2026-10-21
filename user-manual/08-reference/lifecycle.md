# Element lifecycle

Elements move from idea to retirement through eight states. New elements start at **IDEA**.

| State | Meaning |
|---|---|
| IDEA | Captured, not yet considered |
| PROPOSED | Put forward for a decision |
| DECIDED | Approved |
| PLANNED | Scheduled for delivery |
| IN_DEVELOPMENT | Being built |
| LIVE | In use |
| DEPRECATED | Still present, being phased out |
| RETIRED | Gone (final) |

## Allowed moves

The Edit form offers only these:

| From | Can go to |
|---|---|
| IDEA | PROPOSED, RETIRED |
| PROPOSED | DECIDED, IDEA, RETIRED |
| DECIDED | PLANNED, PROPOSED, RETIRED |
| PLANNED | IN_DEVELOPMENT, DECIDED, RETIRED |
| IN_DEVELOPMENT | LIVE, PLANNED, RETIRED |
| LIVE | DEPRECATED |
| DEPRECATED | RETIRED, LIVE |
| RETIRED | (none) |

Forward along the design-to-delivery path; one step back for rework before delivery; early retirement (rejected or cancelled) before go-live; and un-deprecation. A live element cannot be "cancelled": deprecate it first.
