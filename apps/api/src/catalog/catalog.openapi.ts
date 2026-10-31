import { ErrorSchema } from '../http/zod';
import { json, errors, writeErrors, ws, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for the Query Catalog. */
export function registerCatalogRoutes(route: ApiRoute) {
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
  // Same shape as QueryParamDef in @d4/cypher.
  const QueryParam = z
    .object({
      name: z.string(),
      type: z.enum(['string', 'number', 'integer', 'boolean', 'date', 'enum', 'element', 'string[]']),
      label: z.string().optional(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      default: z.unknown().optional(),
      values: z.array(z.string()).optional().describe('Allowed values for enum'),
      elementTypes: z.array(z.string()).optional().describe('For element: types offered by the picker'),
    })
    .openapi('QueryParam');
  const QueryVersion = z
    .object({
      id: z.string(),
      version: z.number().int(),
      status: z.enum(['draft', 'in_review', 'published', 'deprecated', 'retired']),
      cypher: z.string(),
      params: z.array(QueryParam),
      resultShape: z.enum(['table', 'graph']),
      contentHash: z.string(),
      checks: z.object({ errors: z.array(z.string()), warnings: z.array(z.string()) }).nullable(),
      createdBy: z.string(),
      createdAt: z.string(),
      submittedAt: z.string().nullable(),
      reviewedBy: z.string().nullable(),
      reviewedAt: z.string().nullable(),
      reviewNote: z.string().nullable(),
      publishedAt: z.string().nullable(),
    })
    .openapi('QueryVersion');
  const Execution = z
    .object({
      seq: z.number().int(),
      queryId: z.string(),
      version: z.number().int(),
      workspaceId: z.string(),
      userId: z.string(),
      params: z.record(z.unknown()),
      status: z.enum(['ok', 'error', 'timeout']),
      rowCount: z.number().int().nullable(),
      durationMs: z.number().int(),
      error: z.string().nullable(),
      executedAt: z.string(),
    })
    .openapi('QueryExecution');
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
    responses: { 200: json(z.array(Execution), 'Execution log, newest first (at most 50)'), ...errors },
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
}
