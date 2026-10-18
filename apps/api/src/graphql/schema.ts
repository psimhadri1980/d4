/** GraphQL is read-only (D17): changes go through the REST command endpoints. */
export const typeDefs = /* GraphQL */ `
  "Arbitrary JSON (attribute maps, event payloads, enum tables)."
  scalar JSON

  type Query {
    me: Me!
    workspaces: [Workspace!]!
    workspace(id: ID!): Workspace
  }

  type Me {
    subject: String!
    userId: ID!
    tenantId: ID!
    roles: [String!]!
  }

  type Workspace {
    id: ID!
    slug: String!
    name: String!
    description: String
    metamodel: Metamodel!
    "asOf: only items valid on that date. scenario: the baseline plus that Scenario element's items."
    elements(filter: ElementFilter, first: Int, after: String, asOf: String, scenario: ID): ElementConnection!
    element(id: ID!): Element
    relationship(id: ID!): Relationship
    "Scheduled roadmap for deliverables in scope (see REST /roadmap). lanes: initiative | division | status | type | milestone | none."
    roadmap(scope: [ID!]!, lanes: String, today: String): Roadmap!
    "Differences between two views (dates and/or scenarios)."
    diff(from: ViewInput, to: ViewInput): ModelDiff!
  }

  type Roadmap {
    order: [ID!]!
    items: [RoadmapItem!]!
    criticalPath: [ID!]!
    conflicts: [RoadmapConflict!]!
    lanes: [RoadmapLane!]!
    lanesBy: String!
    changes: [RoadmapChange!]!
    dependencies: [RoadmapDependency!]!
    start: String
    end: String
  }

  type RoadmapItem {
    id: ID!
    name: String!
    kind: String!
    start: String
    end: String
    status: String
    lane: String
    earliestStart: String!
    earliestEnd: String!
    durationDays: Int!
    slackDays: Int!
    critical: Boolean!
  }

  type RoadmapConflict {
    kind: String!
    itemIds: [ID!]!
    message: String!
    days: Int
  }

  input ViewInput {
    asOf: String
    scenario: ID
  }

  type ModelDiff {
    elements: ElementDiff!
    relationships: RelationshipDiff!
    "Element id → name for the ends of every relationship listed."
    names: JSON!
  }

  type ElementDiff {
    added: [Element!]!
    removed: [Element!]!
  }

  type RelationshipDiff {
    added: [Relationship!]!
    removed: [Relationship!]!
    changed: [RelationshipChange!]!
  }

  type RelationshipChange {
    before: Relationship!
    after: Relationship!
    fields: JSON!
  }

  type RoadmapDependency {
    from: ID!
    to: ID!
    type: String!
    lagDays: Int!
  }

  type RoadmapLane {
    name: String!
    itemIds: [ID!]!
  }

  type RoadmapChange {
    deliverableId: ID!
    elementId: ID!
    elementName: String!
    elementType: String!
    action: String!
    targetLifecycle: String
  }

  type Metamodel {
    id: String!
    version: String!
    layers: [String!]!
    enums: JSON!
    nodeTypes: [NodeType!]!
    relationshipTypes: [RelationshipType!]!
  }

  type NodeType {
    name: String!
    layer: String!
    description: String
    extends: String
    internal: Boolean!
    "Neo4j labels nodes of this type carry."
    labels: [String!]!
    "Effective attributes: common, inherited and own."
    attributes: [AttributeDef!]!
  }

  type RelationshipType {
    name: String!
    description: String
    from: [String!]!
    to: [String!]!
    attributes: [AttributeDef!]!
  }

  type AttributeDef {
    name: String!
    type: String!
    enum: String
    "Allowed values when type is enum."
    values: [String!]
    required: Boolean!
    description: String
  }

  input ElementFilter {
    "Element types; supertypes include their subtypes."
    types: [String!]
    layer: String
    lifecycle: [String!]
    "Full-text search over name and description (ranked, not cursor-paged)."
    search: String
  }

  type ElementConnection {
    nodes: [Element!]!
    pageInfo: PageInfo!
  }

  type PageInfo {
    endCursor: String
    hasNextPage: Boolean!
  }

  enum Direction {
    OUT
    IN
    BOTH
  }

  type Element {
    id: ID!
    type: String!
    name: String
    lifecycle: String
    attrs: JSON!
    version: Int!
    validFrom: String
    validTo: String
    scenarioId: String
    createdAt: String!
    createdBy: String!
    updatedAt: String!
    updatedBy: String!
    connections(direction: Direction = BOTH, types: [String!], asOf: String, scenario: ID): [Connection!]!
    neighbourhood(depth: Int = 1, types: [String!], limit: Int = 500, asOf: String, scenario: ID): Subgraph!
    history: [Event!]!
  }

  type Relationship {
    id: ID!
    type: String!
    fromId: ID!
    toId: ID!
    from: Element
    to: Element
    attrs: JSON!
    version: Int!
    validFrom: String
    validTo: String
    scenarioId: String
    createdAt: String!
    createdBy: String!
    updatedAt: String!
    updatedBy: String!
    history: [Event!]!
  }

  type Connection {
    relationship: Relationship!
    other: Element!
    "Direction of the relationship as seen from the element being queried."
    direction: Direction!
  }

  type Subgraph {
    root: Element!
    elements: [Element!]!
    relationships: [Relationship!]!
    truncated: Boolean!
  }

  type Event {
    seq: Float!
    id: ID!
    type: String!
    actor: String!
    occurredAt: String!
    version: Int!
    data: JSON!
  }
`;
