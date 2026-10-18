import type { DomainEvent, Element, Relationship } from './types';

/** Read access the domain needs. Implemented by the Neo4j adapter and the in-memory repository. */
export interface ModelReader {
  /** Returns soft-deleted items too; callers decide how to treat them. */
  getElement(workspaceId: string, id: string): Promise<Element | undefined>;
  getRelationship(workspaceId: string, id: string): Promise<Relationship | undefined>;
  /** Live (not deleted) relationships touching the element in either direction. */
  relationshipsOf(workspaceId: string, elementId: string): Promise<Relationship[]>;
  /** Live relationships of a type that point at the target. */
  relationshipsTo(workspaceId: string, type: string, toId: string): Promise<Relationship[]>;
  /** Live elements and relationships that belong to a scenario (their `scenarioId`). */
  scenarioItems(workspaceId: string, scenarioId: string): Promise<{ elements: Element[]; relationships: Relationship[] }>;
  /** Is there a directed path of live `type` relationships from `fromId` to `toId`? */
  pathExists(workspaceId: string, type: string, fromId: string, toId: string): Promise<boolean>;
}

/**
 * The state changes and events produced by one command. Adapters must apply them atomically,
 * persist the events to the log, and reject the change if any item's stored version is not
 * `version - 1` (protects against races between validation and write).
 */
export interface ChangeSet {
  elements: Element[];
  relationships: Relationship[];
  events: DomainEvent[];
}

export interface ModelWriter {
  apply(workspaceId: string, change: ChangeSet): Promise<void>;
}

export interface ModelRepository extends ModelReader, ModelWriter {}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
