import type { Element, IsoDate, Relationship, SystemFields } from './types';
import type { ModelSnapshot } from './validate-model';

/**
 * Which state of the model to look at.
 * - `asOf`: only items valid on that date (half-open validity periods); null = ignore validity.
 * - `scenarioId`: the baseline plus that scenario's items; null = baseline only.
 * Scenarios overlay the baseline. Elements are additive. For relationships, a scenario that has
 * any relationship of a type between two elements replaces the baseline's relationships of that
 * type between them, so a scenario can re-date a hand-over (e.g. end the legacy master earlier and
 * start the new one earlier) without editing the baseline.
 */
export interface ModelView {
  asOf?: IsoDate | null;
  scenarioId?: string | null;
}

export const BASELINE: ModelView = { asOf: null, scenarioId: null };

export function visibleIn(item: Pick<SystemFields, 'validFrom' | 'validTo' | 'scenarioId' | 'deleted'>, view: ModelView = {}): boolean {
  if (item.deleted) return false;
  if (item.scenarioId !== null && item.scenarioId !== (view.scenarioId ?? null)) return false;
  const d = view.asOf;
  if (!d) return true;
  return (item.validFrom === null || item.validFrom <= d) && (item.validTo === null || d < item.validTo);
}

const relKey = (r: Relationship) => `${r.type}|${r.fromId}|${r.toId}`;

/** The snapshot as seen in a view; relationships also need both ends visible. */
export function applyView(s: ModelSnapshot, view: ModelView = {}): ModelSnapshot {
  const elements = s.elements.filter((e) => visibleIn(e, view));
  const ids = new Set(elements.map((e) => e.id));
  // Pairs the scenario redefines, whatever the dates: its own periods decide what is visible.
  const overridden = new Set(
    view.scenarioId ? s.relationships.filter((r) => !r.deleted && r.scenarioId === view.scenarioId).map(relKey) : [],
  );
  return {
    elements,
    relationships: s.relationships.filter(
      (r) =>
        visibleIn(r, view) &&
        ids.has(r.fromId) &&
        ids.has(r.toId) &&
        !(r.scenarioId === null && overridden.has(relKey(r))),
    ),
  };
}

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface Changed<T> {
  before: T;
  after: T;
  fields: FieldChange[];
}

export interface ModelDiff {
  elements: { added: Element[]; removed: Element[] };
  /**
   * `changed` pairs a relationship that disappears with one of the same type between the same
   * two elements that appears, e.g. a store going from MASTER to REPLICA for a data product.
   */
  relationships: { added: Relationship[]; removed: Relationship[]; changed: Changed<Relationship>[] };
}

const same = (x: unknown, y: unknown) => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);

/** Attributes plus validity are compared; bookkeeping fields (version, timestamps) are not. */
function fieldChanges(a: Relationship, b: Relationship): FieldChange[] {
  const out: FieldChange[] = [];
  for (const k of [...new Set([...Object.keys(a.attrs), ...Object.keys(b.attrs)])].sort()) {
    if (!same(a.attrs[k], b.attrs[k])) out.push({ field: k, before: a.attrs[k] ?? null, after: b.attrs[k] ?? null });
  }
  for (const k of ['validFrom', 'validTo', 'scenarioId'] as const) {
    if (!same(a[k], b[k])) out.push({ field: k, before: a[k], after: b[k] });
  }
  return out;
}

const label = (x: Element | Relationship) => String(x.attrs['name'] ?? x.type);
const byLabel = (x: Element | Relationship, y: Element | Relationship) => label(x).localeCompare(label(y)) || x.id.localeCompare(y.id);

/**
 * Differences between two views of the same model, e.g. today vs. a year ahead, or the baseline
 * vs. a scenario. Items are matched by id; replaced relationships are paired as changes.
 */
export function diffModels(snapshot: ModelSnapshot, from: ModelView, to: ModelView): ModelDiff {
  const a = applyView(snapshot, from);
  const b = applyView(snapshot, to);
  const inA = new Set(a.elements.map((e) => e.id));
  const inB = new Set(b.elements.map((e) => e.id));
  const relA = new Set(a.relationships.map((r) => r.id));
  const relB = new Set(b.relationships.map((r) => r.id));

  const gone = a.relationships.filter((r) => !relB.has(r.id));
  const added = b.relationships.filter((r) => !relA.has(r.id));
  const key = relKey;
  const changed: Changed<Relationship>[] = [];
  const unmatched = new Map<string, Relationship[]>();
  for (const r of added) unmatched.set(key(r), [...(unmatched.get(key(r)) ?? []), r]);
  const removed: Relationship[] = [];
  for (const r of gone) {
    const partner = unmatched.get(key(r))?.shift();
    if (partner) changed.push({ before: r, after: partner, fields: fieldChanges(r, partner) });
    else removed.push(r);
  }
  return {
    elements: {
      added: b.elements.filter((e) => !inA.has(e.id)).sort(byLabel),
      removed: a.elements.filter((e) => !inB.has(e.id)).sort(byLabel),
    },
    relationships: {
      added: [...unmatched.values()].flat().sort(byLabel),
      removed: removed.sort(byLabel),
      changed,
    },
  };
}
