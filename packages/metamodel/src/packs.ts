import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { checkReferences, loadStarterMetamodel, MetamodelError } from './load';
import { AttributeDef, Metamodel, NodeTypeDef, RelationshipTypeDef, RuleDef } from './schema';

/**
 * An industry pack: additions to the starter metamodel. Composing it gives a complete metamodel
 * with the pack's id and version, validated like any other.
 */
export const MetamodelPack = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]+$/),
    version: z.string(),
    extends: z.literal('d4-starter'),
    description: z.string(),
    layers: z.array(z.string()).default([]),
    enums: z.record(z.array(z.string()).min(1)).default({}),
    commonAttributes: z.array(AttributeDef).default([]),
    nodeTypes: z.array(NodeTypeDef).default([]),
    relationshipTypes: z.array(RelationshipTypeDef).default([]),
    /** More endpoints for starter relationship types (e.g. let OWNS point at a pack type). */
    extendRelationships: z.array(z.object({ name: z.string(), from: z.array(z.string()).default([]), to: z.array(z.string()).default([]) }).strict()).default([]),
    rules: z.array(RuleDef).default([]),
  })
  .strict();
export type MetamodelPack = z.infer<typeof MetamodelPack>;

/**
 * Starter + pack → one metamodel. A pack may add but never redefine: a type, enum or relationship
 * the starter already has is an error, so a pack can never change what starter types mean.
 */
export function composePack(base: Metamodel, pack: MetamodelPack): Metamodel {
  const issues: string[] = [];
  const clash = (what: string, names: string[], existing: Set<string>) => {
    for (const n of names) if (existing.has(n)) issues.push(`${pack.id}: ${what} '${n}' already exists in ${base.id}`);
  };
  clash('enum', Object.keys(pack.enums), new Set(Object.keys(base.enums)));
  clash('node type', pack.nodeTypes.map((n) => n.name), new Set(base.nodeTypes.map((n) => n.name)));
  clash('relationship type', pack.relationshipTypes.map((r) => r.name), new Set(base.relationshipTypes.map((r) => r.name)));
  clash('rule', pack.rules.map((r) => r.id), new Set(base.rules.map((r) => r.id)));
  clash('common attribute', pack.commonAttributes.map((a) => a.name), new Set(base.commonAttributes.map((a) => a.name)));

  const relationshipTypes = base.relationshipTypes.map((r) => {
    const ext = pack.extendRelationships.filter((e) => e.name === r.name);
    if (!ext.length) return r;
    const add = (ends: string[], more: string[]) => (ends.includes('*') ? ends : [...new Set([...ends, ...more])]);
    return { ...r, from: add(r.from, ext.flatMap((e) => e.from)), to: add(r.to, ext.flatMap((e) => e.to)) };
  });
  for (const e of pack.extendRelationships) {
    if (!base.relationshipTypes.some((r) => r.name === e.name)) issues.push(`${pack.id}: extendRelationships names unknown '${e.name}'`);
  }
  if (issues.length) throw new MetamodelError(issues);

  const composed = Metamodel.parse({
    id: pack.id,
    version: pack.version,
    description: pack.description,
    layers: [...base.layers, ...pack.layers.filter((l) => !base.layers.includes(l))],
    enums: { ...base.enums, ...pack.enums },
    commonAttributes: [...base.commonAttributes, ...pack.commonAttributes],
    nodeTypes: [...base.nodeTypes, ...pack.nodeTypes],
    relationshipTypes: [...relationshipTypes, ...pack.relationshipTypes],
    rules: [...base.rules, ...pack.rules],
  });
  const refs = checkReferences(composed);
  if (refs.length) throw new MetamodelError(refs.map((i) => `${pack.id}: ${i}`));
  return composed;
}

export function parsePack(text: string): MetamodelPack {
  const parsed = MetamodelPack.safeParse(parse(text));
  if (!parsed.success) throw new MetamodelError(parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`));
  return parsed.data;
}

/** The metamodels a workspace can start from: the starter, and each industry pack composed on it. */
export const METAMODEL_PACKS = ['d4-starter', 'd4-banking', 'd4-insurance'] as const;
export type MetamodelPackId = (typeof METAMODEL_PACKS)[number];

const PACK_FILES: Record<Exclude<MetamodelPackId, 'd4-starter'>, string> = { 'd4-banking': 'banking.yaml', 'd4-insurance': 'insurance.yaml' };

export function loadMetamodelPack(id: MetamodelPackId): Metamodel {
  const starter = loadStarterMetamodel();
  if (id === 'd4-starter') return starter;
  return composePack(starter, parsePack(readFileSync(join(__dirname, '..', 'packs', PACK_FILES[id]), 'utf8')));
}

/** Summary for pickers: id, version, description and how many types it adds over the starter. */
export function describeMetamodelPacks() {
  const starter = loadStarterMetamodel();
  return METAMODEL_PACKS.map((id) => {
    const mm = loadMetamodelPack(id);
    return {
      id,
      version: mm.version,
      description: mm.description ?? '',
      addedNodeTypes: mm.nodeTypes.length - starter.nodeTypes.length,
      addedRelationshipTypes: mm.relationshipTypes.length - starter.relationshipTypes.length,
    };
  });
}
