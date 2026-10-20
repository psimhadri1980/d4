import { DomainError } from '@d4/core';
import { claimDueSchedules, JobStore, ScheduleStore, type Db, type ScheduleRow } from '@d4/db';
import { z } from 'zod';
import { ExportParams } from './export';
import type { JobQueue } from './queue';
import { RenderParams } from './render';
import { assertJobQuota } from './usage';

/** When a schedule runs; hours are UTC so a schedule means the same thing for everyone. */
export const Cadence = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('daily'), hour: z.number().int().min(0).max(23) }),
  z.object({ frequency: z.literal('weekly'), hour: z.number().int().min(0).max(23), weekday: z.number().int().min(0).max(6) }),
  // 1–28 so every month has the day.
  z.object({ frequency: z.literal('monthly'), hour: z.number().int().min(0).max(23), day: z.number().int().min(1).max(28) }),
]);
export type Cadence = z.infer<typeof Cadence>;

/** The first run strictly after `after`. */
export function nextRun(c: Cadence, after: Date): Date {
  const at = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d, c.hour, 0, 0, 0));
  const y = after.getUTCFullYear();
  const m = after.getUTCMonth();
  const d = after.getUTCDate();
  if (c.frequency === 'daily') {
    const today = at(y, m, d);
    return today > after ? today : at(y, m, d + 1);
  }
  if (c.frequency === 'weekly') {
    const ahead = (c.weekday - after.getUTCDay() + 7) % 7;
    const candidate = at(y, m, d + ahead);
    return candidate > after ? candidate : at(y, m, d + ahead + 7);
  }
  const thisMonth = at(y, m, c.day);
  return thisMonth > after ? thisMonth : at(y, m + 1, c.day);
}

export function describeCadence(c: Cadence): string {
  const hour = `${String(c.hour).padStart(2, '0')}:00 UTC`;
  if (c.frequency === 'daily') return `Every day at ${hour}`;
  if (c.frequency === 'weekly') return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][c.weekday]} at ${hour}`;
  return `On day ${c.day} of every month at ${hour}`;
}

/** What a schedule produces: the same parameters as an export or render job. */
export function validateScheduleParams(kind: 'export' | 'render', params: unknown): Record<string, unknown> {
  const parsed = kind === 'export' ? ExportParams.safeParse(params) : RenderParams.safeParse(params);
  if (!parsed.success) throw new DomainError('VALIDATION', 'Invalid report settings', parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`));
  return parsed.data as Record<string, unknown>;
}

/** The job parameters for one run: with `useRunDate`, dates follow the run. */
export function runParams(s: Pick<ScheduleRow, 'kind' | 'params' | 'useRunDate'>, runDate: Date): Record<string, unknown> {
  const p = { ...(s.params as Record<string, unknown>) };
  if (!s.useRunDate) return p;
  const day = runDate.toISOString().slice(0, 10);
  if (s.kind === 'render' && p['target'] === 'roadmap') return { ...p, today: day };
  return { ...p, asOf: day };
}

export interface Queues {
  jobs: Pick<JobQueue, 'enqueue'>;
  render: Pick<JobQueue, 'enqueue'>;
}

/** Starts one run of a schedule now: a job owned by the schedule's owner, within the tenant's job quota. */
export async function startScheduledRun(db: Db, queues: Queues, s: ScheduleRow, now: Date): Promise<string> {
  await assertJobQuota(db, s.tenantId, now);
  const job = await new JobStore(db).create(s.tenantId, {
    workspaceId: s.workspaceId,
    kind: s.kind,
    params: runParams(s, now),
    createdBy: s.createdBy,
    scheduleId: s.id,
  });
  await (s.kind === 'render' ? queues.render : queues.jobs).enqueue({ tenantId: s.tenantId, jobId: job.id });
  await new ScheduleStore(db).recordRun(s.tenantId, s.id, job.id, now);
  return job.id;
}

/**
 * One scheduler tick: claims due schedules and starts a run for each. A schedule that was missed
 * (worker down) runs once on the next tick, then continues from now, rather than catching up.
 */
export async function runDueSchedules(db: Db, queues: Queues, now = new Date()): Promise<string[]> {
  const claimed = await claimDueSchedules(db, now, (row) => nextRun(Cadence.parse(row.cadence), now));
  const jobs: string[] = [];
  for (const s of claimed) {
    try {
      jobs.push(await startScheduledRun(db, queues, s, now));
    } catch (e) {
      // Over quota: this run is skipped; the schedule stays on its cadence.
      if (!(e instanceof DomainError && e.code === 'QUOTA_EXCEEDED')) throw e;
    }
  }
  return jobs;
}
