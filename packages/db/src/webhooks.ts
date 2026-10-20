import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { Db, DbOrTx } from './client';
import { events, webhookDeliveries, webhooks } from './schema';

export type WebhookRow = typeof webhooks.$inferSelect;
export type DeliveryRow = typeof webhookDeliveries.$inferSelect;

export interface NewWebhook {
  workspaceId: string | null;
  name: string;
  url: string;
  secret: string;
  eventTypes: string[];
  createdBy: string;
}

export type WebhookChanges = Partial<Pick<WebhookRow, 'name' | 'url' | 'eventTypes' | 'workspaceId' | 'enabled' | 'disabledReason' | 'secret'>>;

/** The body sent for one event; the same shape for test pings (`type: 'Ping'`). */
export interface WebhookPayload {
  id: string;
  type: string;
  tenantId: string;
  workspaceId: string | null;
  subjectId?: string;
  version?: number;
  actor?: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

export class WebhookStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, w: NewWebhook): Promise<WebhookRow> {
    const [row] = await this.db.insert(webhooks).values({ id: ulid(), tenantId, ...w }).returning();
    return row!;
  }

  async get(tenantId: string, id: string): Promise<WebhookRow | undefined> {
    const [row] = await this.db.select().from(webhooks).where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)));
    return row;
  }

  async list(tenantId: string): Promise<WebhookRow[]> {
    return this.db.select().from(webhooks).where(eq(webhooks.tenantId, tenantId)).orderBy(asc(webhooks.name), asc(webhooks.id));
  }

  async update(tenantId: string, id: string, changes: WebhookChanges): Promise<WebhookRow | undefined> {
    // Turning a webhook back on clears the failure streak so it gets a fresh chance.
    const reset = changes.enabled === true ? { consecutiveFailures: 0, disabledReason: null } : {};
    const [row] = await this.db
      .update(webhooks)
      .set({ ...changes, ...reset, updatedAt: sql`now()` })
      .where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id)))
      .returning();
    return row;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(webhooks).where(and(eq(webhooks.tenantId, tenantId), eq(webhooks.id, id))).returning({ id: webhooks.id });
    return rows.length > 0;
  }

  async deliveries(webhookId: string, limit = 50): Promise<DeliveryRow[]> {
    return this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, webhookId))
      .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
      .limit(limit);
  }

  async delivery(webhookId: string, id: string): Promise<DeliveryRow | undefined> {
    const [row] = await this.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.id, id)));
    return row;
  }

  /** Queues a test ping, sent by the next delivery pass. */
  async ping(w: WebhookRow, actor: string): Promise<DeliveryRow> {
    const id = ulid();
    const payload: WebhookPayload = { id, type: 'Ping', tenantId: w.tenantId, workspaceId: w.workspaceId, actor, occurredAt: new Date().toISOString(), data: { webhookId: w.id } };
    const [row] = await this.db.insert(webhookDeliveries).values({ id, webhookId: w.id, eventType: 'Ping', payload }).returning();
    return row!;
  }

  /** Sends a finished delivery again, as a fresh attempt sequence. */
  async redeliver(webhookId: string, id: string): Promise<DeliveryRow | undefined> {
    const [row] = await this.db
      .update(webhookDeliveries)
      .set({ status: 'pending', attempts: 0, nextAttemptAt: sql`now()`, lastError: null, responseStatus: null })
      .where(and(eq(webhookDeliveries.webhookId, webhookId), eq(webhookDeliveries.id, id)))
      .returning();
    return row;
  }
}

/**
 * The outbox relay: takes events not yet published, queues one delivery per matching webhook and
 * marks the events published, all in one transaction. A webhook only gets events recorded after it
 * was created. `SKIP LOCKED` lets several workers run this at once.
 */
