import { json, errors, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for the web module registry. */
export function registerWebModuleRoutes(route: ApiRoute) {
  const name = z.string().openapi({ param: { name: 'name', in: 'path' } });
  const WebModule = z
    .object({ name: z.string(), title: z.string(), description: z.string().nullable(), owner: z.string().nullable(), entry: z.string(), version: z.string(), contract: z.number(), framework: z.enum(['react', 'vanilla', 'other']), enabled: z.boolean(), updatedAt: z.string() })
    .openapi('WebModule');
  const Body = z.object({ title: z.string(), description: z.string().nullable().optional(), owner: z.string().nullable().optional(), entry: z.string().describe('Same-origin path under /mfe/<name>/'), version: z.string(), contract: z.number(), framework: z.enum(['react', 'vanilla', 'other']), enabled: z.boolean().optional() });
  route({
    method: 'get',
    path: '/v1/web-modules',
    tags: ['Web modules'],
    summary: 'Enabled web modules the shell loads (ETag; 304 when unchanged)',
    responses: { 200: json(z.object({ modules: z.array(z.object({ name: z.string(), title: z.string(), entry: z.string(), version: z.string(), contract: z.number() })) }).openapi('WebModuleList'), 'Enabled modules'), 304: { description: 'Unchanged' }, ...errors },
  });
  route({ method: 'get', path: '/v1/admin/web-modules', tags: ['Web modules'], summary: 'Every registered web module (admin)', responses: { 200: json(z.array(WebModule), 'Modules'), ...errors } });
  route({ method: 'put', path: '/v1/admin/web-modules/{name}', tags: ['Web modules'], summary: 'Register a web module or record a new release (admin)', request: { params: z.object({ name }), body: { content: { 'application/json': { schema: Body } } } }, responses: { 200: json(WebModule, 'Registered'), ...errors } });
  route({ method: 'delete', path: '/v1/admin/web-modules/{name}', tags: ['Web modules'], summary: 'Remove a web module (admin)', request: { params: z.object({ name }) }, responses: { 204: { description: 'Removed' }, ...errors } });
}
