export type Attributes = Record<string, unknown>;

/** ISO calendar date, `YYYY-MM-DD`. Validity periods are half-open: [validFrom, validTo). */
export type IsoDate = string;

/** Fields managed by the platform for every element and relationship. */
export interface SystemFields {
  id: string;
  workspaceId: string;
  /** Starts at 1, incremented on every change (optimistic concurrency). */
  version: number;
  validFrom: IsoDate | null;
  validTo: IsoDate | null;
  /** null = baseline; otherwise the Scenario this item belongs to. */
  scenarioId: string | null;
  deleted: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface Element extends SystemFields {
  /** Metamodel node type, e.g. `DataProduct`. */
  type: string;
  /** Metamodel-defined attributes, including common ones such as name and lifecycle. */
  attrs: Attributes;
}

export interface Relationship extends SystemFields {
  /** Metamodel relationship type, e.g. `HOLDS`. */
  type: string;
  fromId: string;
  toId: string;
  attrs: Attributes;
}

/** Who is acting, and in which workspace. */
export interface CommandContext {
  workspaceId: string;
  actor: string;
}

export const DOMAIN_EVENT_TYPES = [
  'ElementCreated',
  'ElementUpdated',
  'ElementDeleted',
  'RelationshipCreated',
  'RelationshipUpdated',
  'RelationshipDeleted',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

/** Appended to the event log; drives audit, history, webhooks and rebuilds. */
export interface DomainEvent {
  id: string;
  type: DomainEventType;
  workspaceId: string;
  actor: string;
  occurredAt: string;
  subjectId: string;
  /** Version of the subject after this event. */
  version: number;
  data: Record<string, unknown>;
}
