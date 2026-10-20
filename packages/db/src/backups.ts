import { and, asc, desc, eq, gt, isNull, max } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { DbOrTx } from './client';
import { events, graphBackups, workspaces } from './schema';

export type BackupRow = typeof graphBackups.$inferSelect;

export class BackupStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, b: Omit<typeof graphBackups.$inferInsert, 'id' | 'tenantId' | 'createdAt'>): Promise<BackupRow> {
    const [row] = await this.db.insert(graphBackups).values({ id: ulid(), tenantId, ...b }).returning();
    return row!;
  }

  async get(tenantId: string, workspaceId: string, id: string): Promise<BackupRow | undefined> {
    const [row] = await this.db
      .select()
      .from(graphBackups)
      .where(and(eq(graphBackups.tenantId, tenantId), eq(graphBackups.workspaceId, workspaceId), eq(graphBackups.id, id)));
    return row;
  }

  async list(tenantId: string, workspaceId: string, limit = 100): Promise<BackupRow[]> {
    return this.db
      .select()
      .from(graphBackups)
      .where(and(eq(graphBackups.tenantId, tenantId), eq(graphBackups.workspaceId, workspaceId)))
      .orderBy(desc(graphBackups.createdAt), desc(graphBackups.id))
      .limit(limit);
  }

  /** Backups of a workspace beyond the newest `keep`, oldest first (for pruning). */
  async beyond(tenantId: string, workspaceId: string, keep: number): Promise<BackupRow[]> {
    return (await this.list(tenantId, workspaceId, 10_000)).slice(keep).reverse();
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(graphBackups).where(eq(graphBackups.id, id));
  }

  /** Workspaces (across tenants) that have backups, for pruning. */
  async workspacesWithBackups(): Promise<{ tenantId: string; workspaceId: string }[]> {
    return this.db.selectDistinct({ tenantId: graphBackups.tenantId, workspaceId: graphBackups.workspaceId }).from(graphBackups);
  }
}

/** Write lock on a workspace while its graph is replaced. */
export class WorkspaceLock {
  constructor(private readonly db: DbOrTx) {}

  /** Takes the lock unless someone holds it; returns whether it was taken. */
  async acquire(tenantId: string, workspaceId: string, reason: string): Promise<boolean> {
    const rows = await this.db
      .update(workspaces)
      .set({ lockedReason: reason })
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, workspaceId), isNull(workspaces.lockedReason)))
      .returning({ id: workspaces.id });
    return rows.length > 0;
  }

  async release(tenantId: string, workspaceId: string): Promise<void> {
    await this.db.update(workspaces).set({ lockedReason: null }).where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, workspaceId)));
  }

  async reason(tenantId: string, workspaceId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ r: workspaces.lockedReason })
      .from(workspaces)
      .where(and(eq(workspaces.tenantId, tenantId), eq(workspaces.id, workspaceId)));
    return row?.r ?? null;
  }
}

/** The event log of one workspace, for replay. */
export class WorkspaceEvents {
  constructor(private readonly db: DbOrTx) {}

  /** Position of the latest event (0 when there is none). */
  async lastSeq(tenantId: string, workspaceId: string): Promise<number> {
    const [r] = await this.db.select({ s: max(events.seq) }).from(events).where(and(eq(events.tenantId, tenantId), eq(events.workspaceId, workspaceId)));
    return Number(r?.s ?? 0);
  }

  /** Events after `afterSeq`, oldest first, in pages. */
  async *after(tenantId: string, workspaceId: string, afterSeq: number, page = 5000) {
    for (let from = afterSeq; ; ) {
      const rows = await this.db
        .select()
        .from(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.workspaceId, workspaceId), gt(events.seq, from)))
        .orderBy(asc(events.seq))
        .limit(page);
      for (const r of rows) {
        yield {
          seq: r.seq,
          type: r.type,
          workspaceId: r.workspaceId,
          subjectId: r.subjectId,
          version: r.subjectVersion,
          actor: r.actor,
          occurredAt: r.occurredAt.toISOString(),
          data: r.data as Record<string, unknown>,
        };
      }
      if (rows.length < page) return;
      from = rows.at(-1)!.seq;
    }
  }
}

