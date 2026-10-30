import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { JobStore, ScheduleStore, type ScheduleRow } from '@d4/db';
import { Cadence, describeCadence, nextRun, startScheduledRun, validateScheduleParams } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/schemas';
import { Database } from '../infra/database.service';
import { JobsInfra } from '../infra/jobs.service';
import { jobView } from './jobs.controller';
import { ModelFactory } from './model.factory';
import { resolveView } from './view';
import { WorkspaceAccess } from './workspace-access.service';

const CreateBody = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['export', 'render']),
  params: z.record(z.unknown()),
  useRunDate: z.boolean().default(true),
  cadence: Cadence,
  recipients: z.array(z.string().trim().toLowerCase().email()).max(20).default([]),
});
const UpdateBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    cadence: Cadence.optional(),
    enabled: z.boolean().optional(),
    useRunDate: z.boolean().optional(),
    recipients: z.array(z.string().trim().toLowerCase().email()).max(20).optional(),
  })
  .strict();
const ListQuery = z.object({ all: z.enum(['true', 'false']).optional() });

/**
 * Scheduled reports: an export or a picture produced on a cadence by the worker, as the owner.
 * Owners (and admins) manage their schedules; runs appear as jobs on the Jobs page.
 */
@Controller('v1/workspaces/:ws/schedules')
export class SchedulesController {
  constructor(
    @Inject(JobStore) private readonly jobStore: JobStore,
    @Inject(ScheduleStore) private readonly scheduleStore: ScheduleStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
    @Inject(Database) private readonly database: Database,
    @Inject(JobsInfra) private readonly infra: JobsInfra,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const everyone = parse(ListQuery, query).all === 'true' && p.roles.includes('admin');
    const scope = await this.access.resolve(p, ws, 'read');
    const rows = await this.scheduleStore.list(scope.tenantId, scope.workspaceId, everyone ? {} : { createdBy: p.userId });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const b = parse(CreateBody, body);
    const scope = await this.access.resolve(p, ws, 'read');
    const params = validateScheduleParams(b.kind, b.params);
    // Check what can be checked now, so a schedule does not fail on every run.
    const { queries } = this.models.for(scope);
    if (b.kind === 'export' || params['target'] === 'graph') await resolveView(queries, scope.registry, scope.workspaceId, params);
    if (params['target'] === 'graph' && !(await queries.getElement(scope.workspaceId, String(params['root'])))) {
      throw new NotFoundException(`Element '${String(params['root'])}' not found`);
    }
    const row = await this.scheduleStore.create(scope.tenantId, {
      workspaceId: scope.workspaceId,
      name: b.name,
      kind: b.kind,
      params,
      useRunDate: b.useRunDate,
      cadence: b.cadence,
      nextRunAt: nextRun(b.cadence, new Date()),
      createdBy: p.userId,
      recipients: [...new Set(b.recipients)],
    });
    return this.view(row);
  }

  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const b = parse(UpdateBody, body);
    const { row, tenantId } = await this.own(p, ws, id);
    const cadence = b.cadence ?? Cadence.parse(row.cadence);
    // A new cadence, or resuming, counts from now rather than running missed slots.
    const reschedule = !!b.cadence || (b.enabled === true && !row.enabled);
    const updated = await this.scheduleStore.update(tenantId, id, {
      ...b,
      ...(b.recipients && { recipients: [...new Set(b.recipients)] }),
      ...(reschedule && { nextRunAt: nextRun(cadence, new Date()) }),
      // Any change by a person (resume, pause) replaces a pause the system made.
      ...(b.enabled !== undefined && { pausedReason: null }),
    });
    return this.view(updated!);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { tenantId } = await this.own(p, ws, id);
    await this.scheduleStore.remove(tenantId, id);
  }

  /** Runs the report now, outside the cadence (the next scheduled run is unchanged). */
  @Post(':id/run')
  @HttpCode(202)
  async run(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { row, tenantId } = await this.own(p, ws, id);
    const jobId = await startScheduledRun(this.database.db, { jobs: this.infra.queue, render: this.infra.renderQueue }, row, new Date());
    return jobView((await this.jobStore.get(tenantId, jobId))!);
  }

  private async own(p: Principal, ws: string, id: string): Promise<{ row: ScheduleRow; tenantId: string }> {
    const scope = await this.access.resolve(p, ws, 'read');
    const row = await this.scheduleStore.get(scope.tenantId, id);
    if (!row || row.workspaceId !== scope.workspaceId) throw new NotFoundException(`Schedule '${id}' not found`);
    if (row.createdBy !== p.userId && !p.roles.includes('admin')) throw new ForbiddenException(`Schedule '${id}' belongs to another user`);
    return { row, tenantId: scope.tenantId };
  }

  private async view(r: ScheduleRow) {
    const cadence = Cadence.parse(r.cadence);
    const last = r.lastJobId ? await this.jobStore.get(r.tenantId, r.lastJobId) : undefined;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      params: r.params,
      useRunDate: r.useRunDate,
      cadence,
      cadenceText: describeCadence(cadence),
      enabled: r.enabled,
      pausedReason: r.pausedReason,
      recipients: r.recipients,
      nextRunAt: r.enabled ? r.nextRunAt.toISOString() : null,
      lastRunAt: r.lastRunAt?.toISOString() ?? null,
      lastJob: last ? jobView(last) : null,
      createdBy: r.createdBy,
    };
  }
}
