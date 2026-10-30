import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import { JobStore, type JobRow } from '@d4/db';
import { assertJobQuota, inputKey, RenderParams, type TabularJobInput } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { ExportQuery, TabularImportBody, z } from '../http/schemas';
import { Database } from '../infra/database.service';
import { JobsInfra } from '../infra/jobs.service';
import { resolveView } from './view';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

interface Reply {
  header(name: string, value: string): unknown;
}

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });
const ListQuery = z.object({ all: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).optional() });

/** What users see of a job; inputs (uploads) are not echoed back. */
export function jobView(j: JobRow) {
  const params = { ...(j.params as Record<string, unknown>) };
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    progress: j.progress,
    params,
    result: j.result,
    error: j.error,
    // No file once it expired (artifactKey cleared by pruning).
    artifact: j.kind !== 'import-tabular' && j.status === 'succeeded' && j.artifactKey && j.artifactName ? { name: j.artifactName, type: j.artifactType, bytes: j.artifactBytes } : null,
    attempts: j.attempts,
    scheduleId: j.scheduleId,
    createdBy: j.createdBy,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

/**
 * Background jobs for large exports and spreadsheet imports. Submitting needs the same access as
 * doing the work directly (read for exports and dry runs, write to apply an import); the worker
 * then acts as the submitting user. Users see their own jobs; admins see everyone's.
 */
@Controller('v1/workspaces/:ws/jobs')
export class JobsController {
  constructor(
    @Inject(JobStore) private readonly jobStore: JobStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
    @Inject(Database) private readonly database: Database,
    @Inject(JobsInfra) private readonly infra: JobsInfra,
  ) {}

  @Post('export')
  @HttpCode(202)
  async export(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const q = parse(ExportQuery, body ?? {});
    const scope = await this.access.resolve(p, ws, 'read');
    // Check the scenario now, so a typo fails here rather than in the worker.
    await resolveView(this.models.for(scope).queries, scope.registry, scope.workspaceId, q);
    const queue = this.infra.queue;
    await assertJobQuota(this.database.db, scope.tenantId);
    const job = await this.jobStore.create(scope.tenantId, {
      workspaceId: scope.workspaceId,
      kind: 'export',
      params: { ...q, format: q.format ?? 'yaml' },
      createdBy: p.userId,
    });
    await queue.enqueue({ tenantId: scope.tenantId, jobId: job.id });
    return jobView(job);
  }

  /** A picture of a roadmap or a graph view: SVG, PNG or PDF (rendered with Chromium). */
  @Post('render')
  @HttpCode(202)
  async render(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const params = parse(RenderParams, body);
    const scope = await this.access.resolve(p, ws, 'read');
    const { queries } = this.models.for(scope);
    if (params.target === 'graph') {
      await resolveView(queries, scope.registry, scope.workspaceId, params);
      if (!(await queries.getElement(scope.workspaceId, params.root))) throw new NotFoundException(`Element '${params.root}' not found`);
    }
    const queue = this.infra.renderQueue;
    await assertJobQuota(this.database.db, scope.tenantId);
    const job = await this.jobStore.create(scope.tenantId, { workspaceId: scope.workspaceId, kind: 'render', params, createdBy: p.userId });
    await queue.enqueue({ tenantId: scope.tenantId, jobId: job.id });
    return jobView(job);
  }

  @Post('import-tabular')
  @HttpCode(202)
  async importTabular(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown, @Body() body: unknown) {
    const dryRun = parse(ImportQuery, query).dryRun === 'true';
    const { files, mappings } = parse(TabularImportBody, body);
    const scope = await this.access.resolve(p, ws, dryRun ? 'read' : 'write');
    const { queue, artifacts } = this.infra;
    await assertJobQuota(this.database.db, scope.tenantId);
    const store = this.jobStore;
    const job = await store.create(scope.tenantId, {
      workspaceId: scope.workspaceId,
      kind: 'import-tabular',
      params: { dryRun, files: files.map((f) => f.name) },
      createdBy: p.userId,
    });
    const input: TabularJobInput = { files, mappings: mappings as TabularJobInput['mappings'] };
    const bytes = await artifacts.put(inputKey(job.id), JSON.stringify(input), 'application/json');
    await store.setArtifact(scope.tenantId, job.id, { key: inputKey(job.id), name: 'input.json', type: 'application/json', bytes });
    await queue.enqueue({ tenantId: scope.tenantId, jobId: job.id });
    return jobView(job);
  }

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(ListQuery, query);
    const scope = await this.access.resolve(p, ws, 'read');
    const everyone = q.all === 'true' && p.roles.includes('admin');
    const rows = await this.jobStore.list(scope.tenantId, scope.workspaceId, {
      ...(!everyone && { createdBy: p.userId }),
      limit: q.limit ?? 50,
    });
    return rows.map(jobView);
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    return jobView(await this.visible(p, ws, id));
  }

  /** The export file, streamed through the API so access checks apply. */
  @Get(':id/artifact')
  async artifact(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Res({ passthrough: true }) reply: Reply) {
    const job = await this.visible(p, ws, id);
    if (job.kind === 'import-tabular' || job.status !== 'succeeded' || !job.artifactKey) {
      throw new NotFoundException(`Job '${id}' has no file to download`);
    }
    const body = await this.infra.artifacts.get(job.artifactKey);
    reply.header('content-type', job.artifactType ?? 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${job.artifactName ?? 'export'}"`);
    return Buffer.from(body);
  }

  private async visible(p: Principal, ws: string, id: string): Promise<JobRow> {
    const scope = await this.access.resolve(p, ws, 'read');
    const job = await this.jobStore.get(scope.tenantId, id);
    if (!job || job.workspaceId !== scope.workspaceId) throw new NotFoundException(`Job '${id}' not found`);
    if (job.createdBy !== p.userId && !p.roles.includes('admin')) throw new ForbiddenException(`Job '${id}' belongs to another user`);
    return job;
  }
}
