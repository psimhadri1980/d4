import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { ulid } from '@d4/core';
import type { DbOrTx } from './client';
import { jobs } from './schema';

export type JobRow = typeof jobs.$inferSelect;
export type JobKind = JobRow['kind'];
export type JobStatus = JobRow['status'];

export interface NewJob {
  workspaceId: string;
  kind: JobKind;
  params: Record<string, unknown>;
  createdBy: string;
  id?: string;
  scheduleId?: string;
}

export interface Artifact {
  key: string;
  name: string;
  type: string;
  bytes: number;
}

/**
 * Job records. Status moves queued → running → succeeded | failed; a failed attempt that the
 * queue retries goes back to running. Finished jobs never change again, so a duplicate delivery
 * from the queue is a no-op.
 */
export class JobStore {
  constructor(private readonly db: DbOrTx) {}

  /** Whether the workspace has a job of this kind created since `since` (any status). */
  async hasKindSince(tenantId: string, workspaceId: string, kind: JobKind, since: Date): Promise<boolean> {
    const [row] = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.workspaceId, workspaceId), eq(jobs.kind, kind), gte(jobs.createdAt, since)))
      .limit(1);
    return !!row;
  }

  async create(tenantId: string, j: NewJob): Promise<JobRow> {
    const [row] = await this.db
      .insert(jobs)
      .values({
        id: j.id ?? ulid(),
        tenantId,
        workspaceId: j.workspaceId,
        kind: j.kind,
        params: j.params,
        createdBy: j.createdBy,
        ...(j.scheduleId && { scheduleId: j.scheduleId }),
      })
      .returning();
    return row!;
  }

  async get(tenantId: string, id: string): Promise<JobRow | undefined> {
    const [row] = await this.db.select().from(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
    return row;
  }

  async list(tenantId: string, workspaceId: string, opts: { createdBy?: string; limit?: number } = {}): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.workspaceId, workspaceId), ...(opts.createdBy ? [eq(jobs.createdBy, opts.createdBy)] : [])))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(Math.min(opts.limit ?? 50, 200));
  }

  /** Attaches an artefact (an upload to process, or the output file). */
  async setArtifact(tenantId: string, id: string, a: Artifact): Promise<void> {
    await this.db
      .update(jobs)
      .set({ artifactKey: a.key, artifactName: a.name, artifactType: a.type, artifactBytes: a.bytes })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
  }

  /** Claims the job for an attempt; undefined when it already finished (duplicate delivery). */
  async start(tenantId: string, id: string): Promise<JobRow | undefined> {
    const [row] = await this.db
      .update(jobs)
      .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, startedAt: sql`coalesce(${jobs.startedAt}, now())`, error: null })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])))
      .returning();
    return row;
  }

  async progress(tenantId: string, id: string, percent: number): Promise<void> {
    await this.db
      .update(jobs)
      .set({ progress: Math.max(0, Math.min(100, Math.round(percent))) })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), eq(jobs.status, 'running')));
  }

  async succeed(tenantId: string, id: string, result: Record<string, unknown>, artifact?: Artifact): Promise<void> {
    await this.db
      .update(jobs)
      .set({
        status: 'succeeded',
        progress: 100,
        result,
        error: null,
        finishedAt: sql`now()`,
        ...(artifact && { artifactKey: artifact.key, artifactName: artifact.name, artifactType: artifact.type, artifactBytes: artifact.bytes }),
      })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), eq(jobs.status, 'running')));
  }

  /** Finished jobs whose file is older than `before` (for pruning). Across tenants. */
  async withExpiredArtifacts(before: Date, limit = 100): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(and(isNotNull(jobs.artifactKey), inArray(jobs.status, ['succeeded', 'failed']), lt(jobs.finishedAt, before)))
      .limit(limit);
  }

  /** Forgets the job's file (after deleting it from the store); `expired` is shown to users. */
  async clearArtifact(tenantId: string, id: string, expired: boolean): Promise<void> {
    await this.db
      .update(jobs)
      .set({ artifactKey: null, ...(expired && { result: sql`coalesce(${jobs.result}, '{}'::jsonb) || '{"artifactExpired": true}'::jsonb` }) })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
  }

  /** Adds fields to the result (e.g. delivery outcome) without touching the rest. */
  async addResult(tenantId: string, id: string, fields: Record<string, unknown>): Promise<void> {
    await this.db
      .update(jobs)
      .set({ result: sql`coalesce(${jobs.result}, '{}'::jsonb) || ${JSON.stringify(fields)}::jsonb` })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)));
  }

  /** `final` = no more retries: the job is failed for good; otherwise it waits for the retry. */
  async fail(tenantId: string, id: string, error: string, final: boolean): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: final ? 'failed' : 'running', error: error.slice(0, 2000), ...(final && { finishedAt: sql`now()` }) })
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])));
  }
}
