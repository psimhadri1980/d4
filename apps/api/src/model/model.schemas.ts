import { z } from '../http/zod';
import { EXPORT_FORMATS } from '@d4/codecs';
import { LANE_KINDS, LENS_PHRASE, MATRIX_KINDS } from '@d4/core';

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

const AttributeFilterBody = z
  .object({
    attribute: z.string().regex(/^[a-z][A-Za-z0-9]*$/).openapi({ example: 'criticality' }),
    op: z.enum(['eq', 'in', 'contains', 'starts', 'gte', 'lte']),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()])).max(100)]),
  })
  .strict()
  .openapi('AttributeFilter');

/** A catalog query a lens takes its roots from (D84). */
const LensQueryBody = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive().optional().openapi({ description: 'A fixed published version; the latest when absent' }),
    params: z.record(z.unknown()).default({}).openapi({ description: "Values for the query's parameters; checked against its definitions" }),
  })
  .strict();

const RelKind = z.enum(['containment', 'dependency', 'flow', 'ownership', 'association', 'classification']);

/** One traversal step of a lens (D85). */
const LensStepBody = z
  .object({
    kind: RelKind.optional().openapi({ description: 'Follow the relationships of this kind in the metamodel' }),
    relationships: z.array(z.string()).max(50).optional().openapi({ description: 'Follow exactly these; any when neither this nor kind is given' }),
    direction: z.enum(['down', 'up', 'both']).openapi({ description: "down follows each relationship the way the metamodel reads it as down (its `forward`); up the reverse" }),
    types: z.array(z.string()).max(50).optional().openapi({ description: 'Only to nodes of these types; supertypes match their subtypes' }),
    stage: z.string().max(60).optional().openapi({ description: "The column this step's nodes are drawn in, in a Flow lens" }),
    repeat: z.boolean().optional().openapi({ description: 'Keep following this step, level after level' }),
  })
  .strict()
  .openapi('LensStep');

const DisclosureBody = z
  .object({
    budget: z.number().int().min(1).max(350).default(150).openapi({ description: 'Nodes drawn before the rest folds into groups' }),
    initialDepth: z.number().int().min(1).max(6).default(1),
    perNodeCap: z.number().int().min(1).max(100).default(12).openapi({ description: "A parent's links of one relationship and type fold into a group above this many" }),
  })
  .strict()
  .openapi('LensDisclosure');

const LensGroupSchema = z
  .object({
    id: z.string(),
    parent: z.string(),
    relationship: z.string(),
    direction: z.enum(['OUT', 'IN']),
    type: z.string(),
    level: z.number().int().min(1),
    count: z.number().int().min(0),
    offset: z.number().int().min(0),
  })
  .strict()
  .openapi('LensGroup');

