import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { BackupStore, JobStore, WorkspaceStore, type BackupRow, type JobKind } from '@d4/db';
import { assertJobQuota } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/zod';
import { Database } from '../infra/database.service';
import { JobsInfra } from '../infra/jobs.service';
import { jobView } from '../jobs/jobs.controller';
import { WorkspaceAccess } from '../workspaces/workspace-access.service';

/** Destructive operations must name the workspace they replace, so a wrong tab cannot do it. */
const Confirm = z.object({ confirm: z.string() }).strict();

/**
 * Backups of one workspace's graph (admin only). Every operation runs as a background job:
 * backup (snapshot to object storage), verify (replay the event log and compare with the graph),
 * restore (snapshot plus the events after it) and rebuild (the event log alone). Restore and
 * rebuild lock the workspace and take a safety backup first.
 */
@Controller('v1/workspaces/:ws/backups')
export class BackupsController {
  constructor(
    @Inject(BackupStore) private readonly backupStore: BackupStore,
    @Inject(JobStore) private readonly jobStore: JobStore,
    @Inject(WorkspaceStore) private readonly workspaceStore: WorkspaceStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(Database) private readonly database: Database,
    @Inject(JobsInfra) private readonly infra: JobsInfra,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    const scope = await this.scope(p, ws);
    return (await this.backupStore.list(scope.tenantId, scope.workspaceId)).map(view);
  }

  @Post()
  @HttpCode(202)
  async backup(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    return this.start(p, ws, 'backup', {});
  }

  @Post('verify')
  @HttpCode(202)
  async verify(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    return this.start(p, ws, 'verify', {});
  }

  @Post('rebuild')
  @HttpCode(202)
  async rebuild(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    await this.confirmed(p, ws, body);
    return this.start(p, ws, 'rebuild', {});
  }

  @Post(':id/restore')
  @HttpCode(202)
  async restore(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const scope = await this.confirmed(p, ws, body);
    if (!(await this.backupStore.get(scope.tenantId, scope.workspaceId, id))) throw new NotFoundException(`Backup '${id}' not found`);
    return this.start(p, ws, 'restore', { backupId: id });
  }

  private async scope(p: Principal, ws: string) {
    if (!p.roles.includes('admin')) throw new ForbiddenException('Backups need the admin role');
    return this.access.resolve(p, ws, 'read');
  }

  private async confirmed(p: Principal, ws: string, body: unknown) {
    const scope = await this.scope(p, ws);
    const row = await this.workspaceStore.get(scope.tenantId, scope.workspaceId);
    if (parse(Confirm, body ?? {}).confirm !== row!.slug) throw new BadRequestException(`Type the workspace slug '${row!.slug}' to confirm`);
    return scope;
  }

  private async start(p: Principal, ws: string, kind: JobKind, params: Record<string, unknown>) {
    const scope = await this.scope(p, ws);
    await assertJobQuota(this.database.db, scope.tenantId);
    const job = await this.jobStore.create(scope.tenantId, { workspaceId: scope.workspaceId, kind, params, createdBy: p.userId });
    await this.infra.queue.enqueue({ tenantId: scope.tenantId, jobId: job.id });
    return jobView(job);
  }
}

const view = (b: BackupRow) => ({
  id: b.id,
  reason: b.reason,
  bytes: b.bytes,
  elements: b.elements,
  relationships: b.relationships,
  eventSeq: b.eventSeq,
  checksum: b.checksum,
  jobId: b.jobId,
  createdBy: b.createdBy,
  createdAt: b.createdAt.toISOString(),
});
