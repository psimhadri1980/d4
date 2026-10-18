import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { LANE_KINDS, MATRIX_KINDS } from '@d4/core';

// Adds `.openapi()` to zod schemas; must run before any schema below is defined.
extendZodWithOpenApi(z);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).openapi({ example: '2026-10-17' });
const Attrs = z
  .record(z.unknown())
  .openapi({ description: 'Metamodel attributes', example: { name: 'Customer', lifecycle: 'PROPOSED' } });

/** Comma-separated query values (`?type=Application,Platform`) → array. */
const csv = z
  .string()
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .optional();

// ── Requests ────────────────────────────────────────────────────────────

export const CreateElementBody = z
  .object({
    type: z.string().openapi({ example: 'DataProduct' }),
    attrs: Attrs,
    id: z.string().optional().openapi({ description: 'Optional ULID (imports keep ids stable)' }),
    validFrom: IsoDate.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
    scenarioId: z.string().nullable().optional(),
  })
  .strict()
  .openapi('CreateElement');

export const CreateRelationshipBody = z
  .object({
    type: z.string().openapi({ example: 'HOLDS' }),
    fromId: z.string(),
    toId: z.string(),
    attrs: Attrs.optional(),
    id: z.string().optional(),
    validFrom: IsoDate.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
    scenarioId: z.string().nullable().optional(),
  })
  .strict()
  .openapi('CreateRelationship');

export const UpdateBody = z
  .object({
    expectedVersion: z.number().int().positive(),
    set: Attrs.optional(),
    unset: z.array(z.string()).optional(),
    validFrom: IsoDate.nullable().optional(),
    validTo: IsoDate.nullable().optional(),
  })
  .strict()
  .openapi('Update', {
    description: 'Omitted fields are unchanged; `null` clears a validity bound.',
  });

export const DeleteQuery = z.object({ expectedVersion: z.coerce.number().int().positive() });

/** Which state of the model to read (see ModelView): a date and/or a scenario. */
const View = {
  asOf: IsoDate.optional().openapi({ description: 'Only items valid on this date' }),
  scenario: z.string().optional().openapi({ description: 'Scenario element id: the baseline plus this scenario' }),
};

export const ViewArgsSchema = z.object(View);

export const ListElementsQuery = z.object({
  ...View,
  type: csv.openapi({ description: 'Element types (supertypes include subtypes)' }),
  layer: z.string().optional(),
  lifecycle: csv,
  q: z.string().optional().openapi({ description: 'Full-text search over name and description' }),
  first: z.coerce.number().int().min(1).max(200).optional(),
  after: z.string().optional().openapi({ description: 'Cursor from the previous page' }),
});

export const ConnectionsQuery = z.object({
  ...View,
  direction: z.enum(['OUT', 'IN', 'BOTH']).optional(),
  type: csv,
});

export const NeighbourhoodQuery = z.object({
  ...View,
  depth: z.coerce.number().int().min(1).max(3).optional(),
  type: csv,
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

export const MatrixParams = z.object({
  kind: z.enum(MATRIX_KINDS).openapi({ description: 'crud | capability-application | data-store-roles | lifecycle' }),
});

export const DiffQuery = z
  .object({
    fromAsOf: IsoDate.optional(),
    fromScenario: z.string().optional(),
    toAsOf: IsoDate.optional(),
    toScenario: z.string().optional(),
  })
  .refine((q) => q.fromAsOf !== q.toAsOf || q.fromScenario !== q.toScenario, {
    message: 'from and to must differ in date or scenario',
  })
  .openapi({ description: 'Each side is a view: a date (default: ignore validity) and/or a scenario (default: baseline)' });

export const RoadmapQuery = z.object({
  scope: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1).max(50))
    .openapi({ description: 'Comma-separated element ids: initiatives, divisions, deliverables or any element that is changed' }),
  lanes: z.enum(LANE_KINDS).optional().openapi({ description: 'Swim-lane grouping (default initiative)' }),
  today: IsoDate.optional().openapi({ description: 'Reference date for past-due checks (default: today)' }),
});

// ── Responses (documentation) ───────────────────────────────────────────

const System = {
  id: z.string(),
  workspaceId: z.string(),
  version: z.number().int(),
  validFrom: IsoDate.nullable(),
  validTo: IsoDate.nullable(),
  scenarioId: z.string().nullable(),
  deleted: z.boolean(),
  createdAt: z.string(),
  createdBy: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string(),
};

export const ElementSchema = z.object({ ...System, type: z.string(), attrs: Attrs }).openapi('Element');
export const RelationshipSchema = z
  .object({ ...System, type: z.string(), fromId: z.string(), toId: z.string(), attrs: Attrs })
  .openapi('Relationship');

