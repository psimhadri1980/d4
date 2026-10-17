import type { MetamodelRegistry } from '@d4/metamodel';
import { diff } from './changes';
import { ulid, ULID_PATTERN } from './ids';
import { canTransition, INITIAL_LIFECYCLE, isLifecycleState } from './lifecycle';
import { systemClock, type ChangeSet, type Clock } from './ports';
import type {
  Attributes,
  CommandContext,
  DomainEvent,
  DomainEventType,
  Element,
  IsoDate,
  Relationship,
  SystemFields,
} from './types';
import { validateModel, type ModelIssue, type ModelSnapshot } from './validate-model';

export interface ImportElement {
  /** Document-local handle used by relationships (`from`/`to`); unique within the import. */
  key: string;
  type: string;
  attrs: Attributes;
  /** Existing or desired ULID. When omitted, matched by externalKey, then by type + name. */
  id?: string;
  validFrom?: IsoDate | null;
  validTo?: IsoDate | null;
  scenarioId?: string | null;
}

export interface ImportRelationship {
  type: string;
  /** Element key from this import, or the id of an element already in the workspace. */
  from: string;
  to: string;
  attrs?: Attributes;
  id?: string;
  validFrom?: IsoDate | null;
  validTo?: IsoDate | null;
  scenarioId?: string | null;
}

export interface ImportInput {
  elements: ImportElement[];
  relationships: ImportRelationship[];
}

export interface ImportCounts {
  created: number;
  updated: number;
  unchanged: number;
}

export interface ImportPlan {
  ok: boolean;
  issues: ModelIssue[];
  elements: ImportCounts;
  relationships: ImportCounts;
  /** Element key → element id (existing or newly assigned). */
  keyToId: Record<string, string>;
  /** Present when ok; apply it with ModelRepository.apply in one unit of work. */
  change?: ChangeSet;
}

export interface PlanImportOptions {
  clock?: Clock;
  newId?: () => string;
}

/**
 * Plans an idempotent import of a whole model into a workspace. Items are matched to existing
 * ones (id → externalKey → type + name for elements; id → type + endpoints + validFrom + scenario
 * for relationships), changes are computed, and the resulting model is validated as a whole.
 * Nothing is deleted: items absent from the import are left alone.
 */
