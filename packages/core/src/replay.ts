import type { Attributes, DomainEventType, Element, IsoDate, Relationship } from './types';

/** The fields of a stored event that replay needs. */
export interface ReplayEvent {
  type: DomainEventType | string;
  workspaceId: string;
  subjectId: string;
  version: number;
  actor: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface ModelState {
  elements: Map<string, Element>;
  relationships: Map<string, Relationship>;
}

export interface ReplayResult extends ModelState {
  /** Events applied, and events skipped because the state already had them (or a later version). */
  applied: number;
  skipped: number;
  /** Events that could not be applied: a gap in versions, or a change to an unknown item. */
  problems: string[];
}

export const emptyState = (): ModelState => ({ elements: new Map(), relationships: new Map() });

/**
 * Rebuilds model state from the event log, on top of `start` (empty, or a snapshot). An event is
 * applied only when it is the next version of its item, so replaying events the start state
 * already includes is harmless: a snapshot taken while writes were happening, followed by every
 * event from the position recorded when it started, converges on the same state as a full replay.
 */
export function replayEvents(start: ModelState, events: Iterable<ReplayEvent>): ReplayResult {
  const elements = new Map(start.elements);
  const relationships = new Map(start.relationships);
  let applied = 0;
  let skipped = 0;
  const problems: string[] = [];

  for (const e of events) {
    const isElement = e.type.startsWith('Element');
    const store = (isElement ? elements : relationships) as Map<string, Element | Relationship>;
    const current = store.get(e.subjectId);
    const have = current?.version ?? 0;
    if (e.version <= have) {
      skipped++;
      continue;
    }
    if (e.version !== have + 1) {
      problems.push(`${e.type} ${e.subjectId} v${e.version}: expected v${have + 1}`);
      continue;
    }
    const stamp = { version: e.version, updatedAt: e.occurredAt, updatedBy: e.actor };
    const d = e.data;
    switch (e.type) {
      case 'ElementCreated':
      case 'RelationshipCreated': {
        const base = {
          id: e.subjectId,
          workspaceId: e.workspaceId,
          type: String(d['type']),
          attrs: { ...((d['attrs'] as Attributes | undefined) ?? {}) },
          validFrom: (d['validFrom'] as IsoDate | null | undefined) ?? null,
          validTo: (d['validTo'] as IsoDate | null | undefined) ?? null,
          scenarioId: (d['scenarioId'] as string | null | undefined) ?? null,
          deleted: false,
          createdAt: e.occurredAt,
          createdBy: e.actor,
          ...stamp,
        };
        store.set(e.subjectId, isElement ? base : { ...base, fromId: String(d['fromId']), toId: String(d['toId']) });
        break;
      }
      case 'ElementUpdated':
      case 'RelationshipUpdated': {
        if (!current) {
          problems.push(`${e.type} ${e.subjectId}: unknown item`);
          continue;
        }
        const next = { ...current, attrs: { ...current.attrs }, ...stamp };
        for (const [field, change] of Object.entries((d['changes'] as Record<string, { to: unknown }> | undefined) ?? {})) {
          if (field.startsWith('attrs.')) {
            const key = field.slice(6);
            if (change.to === null || change.to === undefined) delete next.attrs[key];
            else next.attrs[key] = change.to as Attributes[string];
          } else if (field === 'validFrom' || field === 'validTo') {
            next[field] = (change.to as IsoDate | null) ?? null;
          }
        }
        store.set(e.subjectId, next);
        break;
      }
      case 'ElementDeleted':
      case 'RelationshipDeleted': {
        if (!current) {
          problems.push(`${e.type} ${e.subjectId}: unknown item`);
          continue;
        }
        store.set(e.subjectId, { ...current, deleted: true, ...stamp });
        break;
      }
      default:
        problems.push(`${e.type} ${e.subjectId}: unknown event type`);
        continue;
    }
    applied++;
  }
  return { elements, relationships, applied, skipped, problems };
}

/** What two states disagree on, item by item (timestamps are not compared). */
export function compareStates(expected: ModelState, actual: ModelState, limit = 50): { differences: string[]; count: number } {
  const differences: string[] = [];
  let count = 0;
  const note = (s: string) => {
    count++;
    if (differences.length < limit) differences.push(s);
  };
  const check = <T extends Element | Relationship>(kind: string, a: Map<string, T>, b: Map<string, T>) => {
    for (const [id, x] of a) {
      const y = b.get(id);
      if (!y) note(`${kind} ${id} (${x.type}) is missing from the graph`);
      else if (canonical(x) !== canonical(y)) note(`${kind} ${id} (${x.type}) differs: event log v${x.version}${x.deleted ? ' deleted' : ''}, graph v${y.version}${y.deleted ? ' deleted' : ''}`);
    }
    for (const [id, y] of b) if (!a.has(id)) note(`${kind} ${id} (${y.type}) is in the graph but not in the event log`);
  };
  check('element', expected.elements, actual.elements);
  check('relationship', expected.relationships, actual.relationships);
  return { differences, count };
}

/**
 * A stable text form of an item for checksums and comparisons: identity, type, version, state,
 * validity, scenario, ends and attributes (keys sorted). Timestamps are left out.
 */
export function canonical(x: Element | Relationship): string {
  const attrs = Object.fromEntries(Object.entries(x.attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const ends = 'fromId' in x ? [x.fromId, x.toId] : [];
  return JSON.stringify([x.id, x.workspaceId, x.type, x.version, x.deleted, x.validFrom, x.validTo, x.scenarioId, ...ends, attrs]);
}
