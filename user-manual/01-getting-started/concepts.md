# What D4 is and key concepts

D4 stores your design landscape as a **graph**: things (elements) and the relationships between them. Because everything is connected, you can ask questions such as "which applications depend on this data store?" or "what changes if we retire this system?" and see the answer as a picture, a table or a plan.

## Elements

An **element** is one thing in your landscape: a goal, a division, a business capability, a data product, an application, a decision, a deliverable. Every element has:

| Property | Meaning |
|---|---|
| **Type** | What kind of thing it is (for example `DataProduct`, `Application`, `Initiative`). The list of types comes from the workspace's *metamodel*. |
| **Layer** | The group the type belongs to: Strategy, Organisation, Business, Data, Application, Technology, Governance, Design or Planning. Each layer has its own colour. |
| **Name, description** | Free text. Name is required. |
| **Lifecycle** | Where it is on the path from idea to retirement. See [Element lifecycle](../08-reference/lifecycle.md). |
| **Attributes** | Extra fields that depend on the type (for example an Application has criticality, hosting and a TIME class). |
| **Valid from / to** | Optional dates between which the element exists. Used by the "As of" view. |
| **Version** | Goes up by one with every change. Used to stop two people overwriting each other. |

## Relationships

A **relationship** connects two elements and has a direction and a type written in capitals, for example `HOLDS`, `CONSUMES`, `CHANGES`, `PART_OF`. Relationships can carry attributes (a `HOLDS` relationship has a *role* such as MASTER or REPLICA) and their own valid-from/to dates. The metamodel decides which types of element a relationship may join, so the screens only offer valid choices.

## The metamodel

The **metamodel** is the rulebook of a workspace: which element types, attributes, relationship types and rules exist. The starter metamodel has about 125 element types. Administrators can pick an industry pack (Banking, Insurance) when creating a workspace to add more. Rules are checked for you, for example "a data product has at most one master store at any time".

## Workspaces

A **workspace** is a separate model inside your organisation (a *tenant*). You work in one workspace at a time; its name is the first item in the breadcrumb at the top. Each workspace is tied to one metamodel version.

## Time and scenarios

- **As of** shows the model on a chosen date, using the valid-from/to dates.
- A **scenario** is a what-if layer on top of the baseline. Changes made while a scenario is selected stay in the scenario.

See [Time and scenarios](../02-explore/time-and-scenarios.md).

## Nothing is lost

Deleting an element is a *soft delete*: it disappears from views but its history is kept. Every change is recorded in an append-only event log, which is why you can see an element's **History** and why backups can be restored exactly.

## Queries without Cypher

You never type database queries to read the model. You run **catalog queries** that experts (query authors) wrote and stewards approved. See [Queries](../02-explore/queries.md).
