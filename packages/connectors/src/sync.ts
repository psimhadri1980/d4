import type { Element, ImportInput, ImportRelationship, ModelSnapshot } from '@d4/core';
import type { MappedItem, MappingResult } from './mapping';

/** What the previous sync recorded for one source item. */
export interface SyncedItem {
  externalKey: string;
  elementId: string;
  syncedVersion: number;
  sourceHash: string;
}

export type ConflictPolicy = 'skip' | 'source-wins';

export interface SyncPlan {
  /** Hand this to planImport. */
  input: ImportInput;
  /** Items left out because nothing changed in the source since the last sync. */
  unchanged: string[];
  /** Changed in D4 and in the source since the last sync; skipped unless the policy is source-wins. */
  conflicts: { externalKey: string; elementId: string; name: string; applied: boolean }[];
  /** Synced before, then deleted in D4: not recreated. */
  deletedInD4: string[];
  /** Synced before, no longer in the source: reported, never deleted. */
  missingInSource: { externalKey: string; elementId: string }[];
  /** Relationships whose other end is neither in this sync nor in the workspace. */
  unresolved: { from: string; to: string; type: string }[];
  /** Included items (by external key) with the source hash to record after applying. */
  included: MappedItem[];
}

/**
 * Decides, item by item, what a sync writes. The connector owns what it brought in, but a person's
 * later edit is not silently overwritten: an item changed both in D4 and in the source since the
 * last sync is a conflict, skipped (and reported) unless the connector says the source wins.
 */
export function planSync(mapped: MappingResult, snapshot: ModelSnapshot, previous: SyncedItem[], policy: ConflictPolicy): SyncPlan {
  const live = snapshot.elements.filter((e) => !e.deleted);
  const byExternalKey = new Map<string, Element>();
  for (const e of live) if (typeof e.attrs['externalKey'] === 'string') byExternalKey.set(e.attrs['externalKey'], e);
  const deleted = new Set(snapshot.elements.filter((e) => e.deleted).map((e) => e.id));
  const prev = new Map(previous.map((p) => [p.externalKey, p]));

  const plan: SyncPlan = { input: { elements: [], relationships: [] }, unchanged: [], conflicts: [], deletedInD4: [], missingInSource: [], unresolved: [], included: [] };
  /** External keys that resolve to an element without being in the import. */
  const outside = new Map<string, string>();

  for (const item of mapped.items) {
    const before = prev.get(item.externalKey);
    const current = byExternalKey.get(item.externalKey);
    if (before && !current && deleted.has(before.elementId)) {
      plan.deletedInD4.push(item.externalKey);
      continue;
    }
    if (before && current && current.id === before.elementId) {
      const sourceChanged = item.hash !== before.sourceHash;
      const d4Changed = current.version > before.syncedVersion;
      if (!sourceChanged) {
        plan.unchanged.push(item.externalKey);
        outside.set(item.externalKey, current.id);
        continue;
      }
      if (d4Changed) {
        const applied = policy === 'source-wins';
        plan.conflicts.push({ externalKey: item.externalKey, elementId: current.id, name: String(current.attrs['name'] ?? current.id), applied });
        if (!applied) {
          outside.set(item.externalKey, current.id);
          continue;
        }
      }
    }
    plan.included.push(item);
    plan.input.elements.push(item.element);
  }

  const inImport = new Set(plan.input.elements.map((e) => e.key));
  const liveIds = new Set(live.map((e) => e.id));
  // An end is an element of this sync, one it owns already, any element by external key, or an existing element id.
  const end = (key: string) => (inImport.has(key) ? key : (outside.get(key) ?? byExternalKey.get(key)?.id ?? (liveIds.has(key) ? key : undefined)));
  for (const r of mapped.relationships) {
    const from = end(r.from);
    const to = end(r.to);
    if (!from || !to) {
      // An end deleted in D4 just drops the relationship; anything else is worth reporting.
      if (!plan.deletedInD4.includes(r.from) && !plan.deletedInD4.includes(r.to)) plan.unresolved.push({ from: r.from, to: r.to, type: r.type });
      continue;
    }
    plan.input.relationships.push({ ...r, from, to } satisfies ImportRelationship);
  }

  const inSource = new Set(mapped.items.map((i) => i.externalKey));
  for (const p of previous) {
    if (!inSource.has(p.externalKey) && !deleted.has(p.elementId)) plan.missingInSource.push({ externalKey: p.externalKey, elementId: p.elementId });
  }
  return plan;
}
