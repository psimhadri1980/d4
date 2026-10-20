import { createHash } from 'node:crypto';
import type { Attributes, ImportElement, ImportInput, ImportRelationship } from '@d4/core';
import { z } from 'zod';

/**
 * A path into a source record: dotted keys with numeric indexes (`ci.owner.name`, `tags[0]`).
 * The empty path is the record itself.
 */
const Path = z.string().max(200).regex(/^(|[A-Za-z0-9_$@-]+(\[\d+\])*(\.[A-Za-z0-9_$@-]+(\[\d+\])*)*)$/, 'a dotted path such as owner.name or tags[0]');

/** A fixed value, or one read from the record (optionally translated through `map`). */
const Value = z.union([
  z.object({ value: z.union([z.string(), z.number(), z.boolean()]) }).strict(),
  z.object({ path: Path, map: z.record(z.string()).optional() }).strict(),
]);

const RelationshipMapping = z
  .object({
    type: z.string().min(1),
    /** Source id(s) of the other end; an array value makes one relationship per entry. */
    to: Path,
    /** Connector key that owns the other end, when it is not this connector. */
    toConnector: z.string().optional(),
    /** `out`: this element → the other end (default); `in`: the other end → this element. */
    direction: z.enum(['out', 'in']).default('out'),
    attrs: z.record(Value).default({}),
  })
  .strict();

const EntityMapping = z
  .object({
    /** Only records where `path` equals `equals` (as text) become this kind of element. */
    when: z.object({ path: Path, equals: z.union([z.string(), z.number(), z.boolean()]) }).strict().optional(),
    type: Value,
    /** The record's stable id in the source; becomes the external key `<connector key>:<id>`. */
    id: Path,
    name: Path,
    attrs: z.record(Value).default({}),
    relationships: z.array(RelationshipMapping).default([]),
  })
  .strict();

export const Mapping = z
  .object({
    /** Where the records are in the response (empty: the response is the array). */
    itemsPath: Path.default(''),
    entities: z.array(EntityMapping).min(1).max(20),
  })
  .strict();
export type Mapping = z.infer<typeof Mapping>;

export function get(record: unknown, path: string): unknown {
  if (path === '') return record;
  let cur: unknown = record;
  for (const part of path.split('.')) {
    const m = /^([^[]+)((?:\[\d+\])*)$/.exec(part)!;
    cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[m[1]!] : undefined;
    for (const idx of m[2]!.match(/\d+/g) ?? []) cur = Array.isArray(cur) ? cur[Number(idx)] : undefined;
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

function resolve(record: unknown, v: z.infer<typeof Value>): unknown {
  if ('value' in v) return v.value;
  const raw = get(record, v.path);
  if (raw === undefined || raw === null || raw === '') return undefined;
  return v.map ? (v.map[String(raw)] ?? undefined) : raw;
}

/** Plain JSON values only: nested objects become their JSON text, arrays of scalars stay arrays. */
function attrValue(v: unknown): Attributes[string] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v as Attributes[string];
  return JSON.stringify(v);
}

export interface MappedItem {
  externalKey: string;
  element: ImportElement;
  /** Hash of the mapped values (not the raw record), so irrelevant source changes are ignored. */
  hash: string;
}

export interface MappingResult {
  items: MappedItem[];
  relationships: ImportRelationship[];
  /** Records that could not be mapped, with why (missing id, unknown type value, duplicates). */
  problems: { record: number; message: string }[];
}

/**
 * Turns source records into import elements and relationships. Element keys are the external
 * keys, so relationships between records of this connector resolve inside the import; ends owned
 * by another connector (or already in the workspace) are resolved by the caller.
 */
export function mapRecords(connectorKey: string, mapping: Mapping, records: unknown[]): MappingResult {
  const items = new Map<string, MappedItem>();
  const relationships: ImportRelationship[] = [];
  const problems: MappingResult['problems'] = [];

  records.forEach((record, index) => {
    for (const e of mapping.entities) {
      if (e.when && String(get(record, e.when.path)) !== String(e.when.equals)) continue;
      const id = get(record, e.id);
      const name = get(record, e.name);
      const type = resolve(record, e.type);
      if (id === undefined || id === null || id === '') {
        problems.push({ record: index, message: `no id at '${e.id}'` });
        continue;
      }
      if (typeof type !== 'string') {
        problems.push({ record: index, message: `no element type for id ${String(id)}` });
        continue;
      }
      const externalKey = `${connectorKey}:${String(id)}`;
      if (items.has(externalKey)) {
        problems.push({ record: index, message: `duplicate id ${String(id)}` });
        continue;
      }
      const attrs: Attributes = { name: String(name ?? id), externalKey };
      for (const [k, v] of Object.entries(e.attrs)) {
        const value = attrValue(resolve(record, v));
        if (value !== undefined) attrs[k] = value;
      }
      const element: ImportElement = { key: externalKey, type, attrs };
      items.set(externalKey, { externalKey, element, hash: hash({ type, attrs }) });

      for (const r of e.relationships) {
        const ends = get(record, r.to);
        for (const end of Array.isArray(ends) ? ends : ends === undefined || ends === null || ends === '' ? [] : [ends]) {
          const other = `${r.toConnector ?? connectorKey}:${String(end)}`;
          const attrsR: Attributes = {};
          for (const [k, v] of Object.entries(r.attrs)) {
            const value = attrValue(resolve(record, v));
            if (value !== undefined) attrsR[k] = value;
          }
          relationships.push({
            type: r.type,
            from: r.direction === 'out' ? externalKey : other,
            to: r.direction === 'out' ? other : externalKey,
            ...(Object.keys(attrsR).length && { attrs: attrsR }),
          });
        }
      }
    }
  });
  return { items: [...items.values()], relationships, problems };
}

/** JSON with object keys sorted at every level, so equal values always hash the same. */
const stable = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(stable).join(',')}]`
    : v && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const hash = (v: unknown) => createHash('sha256').update(stable(v)).digest('hex').slice(0, 32);

/** The import input for one sync (elements chosen by the caller, all relationships). */
export const toImportInput = (items: MappedItem[], relationships: ImportRelationship[]): ImportInput => ({
  elements: items.map((i) => i.element),
  relationships,
});
