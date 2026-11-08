import type { Attributes, IsoDate } from './types';

export function applyAttrChanges(
  current: Attributes,
  input: { set?: Attributes; unset?: string[] },
): Attributes {
  const next: Attributes = { ...current, ...input.set };
  for (const k of input.unset ?? []) delete next[k];
  return next;
}

type Diffable = { attrs: Attributes; validFrom: IsoDate | null; validTo: IsoDate | null };

/** Field-level changes as `{ field: { from, to } }`; attributes are prefixed with `attrs.`. */
export function diff(a: Diffable, b: Diffable): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])) {
    if (JSON.stringify(a.attrs[k]) !== JSON.stringify(b.attrs[k])) {
      out[`attrs.${k}`] = { from: a.attrs[k] ?? null, to: b.attrs[k] ?? null };
    }
  }
  for (const k of ['validFrom', 'validTo'] as const) {
    if (a[k] !== b[k]) out[k] = { from: a[k], to: b[k] };
  }
  return out;
}

/** How an item changed after an instant (D98): the fields changed, by the last person, when. */
export interface ItemChange {
  id: string;
  change: 'added' | 'changed' | 'removed';
  /** Changed fields, attributes without their `attrs.` prefix; empty for added and removed. */
  fields: string[];
  by: string;
  at: string;
}

/**
 * Folds the events after an instant into one change per item, in the order the items first
 * changed: created then is `added`, deleted is `removed`, anything else `changed`. An item both
 * created and deleted after the instant was never there at either end, so it is left out.
 */
export function changesSince(events: Iterable<{ type: string; subjectId: string; actor: string; occurredAt: string; data: Record<string, unknown> }>): ItemChange[] {
  const out = new Map<string, ItemChange & { created: boolean }>();
  for (const e of events) {
    const c = out.get(e.subjectId) ?? { id: e.subjectId, change: 'changed' as const, fields: [], by: e.actor, at: e.occurredAt, created: false };
    c.by = e.actor;
    c.at = e.occurredAt;
    if (e.type.endsWith('Created')) {
      c.created = true;
      c.change = 'added';
    } else if (e.type.endsWith('Deleted')) {
      c.change = 'removed';
    } else if (!c.created) {
      for (const f of Object.keys((e.data['changes'] as Record<string, unknown> | undefined) ?? {})) {
        const name = f.startsWith('attrs.') ? f.slice(6) : f;
        if (!c.fields.includes(name)) c.fields.push(name);
      }
    }
    out.set(e.subjectId, c);
  }
  return [...out.values()]
    .filter((c) => !(c.created && c.change === 'removed'))
    .map((c) => ({ id: c.id, change: c.change, fields: c.change === 'changed' ? c.fields : [], by: c.by, at: c.at }));
}
