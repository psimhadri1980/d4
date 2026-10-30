import { ErrorSchema } from '../http/zod';
import { json, errors, ws, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for Workspaces. */
export function registerWorkspaceRoutes(route: ApiRoute) {
  route({
    method: 'get',
    path: '/v1/me',
    tags: ['Workspaces'],
    summary: 'The caller: D4 user id, tenant, effective tenant-wide roles, and whether the tenant graph is reachable',
    responses: {
      200: json(
        z.object({ subject: z.string(), userId: z.string(), tenantId: z.string(), roles: z.array(z.string()), graph: z.enum(['ok', 'unreachable']) }).openapi('Me'),
        'The caller',
      ),
      401: json(ErrorSchema, 'Missing or invalid token'),
    },
  });

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
}
