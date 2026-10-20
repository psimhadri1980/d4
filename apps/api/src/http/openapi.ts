import { OpenApiGeneratorV3, OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi';
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import {
  ConnectionSchema,
  ConnectionsQuery,
  CreateElementBody,
  CreateRelationshipBody,
  ElementPageSchema,
  ElementSchema,
  ErrorSchema,
  EventSchema,
  ListElementsQuery,
  NeighbourhoodQuery,
  RelationshipSchema,
  SubgraphSchema,
  UpdateBody,
  z,
  RoadmapQuery,
  RoadmapSchema,
  DiffQuery,
  DiffSchema,
  MatrixParams,
  MatrixSchema,
  DecisionSchema,
  ViewArgsSchema,
  ExportQuery,
  TabularAnalyzeBody,
  TabularImportBody,
  TableMappingSchema,
  CreateProposalBody,
  EditProposalBody,
  ProposalOperation,
  ReviewBody,
} from './schemas';

const json = (schema: z.ZodTypeAny, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const errors = {
  400: json(ErrorSchema, 'Malformed request'),
  401: json(ErrorSchema, 'Missing or invalid token'),
  403: json(ErrorSchema, 'No access to the workspace'),
  404: json(ErrorSchema, 'Not found'),
};
const writeErrors = {
  ...errors,
  409: json(ErrorSchema, 'Version conflict (re-read and retry)'),
  422: json(ErrorSchema, 'Metamodel, lifecycle or rule violation'),
};

const ws = z.string().openapi({ param: { name: 'ws', in: 'path' } });
const id = z.string().openapi({ param: { name: 'id', in: 'path' } });

export type OpenApiDocument = ReturnType<OpenApiGeneratorV3['generateDocument']>;

export function buildOpenApiDocument(): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  const route = (r: RouteConfig) => registry.registerPath({ security: [{ bearer: [] }], ...r });

  route({
    method: 'get',
    path: '/v1/workspaces',
    tags: ['Workspaces'],
    responses: { 200: json(z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })), 'Workspaces') },
  });
  route({
    method: 'get',
    path: '/v1/workspaces/{ws}/metamodel',
    tags: ['Workspaces'],
    request: { params: z.object({ ws }) },
    responses: { 200: json(z.record(z.unknown()), 'Active metamodel document'), ...errors },
  });

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

  const jobPath = '/v1/workspaces/{ws}/jobs';
  const JobSchema = z.object({ id: z.string(), kind: z.enum(['export', 'import-tabular', 'render']), status: z.enum(['queued', 'running', 'succeeded', 'failed']), progress: z.number(), params: z.record(z.unknown()), result: z.record(z.unknown()).nullable(), error: z.string().nullable(), artifact: z.object({ name: z.string(), type: z.string().nullable(), bytes: z.number().nullable() }).nullable(), attempts: z.number(), createdBy: z.string(), createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable() }).openapi('Job');
  const jobId = z.string().openapi({ param: { name: 'id', in: 'path' } });
  route({ method: 'post', path: `${jobPath}/export`, tags: ['Jobs'], summary: 'Start an export in the background (same parameters as GET /export)', request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: ExportQuery } } } }, responses: { 202: json(JobSchema, 'Queued job'), ...errors } });
  route({ method: 'post', path: `${jobPath}/import-tabular`, tags: ['Jobs'], summary: 'Start a spreadsheet import in the background (write access unless dryRun=true)', request: { params: z.object({ ws }), query: z.object({ dryRun: z.enum(['true', 'false']).optional() }), body: { content: { 'application/json': { schema: TabularImportBody } } } }, responses: { 202: json(JobSchema, 'Queued job'), ...writeErrors } });
  route({ method: 'post', path: `${jobPath}/render`, tags: ['Jobs'], summary: 'Render a roadmap or a graph view to SVG, PNG or PDF', request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: z.record(z.unknown()).openapi({ description: '{ target: "roadmap", format, scope[], lanes?, zoom?, paper? } or { target: "graph", format, root, depth?, asOf?, scenario?, paper? }' }) } } } }, responses: { 202: json(JobSchema, 'Queued job'), ...errors } });
  route({ method: 'get', path: jobPath, tags: ['Jobs'], summary: 'Your jobs in the workspace (admins: ?all=true for everyone’s)', request: { params: z.object({ ws }), query: z.object({ all: z.enum(['true', 'false']).optional(), limit: z.coerce.number().optional() }) }, responses: { 200: json(z.array(JobSchema), 'Jobs, newest first'), ...errors } });
  route({ method: 'get', path: `${jobPath}/{id}`, tags: ['Jobs'], request: { params: z.object({ ws, id: jobId }) }, responses: { 200: json(JobSchema, 'Job'), ...errors } });
  route({ method: 'get', path: `${jobPath}/{id}/artifact`, tags: ['Jobs'], summary: 'Download the file an export or render job produced', request: { params: z.object({ ws, id: jobId }) }, responses: { 200: { description: 'The file' }, ...errors } });

  const schedPath = '/v1/workspaces/{ws}/schedules';
  const Cadence = z
    .object({ frequency: z.enum(['daily', 'weekly', 'monthly']), hour: z.number().int(), weekday: z.number().int().optional(), day: z.number().int().optional() })
    .openapi('Cadence', { description: 'UTC hour; weekday 0 = Sunday for weekly; day 1–28 for monthly' });
  const ScheduleSchema = z
    .object({ id: z.string(), name: z.string(), kind: z.enum(['export', 'render']), params: z.record(z.unknown()), useRunDate: z.boolean(), cadence: Cadence, cadenceText: z.string(), enabled: z.boolean(), pausedReason: z.string().nullable(), recipients: z.array(z.string()), nextRunAt: z.string().nullable(), lastRunAt: z.string().nullable(), lastJob: JobSchema.nullable(), createdBy: z.string() })
    .openapi('Schedule');
  const schedId = z.string().openapi({ param: { name: 'id', in: 'path' } });
  route({ method: 'get', path: schedPath, tags: ['Reports'], summary: 'Your report schedules (admins: ?all=true)', request: { params: z.object({ ws }) }, responses: { 200: json(z.array(ScheduleSchema), 'Schedules'), ...errors } });
  route({ method: 'post', path: schedPath, tags: ['Reports'], summary: 'Schedule an export or a picture (params as for the matching job)', request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: z.object({ name: z.string(), kind: z.enum(['export', 'render']), params: z.record(z.unknown()), useRunDate: z.boolean().optional(), cadence: Cadence, recipients: z.array(z.string()).optional() }) } } } }, responses: { 201: json(ScheduleSchema, 'Created'), ...errors } });
  route({ method: 'patch', path: `${schedPath}/{id}`, tags: ['Reports'], summary: 'Rename, change cadence, pause or resume', request: { params: z.object({ ws, id: schedId }), body: { content: { 'application/json': { schema: z.object({ name: z.string().optional(), cadence: Cadence.optional(), enabled: z.boolean().optional(), useRunDate: z.boolean().optional(), recipients: z.array(z.string()).optional() }) } } } }, responses: { 200: json(ScheduleSchema, 'Updated'), ...errors } });
  route({ method: 'delete', path: `${schedPath}/{id}`, tags: ['Reports'], request: { params: z.object({ ws, id: schedId }) }, responses: { 204: { description: 'Deleted' }, ...errors } });
  route({ method: 'post', path: `${schedPath}/{id}/run`, tags: ['Reports'], summary: 'Run now (the cadence is unchanged)', request: { params: z.object({ ws, id: schedId }) }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });

  const AdminWorkspace = z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), archived: z.boolean() }).openapi('AdminWorkspace');
  const Member = z.object({ principalType: z.enum(['user', 'group']), principalId: z.string(), label: z.string(), role: z.string(), createdBy: z.string(), createdAt: z.string() }).openapi('Member');
  const BindingBody = z.object({ principalType: z.enum(['user', 'group']).optional(), principalId: z.string(), role: z.string() });
  const wsOrTenant = z.string().openapi({ param: { name: 'ws', in: 'path' }, description: 'Workspace id, or "tenant" for tenant-wide roles' });
  route({ method: 'get', path: '/v1/admin/workspaces', tags: ['Administration'], summary: 'Workspaces (?archived=true to include archived)', responses: { 200: json(z.array(AdminWorkspace), 'Workspaces'), ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces', tags: ['Administration'], summary: 'Create a workspace on the active metamodel', request: { body: { content: { 'application/json': { schema: z.object({ slug: z.string(), name: z.string(), description: z.string().optional() }) } } } }, responses: { 201: json(AdminWorkspace, 'Created'), ...errors } });
  route({ method: 'patch', path: '/v1/admin/workspaces/{ws}', tags: ['Administration'], request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: z.object({ name: z.string().optional(), description: z.string().nullable().optional() }) } } } }, responses: { 200: json(AdminWorkspace, 'Updated'), ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces/{ws}/archive', tags: ['Administration'], request: { params: z.object({ ws }) }, responses: { 204: { description: 'Archived' }, ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces/{ws}/restore', tags: ['Administration'], request: { params: z.object({ ws }) }, responses: { 204: { description: 'Restored' }, ...errors } });
  route({ method: 'get', path: '/v1/admin/users', tags: ['Administration'], summary: 'Users of the tenant (they appear after their first sign-in)', responses: { 200: json(z.array(z.object({ id: z.string(), email: z.string().nullable(), displayName: z.string().nullable(), realmRoles: z.array(z.string()), lastSeenAt: z.string() })), 'Users'), ...errors } });
  route({ method: 'get', path: '/v1/admin/members/{ws}', tags: ['Administration'], request: { params: z.object({ ws: wsOrTenant }) }, responses: { 200: json(z.array(Member), 'Role bindings'), ...errors } });
  route({ method: 'post', path: '/v1/admin/members/{ws}', tags: ['Administration'], summary: 'Grant a role', request: { params: z.object({ ws: wsOrTenant }), body: { content: { 'application/json': { schema: BindingBody } } } }, responses: { 204: { description: 'Granted' }, ...errors } });
  route({ method: 'delete', path: '/v1/admin/members/{ws}', tags: ['Administration'], summary: 'Revoke a role', request: { params: z.object({ ws: wsOrTenant }), body: { content: { 'application/json': { schema: BindingBody } } } }, responses: { 204: { description: 'Revoked' }, ...errors } });

  const Webhook = z
    .object({ id: z.string(), name: z.string(), url: z.string(), workspaceId: z.string().nullable(), eventTypes: z.array(z.string()), enabled: z.boolean(), disabledReason: z.string().nullable(), consecutiveFailures: z.number(), createdBy: z.string(), createdAt: z.string() })
    .openapi('Webhook');
  const WebhookWithSecret = Webhook.extend({ secret: z.string().describe('Signing secret; shown only here') }).openapi('WebhookWithSecret');
  const Delivery = z
    .object({ id: z.string(), eventId: z.string().nullable(), eventType: z.string(), status: z.enum(['pending', 'succeeded', 'failed']), attempts: z.number(), nextAttemptAt: z.string().nullable(), responseStatus: z.number().nullable(), lastError: z.string().nullable(), durationMs: z.number().nullable(), createdAt: z.string(), deliveredAt: z.string().nullable() })
    .openapi('WebhookDelivery');
  const hookId = z.string().openapi({ param: { name: 'id', in: 'path' } });
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

  const hookPath = '/v1/admin/webhooks';
  const WebhookBody = z.object({ name: z.string(), url: z.string().describe('https; must not resolve to a private address'), workspace: z.string().nullable().optional().describe('Workspace id or slug; null for all'), eventTypes: z.array(z.string()).optional().describe('Empty for every type') });
  route({ method: 'get', path: hookPath, tags: ['Webhooks'], responses: { 200: json(z.array(Webhook), 'Webhooks'), ...errors } });
  route({ method: 'get', path: `${hookPath}/event-types`, tags: ['Webhooks'], responses: { 200: json(z.array(z.string()), 'Event types a webhook can subscribe to'), ...errors } });
  route({ method: 'post', path: hookPath, tags: ['Webhooks'], summary: 'Create; the response holds the signing secret', description: 'Each delivery is a JSON POST with headers D4-Event, D4-Delivery and D4-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">. Answer 2xx within 10 s; failures are retried 5 times over about 7.5 hours, and a webhook is turned off after 5 failed deliveries in a row.', request: { body: { content: { 'application/json': { schema: WebhookBody } } } }, responses: { 201: json(WebhookWithSecret, 'Created'), ...errors } });
  route({ method: 'get', path: `${hookPath}/{id}`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 200: json(Webhook, 'Webhook'), ...errors } });
  route({ method: 'patch', path: `${hookPath}/{id}`, tags: ['Webhooks'], summary: 'Change, or turn on/off (turning on clears the failure count)', request: { params: z.object({ id: hookId }), body: { content: { 'application/json': { schema: WebhookBody.partial().extend({ enabled: z.boolean().optional() }) } } } }, responses: { 200: json(Webhook, 'Updated'), ...errors } });
  route({ method: 'delete', path: `${hookPath}/{id}`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 204: { description: 'Deleted with its delivery log' }, ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/rotate-secret`, tags: ['Webhooks'], request: { params: z.object({ id: hookId }) }, responses: { 200: json(WebhookWithSecret, 'New secret'), ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/ping`, tags: ['Webhooks'], summary: 'Queue a test delivery', request: { params: z.object({ id: hookId }) }, responses: { 202: json(Delivery, 'Queued'), ...errors } });
  route({ method: 'get', path: `${hookPath}/{id}/deliveries`, tags: ['Webhooks'], summary: 'Latest 50 deliveries', request: { params: z.object({ id: hookId }) }, responses: { 200: json(z.array(Delivery), 'Deliveries, newest first'), ...errors } });
  route({ method: 'post', path: `${hookPath}/{id}/deliveries/{delivery}/redeliver`, tags: ['Webhooks'], request: { params: z.object({ id: hookId, delivery: z.string().openapi({ param: { name: 'delivery', in: 'path' } }) }) }, responses: { 202: json(Delivery, 'Queued again'), ...errors } });

  // Query Catalog
  const qid = z.string().openapi({ param: { name: 'id', in: 'path' } });
  const versionParam = z.string().openapi({ param: { name: 'version', in: 'path' } });
  const CatalogEntry = z
    .object({
      id: z.string(),
      slug: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      tags: z.array(z.string()),
      system: z.boolean(),
      certified: z.boolean(),
      publishedVersion: z.number().int().nullable(),
      openStatus: z.enum(['draft', 'in_review']).nullable(),
    })
    .openapi('CatalogEntry');
  const QueryVersion = z
    .object({
      id: z.string(),
      version: z.number().int(),
      status: z.enum(['draft', 'in_review', 'published', 'deprecated', 'retired']),
      cypher: z.string(),
      params: z.array(z.record(z.unknown())),
      resultShape: z.enum(['table', 'graph']),
      contentHash: z.string(),
      checks: z.object({ errors: z.array(z.string()), warnings: z.array(z.string()) }).nullable(),
      reviewNote: z.string().nullable(),
    })
    .openapi('QueryVersion');
  const Grant = z.object({ principalType: z.enum(['role', 'group']), principal: z.string() }).openapi('QueryGrant');
  const RunResult = z
    .object({
      columns: z.array(z.string()),
      rows: z.array(z.record(z.unknown())),
      truncated: z.boolean(),
      durationMs: z.number(),
      queryId: z.string(),
      version: z.number().int(),
      status: z.string(),
    })
    .openapi('RunResult');
  const body = (schema: z.ZodTypeAny) => ({ body: { content: { 'application/json': { schema } } } });
  const cat = '/v1/catalog';

  route({
    method: 'get',
    path: cat,
    tags: ['Query Catalog'],
    summary: 'Search the catalog (users see granted queries; authors and stewards see all)',
    request: { query: z.object({ q: z.string().optional(), tag: z.string().optional() }) },
    responses: { 200: json(z.array(CatalogEntry), 'Catalog entries'), ...errors },
  });
  route({
    method: 'post',
    path: cat,
    tags: ['Query Catalog'],
    summary: 'Create a catalog entry (query-author)',
    request: body(z.object({ slug: z.string(), title: z.string(), description: z.string().optional(), tags: z.array(z.string()).optional() })),
    responses: { 201: json(CatalogEntry, 'Created'), ...writeErrors },
  });
  route({
    method: 'get',
    path: `${cat}/{id}`,
    tags: ['Query Catalog'],
    summary: 'Entry with versions (published only for users) and grants (authors/stewards)',
    request: { params: z.object({ id: qid }) },
    responses: { 200: json(CatalogEntry.extend({ versions: z.array(QueryVersion), grants: z.array(Grant).optional() }), 'Detail'), ...errors },
  });
  route({
    method: 'patch',
    path: `${cat}/{id}`,
    tags: ['Query Catalog'],
    summary: 'Edit title, description, tags (steward or owning author); certify (steward)',
    request: { params: z.object({ id: qid }), ...body(z.object({ title: z.string().optional(), description: z.string().optional(), tags: z.array(z.string()).optional(), certified: z.boolean().optional() })) },
    responses: { 200: json(CatalogEntry, 'Updated'), ...writeErrors },
  });
  route({
    method: 'delete',
    path: `${cat}/{id}`,
    tags: ['Query Catalog'],
    summary: 'Remove an entry (steward or owning author): deleted if never published, otherwise archived',
    request: { params: z.object({ id: qid }) },
    responses: { 200: json(z.object({ removed: z.enum(['deleted', 'archived']) }), 'Removed'), ...writeErrors },
  });
  route({
    method: 'put',
    path: `${cat}/{id}/draft`,
    tags: ['Query Catalog'],
    summary: 'Save the open draft (query-author); check results are returned and stored',
    request: { params: z.object({ id: qid }), ...body(z.object({ cypher: z.string(), params: z.array(z.record(z.unknown())).optional(), resultShape: z.enum(['table', 'graph']).optional() })) },
    responses: { 200: json(z.object({ version: QueryVersion, checks: z.object({ errors: z.array(z.string()), warnings: z.array(z.string()) }) }), 'Draft saved'), ...writeErrors },
  });
  route({
    method: 'post',
    path: `${cat}/{id}/submit`,
    tags: ['Query Catalog'],
    summary: 'Submit the draft for review (query-author); re-runs checks incl. Neo4j EXPLAIN',
    request: { params: z.object({ id: qid }) },
    responses: { 200: json(QueryVersion, 'In review'), ...writeErrors },
  });
  route({
    method: 'post',
    path: `${cat}/{id}/review`,
    tags: ['Query Catalog'],
    summary: 'Publish or send back the version in review (query-steward; not your own)',
    request: { params: z.object({ id: qid }), ...body(z.object({ decision: z.enum(['publish', 'reject']), note: z.string().optional() })) },
    responses: { 200: json(QueryVersion, 'Reviewed'), ...writeErrors },
  });
  route({
    method: 'post',
    path: `${cat}/{id}/versions/{version}/status`,
    tags: ['Query Catalog'],
    summary: 'Deprecate, retire or re-publish a version (query-steward)',
    request: { params: z.object({ id: qid, version: versionParam }), ...body(z.object({ status: z.enum(['deprecated', 'retired', 'published']) })) },
    responses: { 200: json(QueryVersion, 'Updated'), ...writeErrors },
  });
  route({
    method: 'put',
    path: `${cat}/{id}/grants`,
    tags: ['Query Catalog'],
    summary: 'Replace who may run the query (query-steward)',
    request: { params: z.object({ id: qid }), ...body(z.array(Grant)) },
    responses: { 200: json(z.array(Grant), 'Grants'), ...writeErrors },
  });
  route({
    method: 'get',
    path: `${cat}/{id}/executions`,
    tags: ['Query Catalog'],
    summary: 'Recent runs (query-steward or owning author)',
    request: { params: z.object({ id: qid }) },
    responses: { 200: json(z.array(z.record(z.unknown())), 'Execution log'), ...errors },
  });
  route({
    method: 'post',
    path: '/v1/workspaces/{ws}/catalog/{id}/test',
    tags: ['Query Catalog'],
    summary: 'Test-run the open draft (author) or version in review (author/steward); checks first, 100 rows, 10 s, not logged',
    request: { params: z.object({ ws, id: qid }), ...body(z.object({ params: z.record(z.unknown()).optional() })) },
    responses: { 200: json(RunResult, 'Result table'), ...writeErrors },
  });
  route({
    method: 'post',
    path: '/v1/workspaces/{ws}/catalog/{id}/run',
    tags: ['Query Catalog'],
    summary: 'Run a published query in a workspace (granted roles); capped, timed out and logged',
    request: { params: z.object({ ws, id: qid }), ...body(z.object({ params: z.record(z.unknown()).optional(), version: z.number().int().optional() })) },
    responses: {
      200: json(RunResult, 'Result table'),
      ...writeErrors,
      409: json(ErrorSchema, 'Version not runnable or fingerprint mismatch'),
    },
  });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'D4 API',
      version: '0.1.0',
      description:
        'Commands and reads for the D4 design-to-delivery graph. Graph-shaped reads are also available via GraphQL at /graphql.',
    },
  });
}

@Controller()
export class OpenApiController {
  private readonly document: OpenApiDocument = buildOpenApiDocument();

  @Public()
  @Get('v1/openapi.json')
  openapi(): OpenApiDocument {
    return this.document;
  }
}
