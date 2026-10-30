import { ConnectionSchema, ConnectionsQuery, CreateElementBody, CreateProposalBody, CreateRelationshipBody, DecisionSchema, DiffQuery, DiffSchema, EditProposalBody, ElementPageSchema, ElementSchema, EventSchema, ExportQuery, ListElementsQuery, MatrixParams, MatrixSchema, NeighbourhoodQuery, ProposalOperation, RelationshipSchema, ReviewBody, RoadmapQuery, RoadmapSchema, SubgraphSchema, TableMappingSchema, TabularAnalyzeBody, TabularImportBody, UpdateBody, ViewArgsSchema } from './model.schemas';
import { json, errors, writeErrors, ws, id, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for the workspace model. */
export function registerModelRoutes(route: ApiRoute) {
  // Elements
  const el = '/v1/workspaces/{ws}/elements';
  route({
    method: 'get',
    path: el,
    tags: ['Elements'],
    summary: 'List, filter, page or search elements',
    request: { params: z.object({ ws }), query: ListElementsQuery },
    responses: { 200: json(ElementPageSchema, 'A page of elements'), ...errors },
  });
  route({
    method: 'post',
    path: el,
    tags: ['Elements'],
    request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: CreateElementBody } } } },
    responses: { 201: json(ElementSchema, 'Created'), ...writeErrors },
  });
  route({
    method: 'get',
    path: `${el}/{id}`,
    tags: ['Elements'],
    request: { params: z.object({ ws, id }) },
    responses: { 200: json(ElementSchema, 'The element'), ...errors },
  });
  route({
    method: 'patch',
    path: `${el}/{id}`,
    tags: ['Elements'],
    request: { params: z.object({ ws, id }), body: { content: { 'application/json': { schema: UpdateBody } } } },
    responses: { 200: json(ElementSchema, 'Updated'), ...writeErrors },
  });
  route({
    method: 'delete',
    path: `${el}/{id}`,
    tags: ['Elements'],
    summary: 'Soft-delete an element and its relationships',
    request: {
      params: z.object({ ws, id }),
      query: z.object({ expectedVersion: z.number().int() }),
    },
    responses: { 204: { description: 'Deleted' }, ...writeErrors },
  });
  route({
    method: 'get',
    path: `${el}/{id}/relationships`,
    tags: ['Elements'],
    request: { params: z.object({ ws, id }), query: ConnectionsQuery },
    responses: { 200: json(z.array(ConnectionSchema), 'Relationships with the element at the other end'), ...errors },
  });
  route({
    method: 'get',
    path: `${el}/{id}/neighbourhood`,
    tags: ['Elements'],
    request: { params: z.object({ ws, id }), query: NeighbourhoodQuery },
    responses: { 200: json(SubgraphSchema, 'Subgraph around the element'), ...errors },
  });
  route({
    method: 'get',
    path: `${el}/{id}/history`,
    tags: ['Elements'],
    request: { params: z.object({ ws, id }) },
    responses: { 200: json(z.array(EventSchema), 'Change events, oldest first'), ...errors },
  });

  // Roadmaps
  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/roadmap',
    tags: ['Roadmaps'],
    description:
      'Deliverables and milestones in scope (contained, owned or changing the scope elements, plus their prerequisites), scheduled with slack, critical path, lanes and conflicts.',
    request: { params: z.object({ ws }), query: RoadmapQuery },
    responses: { 200: json(RoadmapSchema, 'Scheduled roadmap'), ...errors },
  });

  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/diff',
    tags: ['Time and scenarios'],
    description:
      'Differences between two views of the workspace (dates and/or scenarios): elements added and removed, relationships added, removed and replaced (same type between the same two elements).',
    request: { params: z.object({ ws }), query: DiffQuery },
    responses: { 200: json(DiffSchema, 'Differences, from → to'), ...errors },
  });

  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/matrix/{kind}',
    tags: ['Matrices and decisions'],
    description: 'A matrix with findings: CRUD-I, capability × application, data store roles, or the lifecycle heat-map.',
    request: { params: z.object({ ws }).merge(MatrixParams), query: ViewArgsSchema },
    responses: { 200: json(MatrixSchema, 'Matrix'), ...errors },
  });
  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/decisions',
    tags: ['Matrices and decisions'],
    description: 'Architecture decision records, newest first, with decided elements, options, supersession and findings.',
    request: { params: z.object({ ws }), query: ViewArgsSchema },
    responses: { 200: json(z.array(DecisionSchema), 'Decision log'), ...errors },
  });

  // Relationships
  const rel = '/v1/workspaces/{ws}/relationships';
  route({
    method: 'post',
    path: rel,
    tags: ['Relationships'],
    request: {
      params: z.object({ ws }),
      body: { content: { 'application/json': { schema: CreateRelationshipBody } } },
    },
    responses: { 201: json(RelationshipSchema, 'Created'), ...writeErrors },
  });
  route({
    method: 'get',
    path: `${rel}/{id}`,
    tags: ['Relationships'],
    request: { params: z.object({ ws, id }) },
    responses: { 200: json(RelationshipSchema, 'The relationship'), ...errors },
  });
  route({
    method: 'patch',
    path: `${rel}/{id}`,
    tags: ['Relationships'],
    request: { params: z.object({ ws, id }), body: { content: { 'application/json': { schema: UpdateBody } } } },
    responses: { 200: json(RelationshipSchema, 'Updated'), ...writeErrors },
  });
  route({
    method: 'delete',
    path: `${rel}/{id}`,
    tags: ['Relationships'],
    request: { params: z.object({ ws, id }), query: z.object({ expectedVersion: z.number().int() }) },
    responses: { 204: { description: 'Deleted' }, ...writeErrors },
  });
  route({
    method: 'get',
    path: `${rel}/{id}/history`,
    tags: ['Relationships'],
    request: { params: z.object({ ws, id }) },
    responses: { 200: json(z.array(EventSchema), 'Change events, oldest first'), ...errors },
  });

  // Model-as-code
  const ImportSummary = z
    .object({
      ok: z.boolean(),
      applied: z.boolean(),
      issues: z.array(z.object({ subjectId: z.string(), ruleId: z.string().optional(), message: z.string() })),
      elements: z.object({ created: z.number(), updated: z.number(), unchanged: z.number() }),
      relationships: z.object({ created: z.number(), updated: z.number(), unchanged: z.number() }),
      keyToId: z.record(z.string()),
    })
    .openapi('ImportSummary');
  const ModelDocumentSchema = z
    .record(z.unknown())
    .openapi('ModelDocument', { description: 'apiVersion d4/v1, kind Model; see samples/ubs-banking.yaml' });
  route({
    method: 'post',
    path: '/v1/workspaces/{ws}/import',
    tags: ['Model as code'],
    summary: 'Import a model document (idempotent; validated as a whole; applied as one change)',
    request: {
      params: z.object({ ws }),
      query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
      body: { content: { 'application/json': { schema: ModelDocumentSchema } } },
    },
    responses: { 200: json(ImportSummary, 'Plan summary; `applied` tells whether changes were written'), ...writeErrors },
  });
  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/export',
    tags: ['Model as code'],
    description:
      'The workspace (or the neighbourhood of `scope` elements) in a view. Without `format`: the model document as JSON. With `format`: a file download (YAML, JSON, CSV, Mermaid, ArchiMate Open Exchange XML or a Cypher script).',
    request: { params: z.object({ ws }), query: ExportQuery },
    responses: {
      200: {
        description: 'The model document (JSON), or the file for `format`',
        content: {
          'application/json': { schema: ModelDocumentSchema },
          'text/csv': { schema: z.string() },
          'text/plain': { schema: z.string() },
          'application/xml': { schema: z.string() },
          'application/yaml': { schema: z.string() },
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { schema: z.string().openapi({ format: 'binary' }) },
        },
      },
      ...errors,
    },
  });

  route({
    method: 'post',
    path: '/v1/workspaces/{ws}/import/tabular/analyze',
    tags: ['Model as code'],
    summary: 'Read CSV / Excel files and suggest a mapping per table (sheet)',
    request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: TabularAnalyzeBody } } } },
    responses: {
      200: json(
        z.object({
          tables: z.array(
            z.object({ name: z.string(), headers: z.array(z.string()), rowCount: z.number(), preview: z.array(z.array(z.string())), mapping: TableMappingSchema }),
          ),
        }),
        'Tables with a preview and a suggested mapping',
      ),
      ...errors,
    },
  });
  route({
    method: 'post',
    path: '/v1/workspaces/{ws}/import/tabular',
    tags: ['Model as code'],
    summary: 'Import mapped CSV / Excel rows (dry run with ?dryRun=true; applied as one change only when every row is valid)',
    request: {
      params: z.object({ ws }),
      query: z.object({ dryRun: z.enum(['true', 'false']).optional() }),
      body: { content: { 'application/json': { schema: TabularImportBody } } },
    },
    responses: {
      200: json(
        ImportSummary.extend({
          rowIssues: z.array(z.object({ table: z.string(), row: z.number(), column: z.string().optional(), message: z.string() })),
          rowsUsed: z.record(z.number()),
        }),
        'Plan summary plus problems per row',
      ),
      ...writeErrors,
    },
  });
  const ProposalSummary = z
    .object({ id: z.string(), workspaceId: z.string(), title: z.string(), description: z.string().nullable(), status: z.enum(['draft', 'submitted', 'applied', 'rejected', 'withdrawn']), stepCount: z.number(), createdBy: z.string(), createdAt: z.string(), updatedAt: z.string(), submittedAt: z.string().nullable(), decidedBy: z.string().nullable(), decidedAt: z.string().nullable(), reviewComment: z.string().nullable() })
    .openapi('ProposalSummary');
  const Proposal = ProposalSummary.extend({
    operations: z.array(ProposalOperation),
    steps: z.array(z.object({ index: z.number(), op: z.string(), text: z.string(), subjectId: z.string().nullable(), state: z.enum(['ok', 'error', 'unchecked']), error: z.object({ code: z.string(), message: z.string() }).nullable() })),
    check: z.object({ ok: z.boolean() }).nullable().describe('Whether every step applies to the model as it is now; null once final'),
  }).openapi('Proposal');
  const propPath = '/v1/workspaces/{ws}/proposals';
  const pid = z.string().openapi({ param: { name: 'id', in: 'path' } });
  const propBody = (schema: z.ZodTypeAny) => ({ body: { content: { 'application/json': { schema } } } });
  route({ method: 'get', path: propPath, tags: ['Proposals'], summary: 'Proposals, newest activity first (?status= repeatable)', request: { params: z.object({ ws }) }, responses: { 200: json(z.array(ProposalSummary), 'Proposals'), ...errors } });
  route({ method: 'post', path: propPath, tags: ['Proposals'], summary: 'Create a draft (write access)', request: { params: z.object({ ws }), ...propBody(CreateProposalBody) }, responses: { 201: json(Proposal, 'Created'), ...errors } });
  route({ method: 'get', path: `${propPath}/{id}`, tags: ['Proposals'], summary: 'A proposal, each step described and checked against the live model', request: { params: z.object({ ws, id: pid }) }, responses: { 200: json(Proposal, 'Proposal'), ...errors } });
  route({ method: 'patch', path: `${propPath}/{id}`, tags: ['Proposals'], summary: 'Change a draft (author only)', request: { params: z.object({ ws, id: pid }), ...propBody(EditProposalBody) }, responses: { 200: json(Proposal, 'Updated'), ...errors } });
  route({ method: 'delete', path: `${propPath}/{id}`, tags: ['Proposals'], summary: 'Delete a draft (author only)', request: { params: z.object({ ws, id: pid }) }, responses: { 204: { description: 'Deleted' }, ...errors } });
  for (const [action, summary] of [
    ['submit', 'Send a draft for review; every step must apply (author only)'],
    ['reopen', 'Take a submitted proposal back to draft (author only)'],
    ['withdraw', 'Withdraw a draft or submitted proposal (author only)'],
  ] as const) {
    route({ method: 'post', path: `${propPath}/{id}/${action}`, tags: ['Proposals'], summary, request: { params: z.object({ ws, id: pid }) }, responses: { 200: json(Proposal, 'Proposal'), ...errors } });
  }
  route({ method: 'post', path: `${propPath}/{id}/approve`, tags: ['Proposals'], summary: 'Apply every step as one change (architect or admin, not the author); 409 names the step that no longer applies', request: { params: z.object({ ws, id: pid }), ...propBody(ReviewBody) }, responses: { 200: json(Proposal, 'Applied'), ...errors } });
  route({ method: 'post', path: `${propPath}/{id}/reject`, tags: ['Proposals'], summary: 'Reject with a comment (architect or admin, not the author)', request: { params: z.object({ ws, id: pid }), ...propBody(ReviewBody) }, responses: { 200: json(Proposal, 'Rejected'), ...errors } });
}
