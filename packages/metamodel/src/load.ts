import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { Metamodel, type AttributeDef } from './schema';

/**
 * Property names the platform stores on every node and relationship. Metamodel attributes are
 * stored as sibling properties, so they must not reuse these.
 */
export const RESERVED_ATTRIBUTE_NAMES = new Set([
  'id',
  'type',
  'workspaceId',
  'version',
  'validFrom',
  'validTo',
  'scenarioId',
  'deleted',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
]);

export class MetamodelError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid metamodel:\n - ${issues.join('\n - ')}`);
  }
}

/** Parse and fully validate a metamodel document (YAML or JSON text). */
export function parseMetamodel(text: string): Metamodel {
  const parsed = Metamodel.safeParse(parse(text));
  if (!parsed.success) {
    throw new MetamodelError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    );
  }
  const issues = checkReferences(parsed.data);
  if (issues.length) throw new MetamodelError(issues);
  return parsed.data;
}

export function loadStarterMetamodel(): Metamodel {
  return parseMetamodel(readFileSync(join(__dirname, '..', 'starter.yaml'), 'utf8'));
}

/** Cross-reference checks that zod cannot express. */
export function checkReferences(mm: Metamodel): string[] {
  const issues: string[] = [];
  const layers = new Set(mm.layers);
  const nodeNames = new Set<string>();
  const relNames = new Set<string>();

  const checkAttrs = (owner: string, attrs: AttributeDef[]) => {
    const seen = new Set<string>();
    for (const a of attrs) {
      if (seen.has(a.name)) issues.push(`${owner}: duplicate attribute '${a.name}'`);
      if (RESERVED_ATTRIBUTE_NAMES.has(a.name)) {
        issues.push(`${owner}: attribute '${a.name}' is reserved for system fields`);
      }
      seen.add(a.name);
      if (a.enum && !mm.enums[a.enum]) issues.push(`${owner}.${a.name}: unknown enum '${a.enum}'`);
    }
  };

  checkAttrs('commonAttributes', mm.commonAttributes);

  for (const n of mm.nodeTypes) {
    if (nodeNames.has(n.name)) issues.push(`duplicate node type '${n.name}'`);
    nodeNames.add(n.name);
    if (!layers.has(n.layer)) issues.push(`${n.name}: unknown layer '${n.layer}'`);
    checkAttrs(n.name, n.attributes);
  }
  for (const n of mm.nodeTypes) {
    if (n.extends && !nodeNames.has(n.extends)) {
      issues.push(`${n.name}: extends unknown type '${n.extends}'`);
    }
  }
  for (const r of mm.relationshipTypes) {
    if (relNames.has(r.name)) issues.push(`duplicate relationship type '${r.name}'`);
    relNames.add(r.name);
    for (const end of [...r.from, ...r.to]) {
      if (end !== '*' && !nodeNames.has(end)) issues.push(`${r.name}: unknown endpoint '${end}'`);
    }
    checkAttrs(r.name, r.attributes);
  }
  for (const rule of mm.rules) {
    const rel = mm.relationshipTypes.find((r) => r.name === rule.relationship);
    if (!rel) {
      issues.push(`rule ${rule.id}: unknown relationship '${rule.relationship}'`);
      continue;
    }
    if (rule.kind === 'uniqueValuePerTarget') {
      const attr = rel.attributes.find((a) => a.name === rule.attribute);
      if (!attr) issues.push(`rule ${rule.id}: '${rel.name}' has no attribute '${rule.attribute}'`);
      const allowed = attr?.enum ? mm.enums[attr.enum] : undefined;
      for (const v of rule.values) {
        if (allowed && !allowed.includes(v)) issues.push(`rule ${rule.id}: '${v}' not in ${attr!.enum}`);
      }
    }
  }
  return issues;
}
