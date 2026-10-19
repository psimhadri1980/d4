import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { Db, DbOrTx } from './client';
import { schedules } from './schema';

export type ScheduleRow = typeof schedules.$inferSelect;

export interface NewSchedule {
  workspaceId: string;
  name: string;
  kind: ScheduleRow['kind'];
  params: Record<string, unknown>;
  useRunDate: boolean;
  cadence: Record<string, unknown>;
  nextRunAt: Date;
  createdBy: string;
}

export type ScheduleChanges = Partial<Pick<ScheduleRow, 'name' | 'params' | 'useRunDate' | 'cadence' | 'enabled' | 'nextRunAt'>>;

export class ScheduleStore {
  constructor(private readonly db: DbOrTx) {}

  async create(tenantId: string, s: NewSchedule): Promise<ScheduleRow> {
    const [row] = await this.db.insert(schedules).values({ id: ulid(), tenantId, ...s }).returning();
    return row!;
  }

  async get(tenantId: string, id: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.select().from(schedules).where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)));
    return row;
  }

  async list(tenantId: string, workspaceId: string, opts: { createdBy?: string } = {}): Promise<ScheduleRow[]> {
    return this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.tenantId, tenantId), eq(schedules.workspaceId, workspaceId), ...(opts.createdBy ? [eq(schedules.createdBy, opts.createdBy)] : [])))
      .orderBy(asc(schedules.name), asc(schedules.id));
  }

  async update(tenantId: string, id: string, changes: ScheduleChanges): Promise<ScheduleRow | undefined> {
    const [row] = await this.db
      .update(schedules)
      .set({ ...changes, updatedAt: sql`now()` })
      .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
      .returning();
    return row;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const rows = await this.db.delete(schedules).where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id))).returning({ id: schedules.id });
    return rows.length > 0;
  }

  async recordRun(tenantId: string, id: string, jobId: string, at: Date): Promise<void> {
    await this.db.update(schedules).set({ lastRunAt: at, lastJobId: jobId }).where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)));
  }
}

/**
 * Claims schedules that are due, across tenants, and moves each one's next run forward in the
 * same transaction. `FOR UPDATE SKIP LOCKED` lets several workers poll at once without running a
 * schedule twice; a crash before commit leaves the schedule due for the next poll.
 */
export async function claimDueSchedules(
  db: Db,
  now: Date,
  nextRun: (row: ScheduleRow) => Date,
  limit = 20,
): Promise<ScheduleRow[]> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select()
      .from(schedules)
      .where(and(eq(schedules.enabled, true), lte(schedules.nextRunAt, now)))
      .orderBy(asc(schedules.nextRunAt))
      .limit(limit)
      .for('update', { skipLocked: true });
    for (const row of due) {
      await tx.update(schedules).set({ nextRunAt: nextRun(row) }).where(eq(schedules.id, row.id));
    }
    return due;
  });
}
