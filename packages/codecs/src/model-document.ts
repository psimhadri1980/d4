import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { Attributes, Element, ImportInput, ModelSnapshot, Relationship } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';

/*
 * Model-as-code document (`apiVersion: d4/v1`, `kind: Model`). Hand-authored files use short
 * `key`s to wire relationships; exported files also carry ids so they round-trip exactly.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD');

export const ElementDoc = z
  .object({
    key: z.string().min(1),
    type: z.string().min(1),
    id: z.string().optional(),
    /** Shorthand for attrs.name. */
    name: z.string().optional(),
    /** Shorthand for attrs.lifecycle. */
    lifecycle: z.string().optional(),
    attrs: z.record(z.unknown()).default({}),
    validFrom: IsoDate.optional(),
    validTo: IsoDate.optional(),
    scenario: z.string().optional(),
  })
  .strict();
export type ElementDoc = z.infer<typeof ElementDoc>;

export const RelationshipDoc = z
  .object({
    type: z.string().min(1),
    /** Element key from this document, or an existing element id. */
    from: z.string().min(1),
    to: z.string().min(1),
    id: z.string().optional(),
    attrs: z.record(z.unknown()).default({}),
    validFrom: IsoDate.optional(),
    validTo: IsoDate.optional(),
    scenario: z.string().optional(),
  })
  .strict();
export type RelationshipDoc = z.infer<typeof RelationshipDoc>;

export const ModelDocument = z
  .object({
    apiVersion: z.literal('d4/v1'),
    kind: z.literal('Model'),
    metadata: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        /** Metamodel the document was written against, e.g. `d4-starter@0.2.0`. */
        metamodel: z.string().optional(),
        disclaimer: z.string().optional(),
        exportedAt: z.string().optional(),
      })
      .strict(),
    elements: z.array(ElementDoc).default([]),
    relationships: z.array(RelationshipDoc).default([]),
  })
  .strict();
export type ModelDocument = z.infer<typeof ModelDocument>;

export class CodecError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(issues.length ? `${message}:\n - ${issues.join('\n - ')}` : message);
    this.name = 'CodecError';
  }
}

/** Parses YAML or JSON text (YAML is a superset, so one parser handles both). */
export function parseModelDocument(text: string): ModelDocument {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new CodecError(`Not valid YAML/JSON: ${(e as Error).message}`);
  }
  return validateModelDocument(raw);
}

export function validateModelDocument(raw: unknown): ModelDocument {
  const parsed = ModelDocument.safeParse(raw);
  if (!parsed.success) {
    throw new CodecError(
      'Invalid model document',
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  return parsed.data;
}

export function stringifyModelDocument(doc: ModelDocument, format: 'yaml' | 'json' = 'yaml'): string {
  return format === 'json' ? `${JSON.stringify(doc, null, 2)}\n` : stringifyYaml(doc, { lineWidth: 0 });
}

/** Converts a document into the import planner's input. */
export function toImportInput(doc: ModelDocument): ImportInput {
  return {
    elements: doc.elements.map((e) => {
      const attrs: Attributes = { ...e.attrs };
      if (e.name !== undefined) attrs['name'] = e.name;
      if (e.lifecycle !== undefined) attrs['lifecycle'] = e.lifecycle;
      return {
        key: e.key,
        type: e.type,
        attrs,
        ...(e.id && { id: e.id }),
        ...(e.validFrom && { validFrom: e.validFrom }),
        ...(e.validTo && { validTo: e.validTo }),
        ...(e.scenario && { scenarioId: e.scenario }),
      };
    }),
    relationships: doc.relationships.map((r) => ({
      type: r.type,
      from: r.from,
      to: r.to,
      attrs: r.attrs,
      ...(r.id && { id: r.id }),
      ...(r.validFrom && { validFrom: r.validFrom }),
      ...(r.validTo && { validTo: r.validTo }),
      ...(r.scenario && { scenarioId: r.scenario }),
    })),
  };
}

const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

/**
 * Builds a deterministic document from a workspace snapshot: elements ordered by layer, type and
 * name; readable keys (`data-product-customer-360`); ids kept for exact round-trips.
 */
export function fromSnapshot(
  reg: MetamodelRegistry,
  snapshot: ModelSnapshot,
  metadata: ModelDocument['metadata'],
): ModelDocument {
  const layerOrder = new Map(reg.metamodel.layers.map((l, i) => [l, i]));
  const rank = (e: Element) => layerOrder.get(reg.nodeType(e.type)?.layer ?? '') ?? 99;
  const name = (e: Element) => String(e.attrs['name'] ?? '');
  const elements = snapshot.elements
    .filter((e) => !e.deleted)
    .sort((a, b) => rank(a) - rank(b) || a.type.localeCompare(b.type) || name(a).localeCompare(name(b)) || a.id.localeCompare(b.id));

  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const e of elements) {
    const base = kebab(`${e.type} ${name(e)}`) || kebab(e.type);
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
    used.add(key);
    keys.set(e.id, key);
  }

  const elementDocs: ElementDoc[] = elements.map((e) => {
    const { name: n, lifecycle, ...rest } = e.attrs;
    return {
      key: keys.get(e.id)!,
      type: e.type,
      id: e.id,
      ...(typeof n === 'string' && { name: n }),
      ...(typeof lifecycle === 'string' && { lifecycle }),
      attrs: rest,
      ...(e.validFrom && { validFrom: e.validFrom }),
      ...(e.validTo && { validTo: e.validTo }),
      ...(e.scenarioId && { scenario: e.scenarioId }),
    };
  });

  const relationships: RelationshipDoc[] = snapshot.relationships
    .filter((r) => !r.deleted && keys.has(r.fromId) && keys.has(r.toId))
    .map((r: Relationship) => ({
      type: r.type,
      from: keys.get(r.fromId)!,
      to: keys.get(r.toId)!,
      id: r.id,
      attrs: r.attrs,
      ...(r.validFrom && { validFrom: r.validFrom }),
      ...(r.validTo && { validTo: r.validTo }),
      ...(r.scenarioId && { scenario: r.scenarioId }),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { apiVersion: 'd4/v1', kind: 'Model', metadata, elements: elementDocs, relationships };
}
