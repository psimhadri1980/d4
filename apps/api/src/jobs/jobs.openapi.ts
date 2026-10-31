import { ExportQuery, TabularImportBody } from '../model/model.schemas';
import { json, errors, writeErrors, ws, type ApiRoute } from '../http/api-doc';
import { z } from '../http/zod';

/** A background job, as the jobs, backups and connector endpoints return it. */
export const JobSchema = z.object({ id: z.string(), kind: z.enum(['export', 'import-tabular', 'render', 'backup', 'verify', 'restore', 'rebuild', 'sync']), status: z.enum(['queued', 'running', 'succeeded', 'failed']), progress: z.number(), params: z.record(z.unknown()), result: z.record(z.unknown()).nullable(), error: z.string().nullable(), artifact: z.object({ name: z.string(), type: z.string().nullable(), bytes: z.number().nullable() }).nullable(), attempts: z.number(), scheduleId: z.string().nullable().describe('Set when a schedule started the job'), createdBy: z.string(), createdAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable() }).openapi('Job');

/** OpenAPI paths for jobs and scheduled reports. */
export function registerJobRoutes(route: ApiRoute) {
  const jobPath = '/v1/workspaces/{ws}/jobs';
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
}