export const StudioSearchBody = z
  .object({
    ...View,
    ids: z.array(z.string()).min(1).max(500).optional().openapi({ description: 'Exactly these elements as roots (a drill-down)' }),
    types: z.array(z.string()).max(200).optional().openapi({ description: 'Contour node types; any type when absent' }),
    name: z.string().max(200).optional().openapi({ description: 'Case-insensitive part of the name' }),
    attributes: z.array(AttributeFilterBody).max(20).optional(),
    facets: z
      .array(
        z
          .object({
            types: z.array(z.string()).min(1).max(50),
            relationship: z.string().optional(),
            direction: z.enum(['OUT', 'IN', 'BOTH']).default('BOTH'),
            link: z.enum(['has', 'none']).default('has'),
            attributes: z.array(AttributeFilterBody).max(20).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    match: z.enum(['all', 'any']).default('all'),
    query: LensQueryBody.optional().openapi({ description: 'Roots from a published catalog query that returns element ids in an `id` column, or element nodes; the other filters narrow them' }),
    depth: z.number().int().min(1).max(6).default(2).openapi({ description: 'Hops from each root, both directions' }),
    maxNodes: z.number().int().min(1).max(1000).default(1000),
    steps: z.array(LensStepBody).min(1).max(10).optional().openapi({ description: 'With disclosure: the traversal (D85); any relationship both ways, repeated, when absent' }),
    disclosure: DisclosureBody.optional().openapi({ description: 'Draw by disclosure (D85): a budget, with the rest folded into groups; depth and maxNodes do not apply' }),
  })
  .strict()
  .refine((b) => b.query || b.ids?.length || b.types?.length || b.name?.trim() || b.attributes?.length || b.facets?.length, {
    message: 'give at least one of query, ids, types, name, attributes or facets',
  })
  .openapi('StudioSearch');

const CountSearch = z
  .object({
    types: z.array(z.string()).max(200).optional(),
    name: z.string().max(200).optional(),
    attributes: z.array(AttributeFilterBody).max(20).optional(),
    facets: z.array(z.object({ types: z.array(z.string()).min(1).max(50), relationship: z.string().optional(), direction: z.enum(['OUT', 'IN', 'BOTH']).default('BOTH'), link: z.enum(['has', 'none']).default('has'), attributes: z.array(AttributeFilterBody).max(20).optional() }).strict()).max(10).optional(),
    match: z.enum(['all', 'any']).default('all'),
  })
  .strict();

export const StudioCountsBody = z
  .object({
    ...View,
    searches: z.array(CountSearch).min(1).max(30).openapi({ description: 'One per lens; each is counted on its own' }),
    cap: z.number().int().min(1).max(10_000).default(1000).openapi({ description: 'Counting stops here; `more` says there are more' }),
    sample: z.number().int().min(0).max(20).default(0).openapi({ description: 'Names of the first roots to return with each count' }),
  })
  .strict()
  .openapi('StudioCounts');

export const StudioCountsSchema = z
  .object({ counts: z.array(z.object({ count: z.number().int(), more: z.boolean(), sample: z.array(z.string()) })) })
  .openapi('StudioCountsResult');

const Facet = z
  .object({
    types: z.array(z.string()).min(1).max(50),
    relationship: z.string().optional(),
    direction: z.enum(['OUT', 'IN', 'BOTH']).default('BOTH'),
    link: z.enum(['has', 'none']).default('has'),
    attributes: z.array(AttributeFilterBody).max(20).optional(),
  })
  .strict();

export const StudioLensBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).optional(),
    visibility: z.enum(['private', 'workspace']).default('private').openapi({ description: 'Workspace lenses need write access to the workspace' }),
    contour: z.object({ type: z.string(), attributes: z.array(AttributeFilterBody).max(20).optional() }).strict(),
    facets: z.array(Facet).max(10).default([]),
    match: z.enum(['all', 'any']).default('all'),
    query: LensQueryBody.optional(),
    quickFilters: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).max(20).optional().openapi({ description: 'Attributes offered as quick filters' }),
    phrases: z.array(z.string().trim().max(120).regex(LENS_PHRASE, 'a phrase is words then one slot at the end, such as "impact of $application"')).max(10).optional().openapi({ description: 'Search phrases that open the lens (D92)' }),
    depth: z.number().int().min(1).max(6).default(2),
    steps: z.array(LensStepBody).min(1).max(10).optional(),
    shape: z.enum(['ego', 'tree', 'flow', 'matrix', 'landscape']).optional(),
    disclosure: z
      .object({ budget: z.number().int().min(1).max(350).optional(), initialDepth: z.number().int().min(1).max(6).optional(), perNodeCap: z.number().int().min(1).max(100).optional() })
      .strict()
      .optional()
      .openapi({ description: "The lens's own disclosure settings; the rest default" }),
    layout: z.enum(['hier', 'flow', 'layers', 'radial', 'force']).default('hier'),
    view: z.enum(['graph', 'table']).default('graph'),
    follow: z.boolean().default(false),
  })
  .strict()
  .openapi('StudioLensInput');

export const StudioLensSchema = StudioLensBody.extend({ id: z.string(), owner: z.string(), updatedAt: z.string() }).openapi('StudioLens');

export const StudioProfileBody = z
  .object({ ...View, type: z.string(), attributes: z.array(z.string().regex(/^[a-z][A-Za-z0-9]*$/)).max(20).default([]) })
  .strict()
  .openapi('StudioProfileQuery');

