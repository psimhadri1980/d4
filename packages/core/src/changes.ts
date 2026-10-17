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
