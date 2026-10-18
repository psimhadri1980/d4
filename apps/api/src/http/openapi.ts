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
    request: { params: z.object({ ws }) },
    responses: { 200: json(ModelDocumentSchema, 'The workspace as a model document'), ...errors },
  });

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
