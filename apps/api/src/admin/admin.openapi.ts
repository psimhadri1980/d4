import { JobSchema } from '../jobs/jobs.openapi';
import { json, errors, ws, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** OpenAPI paths for administration, usage and backups. */
export function registerAdminRoutes(route: ApiRoute) {
  const AdminWorkspace = z.object({ id: z.string(), slug: z.string(), name: z.string(), description: z.string().nullable(), archived: z.boolean(), metamodel: z.string().nullable().describe('name@version') }).openapi('AdminWorkspace');
  const Member = z.object({ principalType: z.enum(['user', 'group']), principalId: z.string(), label: z.string(), role: z.string(), createdBy: z.string(), createdAt: z.string() }).openapi('Member');
  const BindingBody = z.object({ principalType: z.enum(['user', 'group']).optional(), principalId: z.string(), role: z.string() });
  const wsOrTenant = z.string().openapi({ param: { name: 'ws', in: 'path' }, description: 'Workspace id, or "tenant" for tenant-wide roles' });
  route({ method: 'get', path: '/v1/admin/workspaces', tags: ['Administration'], summary: 'Workspaces (?archived=true to include archived)', request: { query: z.object({ archived: z.enum(['true', 'false']).optional() }) }, responses: { 200: json(z.array(AdminWorkspace), 'Workspaces'), ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces', tags: ['Administration'], summary: 'Create a workspace on the active metamodel, or on an industry pack', request: { body: { content: { 'application/json': { schema: z.object({ slug: z.string(), name: z.string(), description: z.string().optional(), metamodel: z.enum(['d4-starter', 'd4-banking', 'd4-insurance']).optional() }) } } } }, responses: { 201: json(AdminWorkspace, 'Created'), ...errors } });
  route({ method: 'patch', path: '/v1/admin/workspaces/{ws}', tags: ['Administration'], request: { params: z.object({ ws }), body: { content: { 'application/json': { schema: z.object({ name: z.string().optional(), description: z.string().nullable().optional() }) } } } }, responses: { 200: json(AdminWorkspace, 'Updated'), ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces/{ws}/archive', tags: ['Administration'], request: { params: z.object({ ws }) }, responses: { 204: { description: 'Archived' }, ...errors } });
  route({ method: 'post', path: '/v1/admin/workspaces/{ws}/restore', tags: ['Administration'], request: { params: z.object({ ws }) }, responses: { 204: { description: 'Restored' }, ...errors } });
  route({ method: 'get', path: '/v1/admin/metamodel-packs', tags: ['Administration'], summary: 'Metamodels a new workspace can start from (starter and industry packs)', responses: { 200: json(z.array(z.object({ id: z.string(), version: z.string(), description: z.string(), addedNodeTypes: z.number(), addedRelationshipTypes: z.number() })), 'Packs'), ...errors } });
  route({ method: 'get', path: '/v1/admin/users', tags: ['Administration'], summary: 'Users of the tenant (they appear after their first sign-in)', responses: { 200: json(z.array(z.object({ id: z.string(), email: z.string().nullable(), displayName: z.string().nullable(), realmRoles: z.array(z.string()), lastSeenAt: z.string() })), 'Users'), ...errors } });
  route({ method: 'get', path: '/v1/admin/members/{ws}', tags: ['Administration'], request: { params: z.object({ ws: wsOrTenant }) }, responses: { 200: json(z.array(Member), 'Role bindings'), ...errors } });
  route({ method: 'post', path: '/v1/admin/members/{ws}', tags: ['Administration'], summary: 'Grant a role', request: { params: z.object({ ws: wsOrTenant }), body: { content: { 'application/json': { schema: BindingBody } } } }, responses: { 204: { description: 'Granted' }, ...errors } });
  route({ method: 'delete', path: '/v1/admin/members/{ws}', tags: ['Administration'], summary: 'Revoke a role', request: { params: z.object({ ws: wsOrTenant }), body: { content: { 'application/json': { schema: BindingBody } } } }, responses: { 204: { description: 'Revoked' }, ...errors } });
  route({
    method: 'get',
    path: '/v1/admin/usage',
    tags: ['Administration'],
    summary: 'Usage against the tenant limits, and daily readings for the last 30 days',
    responses: {
      200: json(
        z.object({
          metrics: z.array(z.object({ metric: z.enum(['elements', 'relationships', 'workspaces', 'queryRunsPerDay', 'jobsPerDay', 'storageBytes']), used: z.number(), limit: z.number().nullable().describe('null: unlimited') })),
          history: z.array(z.object({ day: z.string(), metric: z.string(), value: z.number() })),
        }),
        'Usage',
      ),
      ...errors,
    },
  });
  const BackupSchema = z
    .object({ id: z.string(), reason: z.enum(['manual', 'scheduled', 'safety']), bytes: z.number(), elements: z.number(), relationships: z.number(), eventSeq: z.number(), checksum: z.string(), jobId: z.string().nullable(), createdBy: z.string(), createdAt: z.string() })
    .openapi('Backup');
  const bkPath = '/v1/workspaces/{ws}/backups';
  const ConfirmBody = { body: { content: { 'application/json': { schema: z.object({ confirm: z.string().describe("The workspace's slug") }) } } } };
  route({ method: 'get', path: bkPath, tags: ['Backups'], summary: 'Backups of the workspace graph, newest first (admin)', request: { params: z.object({ ws }) }, responses: { 200: json(z.array(BackupSchema), 'Backups'), ...errors } });
  route({ method: 'post', path: bkPath, tags: ['Backups'], summary: 'Start a backup job (admin)', request: { params: z.object({ ws }) }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });
  route({ method: 'post', path: `${bkPath}/verify`, tags: ['Backups'], summary: 'Start a job that replays the event log and compares it with the graph (admin)', request: { params: z.object({ ws }) }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });
  route({ method: 'post', path: `${bkPath}/rebuild`, tags: ['Backups'], summary: 'Replace the graph with the replayed event log (admin; locks writes, takes a safety backup first)', request: { params: z.object({ ws }), ...ConfirmBody }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });
  route({ method: 'post', path: `${bkPath}/{id}/restore`, tags: ['Backups'], summary: 'Restore a backup, then replay every event recorded after it (admin; locks writes, takes a safety backup first)', request: { params: z.object({ ws, id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }), ...ConfirmBody }, responses: { 202: json(JobSchema, 'Started job'), ...errors } });
}
