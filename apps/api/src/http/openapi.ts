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
