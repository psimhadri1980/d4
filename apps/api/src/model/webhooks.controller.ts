import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { DOMAIN_EVENT_TYPES } from '@d4/core';
import { WorkspaceStore, WebhookStore, type DeliveryRow, type WebhookRow } from '@d4/db';
import { checkWebhookUrl, newWebhookSecret } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { APP_CONFIG, type AppConfig } from '../config';
import { parse } from '../http/errors';
import { z } from '../http/schemas';
import { Database } from '../infra/database.service';

const fields = {
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(2000),
  /** Workspace id or slug; omitted or null for every workspace. */
  workspace: z.string().min(1).nullable(),
  eventTypes: z.array(z.enum(DOMAIN_EVENT_TYPES)).max(DOMAIN_EVENT_TYPES.length),
};
const CreateWebhook = z.object({ ...fields, workspace: fields.workspace.optional(), eventTypes: fields.eventTypes.default([]) }).strict();
const UpdateWebhook = z.object({ ...fields, enabled: z.boolean() }).partial().strict();

/**
 * Webhooks (admin only): HTTPS endpoints that receive model events, signed with a per-webhook
 * secret. The worker relays events from the outbox and retries failed deliveries. The secret is
 * shown when the webhook is created or its secret is rotated, and never again.
 */
@Controller('v1/admin/webhooks')
export class WebhooksController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal) {
    this.admin(p);
    return (await this.store().list(p.tenantId)).map(view);
  }

  @Get('event-types')
  eventTypes(@CurrentPrincipal() p: Principal) {
    this.admin(p);
    return DOMAIN_EVENT_TYPES;
  }

  @Post()
  @HttpCode(201)
  async create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    this.admin(p);
    const b = parse(CreateWebhook, body);
    await this.checkUrl(b.url);
    const secret = newWebhookSecret();
    const row = await this.store().create(p.tenantId, {
      name: b.name,
      url: b.url,
      secret,
      eventTypes: b.eventTypes,
      workspaceId: await this.workspace(p, b.workspace ?? null),
      createdBy: p.userId,
    });
    return { ...view(row), secret };
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    this.admin(p);
    return view(await this.find(p, id));
  }

  @Patch(':id')
  async update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    this.admin(p);
    const b = parse(UpdateWebhook, body);
    await this.find(p, id);
    if (b.url) await this.checkUrl(b.url);
    const { workspace, ...rest } = b;
    const row = await this.store().update(p.tenantId, id, {
      ...rest,
      ...(workspace !== undefined && { workspaceId: await this.workspace(p, workspace) }),
      ...(b.enabled === false && { disabledReason: null }),
    });
    return view(row!);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    this.admin(p);
    if (!(await this.store().remove(p.tenantId, id))) throw new NotFoundException(`Webhook '${id}' not found`);
  }

  /** Replaces the signing secret; receivers must switch to the new one. */
  @Post(':id/rotate-secret')
  async rotate(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    this.admin(p);
    await this.find(p, id);
    const secret = newWebhookSecret();
    const row = await this.store().update(p.tenantId, id, { secret });
    return { ...view(row!), secret };
  }

  /** Queues a `Ping` delivery; the worker sends it within a few seconds. */
  @Post(':id/ping')
  @HttpCode(202)
  async ping(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    this.admin(p);
    const w = await this.find(p, id);
    if (!w.enabled) throw new BadRequestException('The webhook is turned off; turn it on first');
    return deliveryView(await this.store().ping(w, p.userId));
  }

  @Get(':id/deliveries')
  async deliveries(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    this.admin(p);
    await this.find(p, id);
    return (await this.store().deliveries(id)).map(deliveryView);
  }

  @Post(':id/deliveries/:delivery/redeliver')
  @HttpCode(202)
  async redeliver(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('delivery') delivery: string) {
    this.admin(p);
    await this.find(p, id);
    const row = await this.store().redeliver(id, delivery);
    if (!row) throw new NotFoundException(`Delivery '${delivery}' not found`);
    return deliveryView(row);
  }

  private store() {
    return new WebhookStore(this.database.db);
  }

  private admin(p: Principal) {
    if (!p.roles.includes('admin')) throw new ForbiddenException('Webhooks need the admin role');
  }

  private async find(p: Principal, id: string): Promise<WebhookRow> {
    const row = await this.store().get(p.tenantId, id);
    if (!row) throw new NotFoundException(`Webhook '${id}' not found`);
    return row;
  }

  private async checkUrl(url: string) {
    const bad = await checkWebhookUrl(url, this.config.WEBHOOK_ALLOW_PRIVATE);
    if (bad) throw new BadRequestException(`Webhook URL ${bad}`);
  }

  private async workspace(p: Principal, ws: string | null): Promise<string | null> {
    if (ws === null) return null;
    const store = new WorkspaceStore(this.database.db);
    const row = (await store.get(p.tenantId, ws)) ?? (await store.bySlug(p.tenantId, ws));
    if (!row) throw new NotFoundException(`Workspace '${ws}' not found`);
    return row.id;
  }
}

const view = (w: WebhookRow) => ({
  id: w.id,
  name: w.name,
  url: w.url,
  workspaceId: w.workspaceId,
  eventTypes: w.eventTypes,
  enabled: w.enabled,
  disabledReason: w.disabledReason,
  consecutiveFailures: w.consecutiveFailures,
  createdBy: w.createdBy,
  createdAt: w.createdAt.toISOString(),
});

const deliveryView = (d: DeliveryRow) => ({
  id: d.id,
  eventId: d.eventId,
  eventType: d.eventType,
  status: d.status,
  attempts: d.attempts,
  nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt.toISOString() : null,
  responseStatus: d.responseStatus,
  lastError: d.lastError,
  durationMs: d.durationMs,
  createdAt: d.createdAt.toISOString(),
  deliveredAt: d.deliveredAt?.toISOString() ?? null,
});