export const StudioProfileSchema = z
  .object({
    count: z.number().int(),
    links: z.array(z.object({ relationship: z.string(), direction: z.enum(['OUT', 'IN']), type: z.string(), count: z.number().int() })),
    values: z.record(z.array(z.object({ value: z.unknown(), count: z.number().int() }))),
  })
  .openapi('StudioProfile');

export const ExportQuery = z.object({
  ...View,
  format: z.enum(EXPORT_FORMATS).optional().openapi({
    description: 'yaml | json | elements-csv | relationships-csv | mermaid | archimate | cypher. Omitted: the model document as JSON.',
  }),
  scope: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.string()).max(50))
    .optional()
    .openapi({ description: 'Element ids: export their neighbourhood instead of the whole workspace' }),
  depth: z.coerce.number().int().min(1).max(3).optional(),
});

const Upload = z
  .object({
    name: z.string().min(1).max(200).openapi({ example: 'applications.xlsx' }),
    content: z.string().max(28_000_000).openapi({ description: 'File content, base64 (≤ 20 MB decoded)' }),
  })
  .openapi('Upload');
export const TabularAnalyzeBody = z.object({ files: z.array(Upload).min(1).max(10) }).openapi('TabularAnalyze');

const ElementFieldSchema = z
  .string()
  .regex(/^(key|id|externalKey|type|name|lifecycle|description|validFrom|validTo|scenarioId|ignore|attr:[A-Za-z][\w]*)$/);
const RelationshipFieldSchema = z.string().regex(/^(id|type|from|to|validFrom|validTo|scenarioId|ignore|attr:[A-Za-z][\w]*)$/);
export const TableMappingSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('elements'), type: z.string().optional(), columns: z.record(ElementFieldSchema) }),
    z.object({ kind: z.literal('relationships'), type: z.string().optional(), columns: z.record(RelationshipFieldSchema) }),
    z.object({ kind: z.literal('ignore') }),
  ])
  .openapi('TableMapping', {
    description: 'How to read a table: element or relationship rows, an optional type for the whole table, and a field per column header.',
  });
export const TabularImportBody = z
  .object({
    files: z.array(Upload).min(1).max(10),
    mappings: z.array(z.object({ table: z.string(), mapping: TableMappingSchema })).default([]),
  })
  .openapi('TabularImport');

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

const StudioResultSchema = z
  .object({
    roots: z.array(ElementSchema),
    elements: z.array(ElementSchema).openapi({ description: 'Everything reached from the roots, roots excluded' }),
    relationships: z.array(RelationshipSchema),
    tooLarge: z.boolean().openapi({ description: 'Past maxNodes, or too many roots: only roots (or nothing) and nodeCount are returned' }),
    nodeCount: z.number().int(),
  })
  .openapi('StudioResult');

export const StudioProjectionSchema = StudioResultSchema.extend({
  groups: z.array(LensGroupSchema).optional().openapi({ description: 'With disclosure: links folded into groups, to open with studio/open' }),
  levels: z.record(z.number().int()).optional().openapi({ description: "With disclosure: each shown node's level, 0 for roots" }),
  truncated: z.boolean().optional().openapi({ description: 'With disclosure: a step read more rows than allowed' }),
}).openapi('StudioProjection');

export const StudioOpenBody = z
  .object({
    ...View,
    group: LensGroupSchema,
    steps: z.array(LensStepBody).min(1).max(10).optional(),
    disclosure: DisclosureBody.default({}),
    shown: z.array(z.string()).max(2000).default([]).openapi({ description: 'Ids already on the canvas, left out of the page and the counts' }),
  })
  .strict()
  .openapi('StudioOpen');

export const StudioImpactBody = z
  .object({
    ...View,
    ids: z.array(z.string()).min(1).max(500).openapi({ description: 'The roots' }),
    steps: z.array(LensStepBody).min(1).max(10),
    maxNodes: z.number().int().min(1).max(5000).default(5000),
  })
  .strict()
  .openapi('StudioImpactInput');