export const ElementPageSchema = z
  .object({ items: z.array(ElementSchema), endCursor: z.string().nullable(), hasMore: z.boolean() })
  .openapi('ElementPage');

export const ConnectionSchema = z
  .object({ relationship: RelationshipSchema, other: ElementSchema })
  .openapi('Connection');

export const SubgraphSchema = z
  .object({
    root: ElementSchema,
    elements: z.array(ElementSchema),
    relationships: z.array(RelationshipSchema),
    truncated: z.boolean(),
  })
  .openapi('Subgraph');

export const EventSchema = z
  .object({
    seq: z.number(),
    id: z.string(),
    type: z.string(),
    workspaceId: z.string(),
    actor: z.string(),
    occurredAt: z.string(),
    subjectId: z.string(),
    version: z.number().int(),
    data: z.record(z.unknown()),
  })
  .openapi('Event');

export const RoadmapSchema = z
  .object({
    order: z.array(z.string()),
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(['deliverable', 'milestone']),
        start: IsoDate.nullable(),
        end: IsoDate.nullable(),
        status: z.string().nullable().optional(),
        lane: z.string().nullable().optional(),
        earliestStart: IsoDate,
        earliestEnd: IsoDate,
        durationDays: z.number().int(),
        slackDays: z.number().int(),
        critical: z.boolean(),
      }),
    ),
    criticalPath: z.array(z.string()),
    conflicts: z.array(
      z.object({ kind: z.string(), itemIds: z.array(z.string()), message: z.string(), days: z.number().int().optional() }),
    ),
    lanes: z.array(z.object({ name: z.string(), itemIds: z.array(z.string()) })),
    lanesBy: z.enum(LANE_KINDS),
    changes: z.array(
      z.object({
        deliverableId: z.string(),
        elementId: z.string(),
        elementName: z.string(),
        elementType: z.string(),
        action: z.enum(['INTRODUCE', 'MODIFY', 'RETIRE']),
        targetLifecycle: z.string().nullable(),
      }),
    ),
    dependencies: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        type: z.enum(['FINISH_START', 'START_START', 'FINISH_FINISH', 'START_FINISH']),
        lagDays: z.number().int(),
      }),
    ),
    start: IsoDate.nullable(),
    end: IsoDate.nullable(),
  })
  .openapi('Roadmap');

const Changed = z.object({
  before: RelationshipSchema,
  after: RelationshipSchema,
  fields: z.array(z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })),
});
export const DiffSchema = z
  .object({
    elements: z.object({ added: z.array(ElementSchema), removed: z.array(ElementSchema) }),
    relationships: z.object({ added: z.array(RelationshipSchema), removed: z.array(RelationshipSchema), changed: z.array(Changed) }),
    names: z.record(z.string()).openapi({ description: 'Element id → name for every element the relationships mention' }),
  })
  .openapi('ModelDiff');

const AxisItem = z.object({ id: z.string(), name: z.string(), type: z.string(), group: z.string().optional() });
export const MatrixSchema = z
  .object({
    kind: z.enum(MATRIX_KINDS),
    title: z.string(),
    rowLabel: z.string(),
    columnLabel: z.string(),
    rows: z.array(AxisItem),
    columns: z.array(AxisItem),
    cells: z.array(z.object({ row: z.string(), column: z.string(), values: z.array(z.string()) })),
    values: z.array(z.string()),
    findings: z.array(z.string()),
    truncated: z.boolean(),
  })
  .openapi('Matrix');

const DecisionRef = z.object({ id: z.string(), name: z.string(), type: z.string(), lifecycle: z.string().nullable() });
export const DecisionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string().nullable(),
    decidedOn: IsoDate.nullable(),
    context: z.string().nullable(),
    consequences: z.string().nullable(),
    lifecycle: z.string().nullable(),
    decides: z.array(DecisionRef),
    options: z.array(DecisionRef.extend({ chosen: z.boolean() })),
    supersedes: z.array(DecisionRef),
    supersededBy: z.array(DecisionRef),
    findings: z.array(z.string()),
  })
  .openapi('Decision');

export const ErrorSchema = z
  .object({
    error: z.string().openapi({
      example: 'RULE_VIOLATION',
      description: 'BAD_REQUEST | VALIDATION | NOT_FOUND | VERSION_CONFLICT | INVALID_TRANSITION | RULE_VIOLATION',
    }),
    message: z.string(),
    issues: z.array(z.string()).optional(),
    ruleId: z.string().optional(),
  })
  .openapi('Error');

export { z };
