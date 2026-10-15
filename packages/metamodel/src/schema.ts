import { z } from 'zod';

/** PascalCase for node types, UPPER_SNAKE for relationship types (Neo4j conventions). */
const NodeTypeName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'node type must be PascalCase');
const RelTypeName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'relationship type must be UPPER_SNAKE');
const AttrName = z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'attribute must be camelCase');

export const AttributeType = z.enum([
  'string',
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'datetime',
  'enum',
  'string[]',
  'url',
]);
export type AttributeType = z.infer<typeof AttributeType>;

export const AttributeDef = z
  .object({
    name: AttrName,
    type: AttributeType,
    /** Name of an entry in `enums`; required when type is `enum`. */
    enum: z.string().optional(),
    required: z.boolean().default(false),
    description: z.string().optional(),
  })
  .refine((a) => a.type !== 'enum' || !!a.enum, { message: 'enum attributes must name an enum' });
export type AttributeDef = z.infer<typeof AttributeDef>;

export const NodeTypeDef = z.object({
  name: NodeTypeName,
  layer: z.string(),
  description: z.string().optional(),
  /** Inherit attributes and relationship eligibility from another node type. */
  extends: NodeTypeName.optional(),
  attributes: z.array(AttributeDef).default([]),
  /** Internal types are hidden from end-user pickers. */
  internal: z.boolean().default(false),
});
export type NodeTypeDef = z.infer<typeof NodeTypeDef>;

/** `*` means any element type. */
const Endpoint = z.union([NodeTypeName, z.literal('*')]);

export const RelationshipTypeDef = z.object({
  name: RelTypeName,
  description: z.string().optional(),
  from: z.array(Endpoint).min(1),
  to: z.array(Endpoint).min(1),
  attributes: z.array(AttributeDef).default([]),
});
export type RelationshipTypeDef = z.infer<typeof RelationshipTypeDef>;

export const RuleDef = z.discriminatedUnion('kind', [
  z.object({
    id: z.string(),
    kind: z.literal('acyclic'),
    relationship: RelTypeName,
    description: z.string().optional(),
  }),
  z.object({
    id: z.string(),
    kind: z.literal('uniqueValuePerTarget'),
    /** At most one relationship per target node may carry each listed value (per validity period). */
    relationship: RelTypeName,
    attribute: AttrName,
    values: z.array(z.string()).min(1),
    description: z.string().optional(),
  }),
]);
export type RuleDef = z.infer<typeof RuleDef>;

export const Metamodel = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  layers: z.array(z.string()).min(1),
  enums: z.record(z.array(z.string()).min(1)).default({}),
  /** Attributes every element carries (managed by the platform). */
  commonAttributes: z.array(AttributeDef).default([]),
  nodeTypes: z.array(NodeTypeDef).min(1),
  relationshipTypes: z.array(RelationshipTypeDef).default([]),
  rules: z.array(RuleDef).default([]),
});
export type Metamodel = z.infer<typeof Metamodel>;