export async function relayEvents(db: Db, limit = 200): Promise<{ events: number; deliveries: number }> {
  return db.transaction(async (tx) => {
    const batch = await tx
      .select()
      .from(events)
      .where(isNull(events.publishedAt))
      .orderBy(asc(events.seq))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (!batch.length) return { events: 0, deliveries: 0 };
    const hooks = await tx
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.enabled, true), inArray(webhooks.tenantId, [...new Set(batch.map((e) => e.tenantId))])));
    const rows = batch.flatMap((e) =>
      hooks
        .filter((h) => matches(h, e))
        .map((h) => ({
          id: ulid(),
          webhookId: h.id,
          eventId: e.id,
          eventType: e.type,
          payload: {
            id: e.id,
            type: e.type,
            tenantId: e.tenantId,
            workspaceId: e.workspaceId,
            subjectId: e.subjectId,
            version: e.subjectVersion,
            actor: e.actor,
            occurredAt: e.occurredAt.toISOString(),
            data: e.data as Record<string, unknown>,
          } satisfies WebhookPayload,
        })),
    );
    if (rows.length) await tx.insert(webhookDeliveries).values(rows).onConflictDoNothing();
    await tx
      .update(events)
      .set({ publishedAt: sql`now()` })
      .where(inArray(events.seq, batch.map((e) => e.seq)));
    return { events: batch.length, deliveries: rows.length };
  });
}

const matches = (h: WebhookRow, e: typeof events.$inferSelect) =>
  h.tenantId === e.tenantId &&
  (h.workspaceId === null || h.workspaceId === e.workspaceId) &&
  (h.eventTypes.length === 0 || h.eventTypes.includes(e.type)) &&
  e.recordedAt >= h.createdAt;

export interface DueDelivery {
  delivery: DeliveryRow;
  webhook: WebhookRow;
}

/**
 * Claims pending deliveries that are due, for enabled webhooks, and pushes each one's next attempt
 * past `leaseMs` so a crashed sender's work comes back later instead of being lost or doubled.
 */
export async function claimDueDeliveries(db: Db, now: Date, leaseMs: number, limit = 20): Promise<DueDelivery[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ delivery: webhookDeliveries, webhook: webhooks })
      .from(webhookDeliveries)
      .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
      .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, now), eq(webhooks.enabled, true)))
      .orderBy(asc(webhookDeliveries.nextAttemptAt))
      .limit(limit)
      .for('update', { of: webhookDeliveries, skipLocked: true });
    if (due.length) {
      await tx
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(now.getTime() + leaseMs) })
        .where(inArray(webhookDeliveries.id, due.map((d) => d.delivery.id)));
    }
    return due;
  });
}

export interface AttemptResult {
  ok: boolean;
  responseStatus?: number;
  error?: string;
  durationMs: number;
  /** When to try again; absent when the delivery is finished (succeeded or out of attempts). */
  retryAt?: Date;
}

/**
 * Records one attempt. A final failure counts against the webhook; after `disableAfter` final
 * failures in a row the webhook is switched off with a reason. Any success resets the count.
 */
export async function recordAttempt(db: Db, d: DueDelivery, r: AttemptResult, disableAfter: number): Promise<void> {
  await db.transaction(async (tx) => {
    const status = r.ok ? 'succeeded' : r.retryAt ? 'pending' : 'failed';
    await tx
      .update(webhookDeliveries)
      .set({
        status,
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        responseStatus: r.responseStatus ?? null,
        lastError: r.error ?? null,
        durationMs: r.durationMs,
        ...(r.retryAt && { nextAttemptAt: r.retryAt }),
        ...(r.ok && { deliveredAt: sql`now()` }),
      })
      .where(eq(webhookDeliveries.id, d.delivery.id));
    if (r.ok) {
      await tx.update(webhooks).set({ consecutiveFailures: 0 }).where(eq(webhooks.id, d.webhook.id));
    } else if (status === 'failed') {
      await tx
        .update(webhooks)
        .set({
          consecutiveFailures: sql`${webhooks.consecutiveFailures} + 1`,
          enabled: sql`${webhooks.consecutiveFailures} + 1 < ${disableAfter}`,
          disabledReason: sql`case when ${webhooks.consecutiveFailures} + 1 >= ${disableAfter} then ${`Turned off after ${disableAfter} failed deliveries in a row`} else ${webhooks.disabledReason} end`,
        })
        .where(eq(webhooks.id, d.webhook.id));
    }
  });
}
