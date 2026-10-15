# ADR 0003: Metamodel-driven node labels

**Status:** Accepted, 2026-10-15

## Decision
Every node gets the labels `:Element`, `:<Layer>Layer`, its type and all ancestor types. For example, a Division is `:Element:OrganisationLayer:Division:OrgUnit`.

Layer labels carry a `Layer` suffix so they never collide with type labels such as `Application`.

Data-store roles (Master, Golden Copy, Approved Distributor, Replica, Consumer Cache) are a property on the `HOLDS` relationship, not a node label, because one store can play different roles for different data products.

## Consequences
- Queries can target a whole layer, a supertype or an exact type with label matching alone.
- Renaming a type requires a metamodel migration that relabels nodes (handled by the Worker in Phase 4).
