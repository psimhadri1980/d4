import { RESERVED_ATTRIBUTE_NAMES } from '@d4/metamodel';
import type { Attributes, Element, Relationship, SystemFields } from '@d4/core';

/**
 * Elements and relationships are stored as flat property maps: system fields and metamodel
 * attributes side by side (`n.name`, `n.lifecycle`, `n.version`), which keeps catalog Cypher
 * readable. The metamodel forbids attribute names that clash with system fields.
 */

type Props = Record<string, unknown>;

const SYSTEM_KEYS: (keyof SystemFields)[] = [
  'id',
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
];

function systemProps(item: SystemFields): Props {
  const p: Props = {};
  // Neo4j cannot store nulls; absent properties read back as null.
  for (const k of SYSTEM_KEYS) if (item[k] !== null) p[k] = item[k];
  return p;
}

function attrProps(attrs: Attributes): Props {
  const p: Props = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) p[k] = v;
  return p;
}

export const elementToProps = (e: Element): Props => ({
  ...attrProps(e.attrs),
  ...systemProps(e),
  type: e.type,
});

export const relationshipToProps = (r: Relationship): Props => ({
  ...attrProps(r.attrs),
  ...systemProps(r),
});

function splitProps(p: Props): { system: SystemFields; attrs: Attributes } {
  const attrs: Attributes = {};
  for (const [k, v] of Object.entries(p)) if (!RESERVED_ATTRIBUTE_NAMES.has(k)) attrs[k] = v;
  return {
    attrs,
    system: {
      id: p['id'] as string,
      workspaceId: p['workspaceId'] as string,
      version: Number(p['version']),
      validFrom: (p['validFrom'] as string | undefined) ?? null,
      validTo: (p['validTo'] as string | undefined) ?? null,
      scenarioId: (p['scenarioId'] as string | undefined) ?? null,
      deleted: p['deleted'] === true,
      createdAt: p['createdAt'] as string,
      createdBy: p['createdBy'] as string,
      updatedAt: p['updatedAt'] as string,
      updatedBy: p['updatedBy'] as string,
    },
  };
}

export function propsToElement(p: Props): Element {
  const { system, attrs } = splitProps(p);
  return { ...system, type: p['type'] as string, attrs };
}

export function propsToRelationship(p: Props, type: string, fromId: string, toId: string): Relationship {
  const { system, attrs } = splitProps(p);
  return { ...system, type, fromId, toId, attrs };
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Labels and relationship types cannot be Cypher parameters. Everything interpolated into a
 * statement goes through this check (values come from the validated metamodel).
 */
export function ident(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Unsafe Cypher identifier '${name}'`);
  return name;
}