export const StudioImpactSchema = z
  .object({
    rows: z.array(
      z.object({
        element: ElementSchema,
        level: z.number().int().openapi({ description: 'Steps from the nearest root' }),
        relationship: z.string(),
        direction: z.enum(['OUT', 'IN']).openapi({ description: 'Seen from `from`' }),
        from: z.string().openapi({ description: 'The node it was first reached from' }),
        fromName: z.string(),
      }),
    ),
    truncated: z.boolean().openapi({ description: 'Stopped at maxNodes or 20 levels, or a step read too many rows' }),
  })
  .openapi('StudioImpact');

export const StudioMatrixBody = z
  .object({
    ...View,
    ids: z.array(z.string()).min(1).max(500).openapi({ description: 'The roots, one row each' }),
    step: LensStepBody.openapi({ description: 'The step whose targets are the columns' }),
    maxColumns: z.number().int().min(1).max(200).default(200),
  })
  .strict()
  .openapi('StudioMatrixInput');

export const StudioMatrixSchema = z
  .object({
    rows: z.array(ElementSchema),
    columns: z.array(ElementSchema),
    cells: z.array(z.object({ row: z.string(), column: z.string(), relationships: z.array(z.string()) })),
    truncated: z.boolean().openapi({ description: 'More columns than maxColumns, or the step read too many rows' }),
  })
  .openapi('StudioMatrix');

export const StudioPathsBody = z
  .object({
    ...View,
    from: z.string().min(1),
    to: z.string().min(1),
    kind: RelKind.optional().openapi({ description: 'Only along relationships of this kind' }),
    maxLength: z.number().int().min(1).max(6).default(6).openapi({ description: 'Links per path at most' }),
    limit: z.number().int().min(1).max(25).default(25),
  })
  .strict()
  .openapi('StudioPathsInput');

export const StudioPathsSchema = z
  .object({
    paths: z.array(z.object({ nodeIds: z.array(z.string()), relationshipIds: z.array(z.string()), length: z.number().int() })),
    elements: z.array(ElementSchema),
    relationships: z.array(RelationshipSchema),
    truncated: z.boolean().openapi({ description: 'More shortest paths than limit' }),
  })
  .openapi('StudioPaths');

export const StudioGroupPageSchema = z
  .object({
    elements: z.array(ElementSchema),
    relationships: z.array(RelationshipSchema),
    groups: z.array(LensGroupSchema),
    levels: z.record(z.number().int()),
    group: LensGroupSchema.openapi({ description: 'The group with what is left in it' }),
    truncated: z.boolean(),
  })
  .openapi('StudioGroupPage');

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


// ── Change proposals ────────────────────────────────────────────────────

const ref = z.string().min(1).max(64);
const Versioned = { id: z.string().min(1), expectedVersion: z.number().int().positive() };
const Period = { validFrom: IsoDate.nullable().optional(), validTo: IsoDate.nullable().optional() };
const Changes = { set: Attrs.optional(), unset: z.array(z.string()).optional(), ...Period };

/** One step; `ref` names an element created here so later steps can use it as `from`, `to` or `id`. */
export const ProposalOperation = z
  .discriminatedUnion('op', [
    z.object({ op: z.literal('createElement'), ref, type: z.string(), attrs: Attrs, ...Period, scenarioId: z.string().nullable().optional() }).strict(),
    z.object({ op: z.literal('updateElement'), ...Versioned, ...Changes }).strict(),
    z.object({ op: z.literal('deleteElement'), ...Versioned }).strict(),
    z
      .object({ op: z.literal('createRelationship'), type: z.string(), from: z.string().min(1), to: z.string().min(1), attrs: Attrs.optional(), ...Period, scenarioId: z.string().nullable().optional() })
      .strict(),
    z.object({ op: z.literal('updateRelationship'), ...Versioned, ...Changes }).strict(),
    z.object({ op: z.literal('deleteRelationship'), ...Versioned }).strict(),
  ])
  .openapi('ProposalOperation');

export const CreateProposalBody = z
  .object({ title: z.string().trim().min(1).max(200), description: z.string().trim().max(5000).nullable().optional(), operations: z.array(ProposalOperation).max(500).default([]) })
  .strict();
export const EditProposalBody = CreateProposalBody.partial().strict();
export const ReviewBody = z.object({ comment: z.string().trim().max(5000).optional() }).strict();
