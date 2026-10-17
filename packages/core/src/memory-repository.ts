import { DomainError } from './errors';
import type { ChangeSet, ModelRepository } from './ports';
import type { DomainEvent, Element, Relationship, SystemFields } from './types';

/**
 * Reference ModelRepository held in memory. Used by tests, the CLI's offline validation and as
 * the behavioural spec for the Neo4j adapter.
 */
export class InMemoryModelRepository implements ModelRepository {
  readonly elements = new Map<string, Element>();
  readonly relationships = new Map<string, Relationship>();
  readonly events: DomainEvent[] = [];

  async getElement(ws: string, id: string) {
    const el = this.elements.get(id);
    return el?.workspaceId === ws ? el : undefined;
  }

  async getRelationship(ws: string, id: string) {
    const rel = this.relationships.get(id);
    return rel?.workspaceId === ws ? rel : undefined;
  }

  async relationshipsOf(ws: string, elementId: string) {
    return this.live(ws).filter((r) => r.fromId === elementId || r.toId === elementId);
  }

  async relationshipsTo(ws: string, type: string, toId: string) {
    return this.live(ws).filter((r) => r.type === type && r.toId === toId);
  }

  async pathExists(ws: string, type: string, fromId: string, toId: string) {
    const next = new Map<string, string[]>();
    for (const r of this.live(ws)) {
      if (r.type === type) next.set(r.fromId, [...(next.get(r.fromId) ?? []), r.toId]);
    }
    const seen = new Set([fromId]);
    const queue = [fromId];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      if (cur === toId) return true;
      for (const n of next.get(cur) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return false;
  }

  async apply(ws: string, change: ChangeSet) {
    // Same contract the database adapter enforces: all-or-nothing, version must advance by one.
    const check = (store: Map<string, SystemFields>, item: SystemFields) => {
      if (item.workspaceId !== ws) throw new Error(`item ${item.id} is not in workspace ${ws}`);
      const stored = store.get(item.id)?.version ?? 0;
      if (stored !== item.version - 1) {
        throw new DomainError('VERSION_CONFLICT', `'${item.id}' changed concurrently`);
      }
    };
    change.elements.forEach((e) => check(this.elements, e));
    change.relationships.forEach((r) => check(this.relationships, r));
    change.elements.forEach((e) => this.elements.set(e.id, e));
    change.relationships.forEach((r) => this.relationships.set(r.id, r));
    this.events.push(...change.events);
  }

  private live(ws: string): Relationship[] {
    return [...this.relationships.values()].filter((r) => r.workspaceId === ws && !r.deleted);
  }
}