export function planImport(
  reg: MetamodelRegistry,
  ctx: CommandContext,
  input: ImportInput,
  existing: ModelSnapshot,
  opts: PlanImportOptions = {},
): ImportPlan {
  const clock = opts.clock ?? systemClock;
  const now = clock.now().toISOString();
  const newId = opts.newId ?? (() => ulid(clock.now().getTime()));
  const issues: ModelIssue[] = [];
  const counts = () => ({ created: 0, updated: 0, unchanged: 0 });
  const elementCounts = counts();
  const relCounts = counts();

  const liveElements = existing.elements.filter((e) => !e.deleted);
  const liveRels = existing.relationships.filter((r) => !r.deleted);
  const byId = new Map(liveElements.map((e) => [e.id, e]));
  const byExternalKey = groupBy(liveElements.filter((e) => e.attrs['externalKey']), (e) => String(e.attrs['externalKey']));
  const byTypeName = groupBy(liveElements, (e) => `${e.type}|${String(e.attrs['name'] ?? '')}`);

  const changedElements = new Map<string, Element>();
  const changedRels = new Map<string, Relationship>();
  const events: DomainEvent[] = [];
  const keyToId: Record<string, string> = {};

  const event = (type: DomainEventType, subject: SystemFields, data: Record<string, unknown>): DomainEvent => ({
    id: newId(),
    type,
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    occurredAt: now,
    subjectId: subject.id,
    version: subject.version,
    data: { ...data, source: 'import' },
  });
  const system = (id: string, item: { validFrom?: IsoDate | null; validTo?: IsoDate | null; scenarioId?: string | null }): SystemFields => ({
    id,
    workspaceId: ctx.workspaceId,
    version: 1,
    validFrom: item.validFrom ?? null,
    validTo: item.validTo ?? null,
    scenarioId: item.scenarioId ?? null,
    deleted: false,
    createdAt: now,
    createdBy: ctx.actor,
    updatedAt: now,
    updatedBy: ctx.actor,
  });

  // ── Elements ──────────────────────────────────────────────────────────
  for (const item of input.elements) {
    if (keyToId[item.key]) {
      issues.push({ subjectId: item.key, message: `duplicate key '${item.key}'` });
      continue;
    }
    if (!reg.nodeType(item.type)) {
      issues.push({ subjectId: item.key, message: `unknown element type '${item.type}'` });
      continue;
    }
    if (item.id !== undefined && !ULID_PATTERN.test(item.id)) {
      issues.push({ subjectId: item.key, message: `id '${item.id}' is not a ULID` });
      continue;
    }

    const match = findElement(item);
    if (match === 'ambiguous') {
      issues.push({
        subjectId: item.key,
        message: `several existing ${item.type} elements are named '${String(item.attrs['name'])}'; add an id or externalKey`,
      });
      continue;
    }
    if (match && match.type !== item.type) {
      issues.push({ subjectId: item.key, message: `id ${match.id} is a ${match.type}, not a ${item.type}` });
      continue;
    }

    if (!match) {
      const el: Element = {
        ...system(item.id ?? newId(), item),
        type: item.type,
        attrs: { lifecycle: INITIAL_LIFECYCLE, ...item.attrs },
      };
      keyToId[item.key] = el.id;
      changedElements.set(el.id, el);
      elementCounts.created++;
      events.push(
        event('ElementCreated', el, {
          type: el.type,
          attrs: el.attrs,
          validFrom: el.validFrom,
          validTo: el.validTo,
          scenarioId: el.scenarioId,
        }),
      );
      continue;
    }

    keyToId[item.key] = match.id;
    // Attributes not mentioned keep their values; lifecycle defaults to the current one.
    const next: Element = {
      ...match,
      attrs: { ...match.attrs, ...item.attrs },
      validFrom: item.validFrom === undefined ? match.validFrom : item.validFrom,
      validTo: item.validTo === undefined ? match.validTo : item.validTo,
    };
    const changes = diff(match, next);
    if (!Object.keys(changes).length) {
      elementCounts.unchanged++;
      continue;
    }
    const from = match.attrs['lifecycle'];
    const to = next.attrs['lifecycle'];
    if (isLifecycleState(from) && isLifecycleState(to) && !canTransition(from, to)) {
      issues.push({ subjectId: item.key, message: `lifecycle cannot move from ${from} to ${to}` });
      continue;
    }
    const updated = { ...next, version: match.version + 1, updatedAt: now, updatedBy: ctx.actor };
    changedElements.set(updated.id, updated);
    elementCounts.updated++;
    events.push(event('ElementUpdated', updated, { changes }));
  }

  // ── Relationships ─────────────────────────────────────────────────────
  const resolve = (ref: string): string | undefined => keyToId[ref] ?? (byId.has(ref) ? ref : undefined);
  const relById = new Map(liveRels.map((r) => [r.id, r]));
  const relKey = (type: string, fromId: string, toId: string, validFrom: IsoDate | null, scenarioId: string | null) =>
    `${type}|${fromId}|${toId}|${validFrom ?? ''}|${scenarioId ?? ''}`;
  const relByKey = groupBy(liveRels, (r) => relKey(r.type, r.fromId, r.toId, r.validFrom, r.scenarioId));
  const seenRelKeys = new Set<string>();

  input.relationships.forEach((item, i) => {
    const label = `relationships[${i}] ${item.type} ${item.from} → ${item.to}`;
    const fromId = resolve(item.from);
    const toId = resolve(item.to);
    if (!fromId || !toId) {
      issues.push({ subjectId: label, message: `unknown element '${!fromId ? item.from : item.to}'` });
      return;
    }
    if (!reg.relationshipType(item.type)) {
      issues.push({ subjectId: label, message: `unknown relationship type '${item.type}'` });
      return;
    }
    const validFrom = item.validFrom ?? null;
    const scenarioId = item.scenarioId ?? null;
    const key = relKey(item.type, fromId, toId, validFrom, scenarioId);
    if (seenRelKeys.has(key)) {
      issues.push({ subjectId: label, message: 'duplicate relationship in import' });
      return;
    }
    seenRelKeys.add(key);

    const candidates = item.id ? [relById.get(item.id)].filter(Boolean) : (relByKey.get(key) ?? []);
    if (candidates.length > 1) {
      issues.push({ subjectId: label, message: 'several existing relationships match; add an id' });
      return;
    }
    const match = candidates[0] as Relationship | undefined;
    if (match && (match.type !== item.type || match.fromId !== fromId || match.toId !== toId)) {
      issues.push({ subjectId: label, message: `id ${match.id} has different type or endpoints` });
      return;
    }

    if (!match) {
      if (item.id !== undefined && !ULID_PATTERN.test(item.id)) {
        issues.push({ subjectId: label, message: `id '${item.id}' is not a ULID` });
        return;
      }
      const rel: Relationship = {
        ...system(item.id ?? newId(), item),
        type: item.type,
        fromId,
        toId,
        attrs: { ...item.attrs },
      };
      changedRels.set(rel.id, rel);
      relCounts.created++;
      events.push(
        event('RelationshipCreated', rel, {
          type: rel.type,
          fromId,
          toId,
          attrs: rel.attrs,
          validFrom: rel.validFrom,
          validTo: rel.validTo,
          scenarioId: rel.scenarioId,
        }),
      );
      return;
    }

    const next: Relationship = {
      ...match,
      attrs: { ...match.attrs, ...item.attrs },
      validTo: item.validTo === undefined ? match.validTo : item.validTo,
    };
    const changes = diff(match, next);
    if (!Object.keys(changes).length) {
      relCounts.unchanged++;
      return;
    }
    const updated = { ...next, version: match.version + 1, updatedAt: now, updatedBy: ctx.actor };
    changedRels.set(updated.id, updated);
    relCounts.updated++;
    events.push(event('RelationshipUpdated', updated, { changes }));
  });

  // ── Validate the model as it would be after the import ────────────────
  const merged: ModelSnapshot = {
    elements: [...liveElements.filter((e) => !changedElements.has(e.id)), ...changedElements.values()],
    relationships: [...liveRels.filter((r) => !changedRels.has(r.id)), ...changedRels.values()],
  };
  const touched = new Set([...changedElements.keys(), ...changedRels.keys()]);
  const idToKey = new Map(Object.entries(keyToId).map(([k, id]) => [id, k]));
  for (const issue of validateModel(reg, merged)) {
    // Report problems the import causes or touches; pre-existing ones are not the import's fault,
    // except rule violations, which may involve new and old items together.
    if (touched.has(issue.subjectId) || issue.ruleId) {
      issues.push({ ...issue, subjectId: idToKey.get(issue.subjectId) ?? issue.subjectId });
    }
  }

  const ok = issues.length === 0;
  return {
    ok,
    issues,
    elements: elementCounts,
    relationships: relCounts,
    keyToId,
    ...(ok && {
      change: { elements: [...changedElements.values()], relationships: [...changedRels.values()], events },
    }),
  };

  function findElement(item: ImportElement): Element | 'ambiguous' | undefined {
    if (item.id) return byId.get(item.id);
    const ext = item.attrs['externalKey'];
    if (typeof ext === 'string') {
      const hits = byExternalKey.get(ext) ?? [];
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) return 'ambiguous';
    }
    const hits = byTypeName.get(`${item.type}|${String(item.attrs['name'] ?? '')}`) ?? [];
    if (hits.length > 1) return 'ambiguous';
    return hits[0];
  }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of items) {
    const k = key(t);
    m.set(k, [...(m.get(k) ?? []), t]);
  }
  return m;
}
