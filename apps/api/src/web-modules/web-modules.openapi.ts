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
  const version = z.string().openapi({ param: { name: 'version', in: 'path' } });
  const sha256 = z.string().describe('SHA-256 of the file, hex');
  const Release = z
    .object({
      manifest: z.object({
        name: z.string(),
        version: z.string().describe('Semantic version; a released version never changes'),
        contract: z.number(),
        entry: z.string().describe('Path of the entry file within the release'),
        framework: z.enum(['react', 'vanilla', 'other']),
        shared: z.record(z.string(), z.string()).optional().describe("Major versions of the shell's shared packages the module was built against"),
        files: z.record(z.string(), sha256),
      }),
      files: z.record(z.string(), z.string().describe('File content, base64')),
    })
    .openapi('WebModuleRelease');
  const Published = z.object({ entry: z.string(), version: z.string(), contract: z.number(), framework: z.enum(['react', 'vanilla', 'other']) }).openapi('WebModuleReleased');
  route({ method: 'get', path: '/v1/admin/web-modules/{name}/releases', tags: ['Web modules'], summary: "This tenant's uploaded releases of a module, oldest first (admin)", request: { params: z.object({ name }) }, responses: { 200: json(z.array(z.object({ version: z.string(), active: z.boolean() })).openapi('WebModuleReleaseList'), 'Versions'), ...errors } });
  route({ method: 'post', path: '/v1/admin/web-modules/{name}/releases', tags: ['Web modules'], summary: 'Upload a release: checked, stored immutably; activate it with PUT (admin)', request: { params: z.object({ name }), body: { content: { 'application/json': { schema: Release } } } }, responses: { 201: json(Published, 'Stored'), 409: { description: 'Version already released' }, ...errors } });
  route({ method: 'delete', path: '/v1/admin/web-modules/{name}/releases/{version}', tags: ['Web modules'], summary: 'Delete an uploaded release that is not active (admin)', request: { params: z.object({ name, version }) }, responses: { 204: { description: 'Deleted' }, 409: { description: 'Active version' }, ...errors } });
  route({ method: 'delete', path: '/v1/admin/web-modules/{name}', tags: ['Web modules'], summary: 'Remove a web module (admin)', request: { params: z.object({ name }) }, responses: { 204: { description: 'Removed' }, ...errors } });
}
