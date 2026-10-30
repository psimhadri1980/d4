import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { CONNECTOR_KINDS, Mapping } from '@d4/connectors';
import { ConnectorStore, JobStore, type ConnectorRow } from '@d4/db';
import { assertJobQuota, Cadence, checkWebhookUrl, describeCadence, nextRun } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { APP_CONFIG, type AppConfig } from '../config';
import { parse } from '../http/errors';
import { z } from '../http/zod';
import { Database } from '../infra/database.service';
import { JobsInfra } from '../infra/jobs.service';
import { jobView } from '../jobs/jobs.controller';
import { WorkspaceAccess } from '../workspaces/workspace-access.service';
import { ValidBody } from '../http/zod.pipe';

const fields = {
  name: z.string().trim().min(1).max(120),
  config: z.record(z.unknown()),
  /** Required for record kinds (http-json); model kinds (git) need none. */
  mapping: z.unknown().optional(),
  /** Token or user:password, depending on the source's auth; null clears it. Never returned. */
  secret: z.string().min(1).max(4000).nullable(),
  conflictPolicy: z.enum(['skip', 'source-wins']),
  cadence: Cadence.nullable(),
  enabled: z.boolean(),
};
const CreateConnector = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/, 'lowercase letters, digits and dashes; it prefixes external keys'),
    kind: z.string(),
    ...fields,
    secret: fields.secret.optional(),
    conflictPolicy: fields.conflictPolicy.default('skip'),
    cadence: fields.cadence.default(null),
    enabled: fields.enabled.default(true),
  })
  .strict();
const UpdateConnector = z.object(fields).partial().strict();
const SyncBody = z.object({ dryRun: z.boolean().default(false) }).strict();

/**
 * Connectors (admin only): external systems synced into the workspace. Each sync is a background
 * job; its result lists what changed, conflicts with edits made in D4, and source problems.
 */
@Controller('v1/workspaces/:ws/connectors')
export class ConnectorsController {
  constructor(
    @Inject(ConnectorStore) private readonly connectorStore: ConnectorStore,
    @Inject(JobStore) private readonly jobStore: JobStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(Database) private readonly database: Database,
    @Inject(JobsInfra) private readonly infra: JobsInfra,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('kinds')
  kinds() {
    return Object.entries(CONNECTOR_KINDS).map(([kind, k]) => ({ kind, name: k.name, description: k.description }));
  }

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    const scope = await this.scope(p, ws);
    return (await this.connectorStore.list(scope.tenantId, scope.workspaceId)).map(view);
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @ValidBody(CreateConnector) b: z.output<typeof CreateConnector>) {
    const scope = await this.scope(p, ws);
    const kind = CONNECTOR_KINDS[b.kind];
    if (!kind) throw new BadRequestException(`Unknown connector kind '${b.kind}'; known: ${Object.keys(CONNECTOR_KINDS).join(', ')}`);
    const config = await this.checkConfig(b.kind, b.config);
    if (await this.connectorStore.byKey(scope.tenantId, scope.workspaceId, b.key)) throw new ConflictException(`A connector with key '${b.key}' already exists`);
    const row = await this.connectorStore.create(scope.tenantId, {
      workspaceId: scope.workspaceId,
      key: b.key,
      name: b.name,
      kind: b.kind,
      config,
      mapping: kind.mode === 'records' ? parse(Mapping, b.mapping) : {},
      secret: b.secret ?? null,
      conflictPolicy: b.conflictPolicy,
      cadence: b.cadence,
      nextRunAt: b.cadence ? nextRun(b.cadence, new Date()) : null,
      enabled: b.enabled,
      createdBy: p.userId,
    });
    return view(row);
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    return view(await this.find(p, ws, id));
  }

  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @ValidBody(UpdateConnector) b: z.output<typeof UpdateConnector>) {
    const row = await this.find(p, ws, id);
    const changes = {
      ...(b.name !== undefined && { name: b.name }),
      ...(b.config !== undefined && { config: await this.checkConfig(row.kind, b.config) }),
      ...(b.mapping !== undefined && CONNECTOR_KINDS[row.kind]?.mode === 'records' && { mapping: parse(Mapping, b.mapping) }),
      ...(b.secret !== undefined && { secret: b.secret }),
      ...(b.conflictPolicy !== undefined && { conflictPolicy: b.conflictPolicy }),
      ...(b.enabled !== undefined && { enabled: b.enabled }),
      ...(b.cadence !== undefined && { cadence: b.cadence, nextRunAt: b.cadence ? nextRun(b.cadence, new Date()) : null }),
    };
    return view((await this.connectorStore.update(row.tenantId, id, changes))!);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const row = await this.find(p, ws, id);
    // The elements it brought in stay; they keep their external keys.
    await this.connectorStore.remove(row.tenantId, id);
  }

  /** Starts a sync (or a dry run that only reports what would change). */
  @Post(':id/sync')
  @HttpCode(202)
  async sync(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    const row = await this.find(p, ws, id);
    const { dryRun } = parse(SyncBody, body ?? {});
    await assertJobQuota(this.database.db, row.tenantId);
    const job = await this.jobStore.create(row.tenantId, { workspaceId: row.workspaceId, kind: 'sync', params: { connectorId: id, dryRun }, createdBy: p.userId });
    await this.infra.queue.enqueue({ tenantId: row.tenantId, jobId: job.id });
    if (!dryRun) await this.connectorStore.recordRun(row.tenantId, id, job.id, new Date());
    return jobView(job);
  }

  @Get(':id/runs')
  async runs(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const row = await this.find(p, ws, id);
    return (await this.jobStore.syncRuns(row.tenantId, row.workspaceId, id)).map(jobView);
  }

  private async scope(p: Principal, ws: string) {
    if (!p.roles.includes('admin')) throw new ForbiddenException('Connectors need the admin role');
    return this.access.resolve(p, ws, 'read');
  }

  private async find(p: Principal, ws: string, id: string): Promise<ConnectorRow> {
    const scope = await this.scope(p, ws);
    const row = await this.connectorStore.get(scope.tenantId, scope.workspaceId, id);
    if (!row) throw new NotFoundException(`Connector '${id}' not found`);
    return row;
  }

  private async checkConfig(kind: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = parse(CONNECTOR_KINDS[kind]!.config, config) as Record<string, unknown>;
    if (typeof parsed['url'] === 'string') {
      // Local repositories (file://) only where private addresses are allowed: local development.
      if (parsed['url'].startsWith('file://')) {
        if (!this.config.WEBHOOK_ALLOW_PRIVATE) throw new BadRequestException('file:// repositories are only allowed in local development');
        return parsed;
      }
      const bad = await checkWebhookUrl(parsed['url'], this.config.WEBHOOK_ALLOW_PRIVATE);
      if (bad) throw new BadRequestException(`Source URL ${bad}`);
    }
    return parsed;
  }
}

const view = (c: ConnectorRow) => ({
  id: c.id,
  key: c.key,
  name: c.name,
  kind: c.kind,
  config: c.config,
  mapping: c.mapping,
  hasSecret: !!c.secret,
  conflictPolicy: c.conflictPolicy,
  cadence: c.cadence,
  cadenceText: c.cadence ? describeCadence(Cadence.parse(c.cadence)) : null,
  nextRunAt: c.enabled ? (c.nextRunAt?.toISOString() ?? null) : null,
  enabled: c.enabled,
  lastJobId: c.lastJobId,
  lastRunAt: c.lastRunAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});
