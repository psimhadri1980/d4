import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonical, compareStates, DomainError, emptyState, replayEvents, type Element, type ModelState, type ReplayEvent, type Relationship } from '@d4/core';
import { BackupStore, JobStore, TenantStore, utcDayStart, WorkspaceEvents, WorkspaceLock, WorkspaceStore, type BackupRow, type Db } from '@d4/db';
import { readWorkspaceGraph, replaceWorkspaceGraph, type SessionProvider } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import { z } from 'zod';
import type { ArtifactStore } from './artifacts';
import type { JobQueue } from './queue';

/** Snapshots kept per workspace; older ones are pruned (safety snapshots count too). */
export const BACKUPS_KEPT = 14;
const FORMAT = 'd4-graph-backup/1';

export const RestoreParams = z.object({ backupId: z.string().min(1) }).strict();

export interface BackupContext {
  db: Db;
  artifacts: ArtifactStore;
  sessions: SessionProvider;
  registry: MetamodelRegistry;
  tenantId: string;
  workspaceId: string;
  actor: string;
  jobId?: string;
  progress?: (percent: number) => Promise<void>;
}

/** SHA-256 over the items' canonical forms, sorted by id. Equal graphs give equal checksums. */
export function stateChecksum(s: ModelState): string {
  const h = createHash('sha256');
  for (const kind of [s.elements, s.relationships] as Map<string, Element | Relationship>[]) {
    for (const id of [...kind.keys()].sort()) h.update(canonical(kind.get(id)!)).update('\n');
    h.update('--\n');
  }
  return h.digest('hex');
}

/**
 * Writes a snapshot of the workspace graph to object storage. The event position is read before
 * the graph, so replaying from it after a restore covers every write that raced the snapshot.
 */
export async function snapshotWorkspace(c: BackupContext, reason: BackupRow['reason']): Promise<BackupRow> {
  const eventSeq = await new WorkspaceEvents(c.db).lastSeq(c.tenantId, c.workspaceId);
  const state = await readWorkspaceGraph(c.sessions, c.workspaceId);
  const body = gzipSync(
    JSON.stringify({ format: FORMAT, workspaceId: c.workspaceId, eventSeq, elements: [...state.elements.values()], relationships: [...state.relationships.values()] }),
  );
  const objectKey = `backups/${c.tenantId}/${c.workspaceId}/${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.json.gz`;
  const bytes = await c.artifacts.put(objectKey, body, 'application/gzip');
  return new BackupStore(c.db).create(c.tenantId, {
    workspaceId: c.workspaceId,
    reason,
    objectKey,
    bytes,
    elements: state.elements.size,
    relationships: state.relationships.size,
    eventSeq,
    checksum: stateChecksum(state),
    jobId: c.jobId ?? null,
    createdBy: c.actor,
  });
}

export async function loadSnapshot(artifacts: ArtifactStore, b: BackupRow): Promise<ModelState> {
  const doc = JSON.parse(gunzipSync(await artifacts.get(b.objectKey)).toString('utf8')) as {
    format: string;
    workspaceId: string;
    elements: Element[];
    relationships: Relationship[];
  };
  if (doc.format !== FORMAT || doc.workspaceId !== b.workspaceId) throw new DomainError('VALIDATION', `Backup ${b.id} is not a ${FORMAT} file for this workspace`);
  const state: ModelState = { elements: new Map(doc.elements.map((e) => [e.id, e])), relationships: new Map(doc.relationships.map((r) => [r.id, r])) };
  if (stateChecksum(state) !== b.checksum) throw new DomainError('VALIDATION', `Backup ${b.id} does not match its checksum; it may be damaged`);
  return state;
}

async function replayFrom(c: BackupContext, start: ModelState, afterSeq: number) {
  const events: ReplayEvent[] = [];
  for await (const e of new WorkspaceEvents(c.db).after(c.tenantId, c.workspaceId, afterSeq)) events.push(e);
  return { ...replayEvents(start, events), events: events.length };
}

/** Replays the whole event log and compares it with the live graph, without changing anything. */
export async function verifyWorkspace(c: BackupContext) {
  const expected = await replayFrom(c, emptyState(), 0);
  const actual = await readWorkspaceGraph(c.sessions, c.workspaceId);
  const diff = compareStates(expected, actual);
  return {
    matches: diff.count === 0 && expected.problems.length === 0,
    events: expected.events,
    elements: actual.elements.size,
    relationships: actual.relationships.size,
    differences: diff.count,
    examples: diff.differences,
    replayProblems: expected.problems.slice(0, 50),
    checksum: stateChecksum(actual),
  };
}

/**
 * Replaces the workspace graph with what the event log says, starting from a snapshot (restore)
 * or from nothing (rebuild). Writers are locked out; a safety snapshot of the current graph is
 * taken first; the result is read back and checked before the lock is released.
 */
export async function replaceFromLog(c: BackupContext, from: { backupId: string } | 'events') {
  const lock = new WorkspaceLock(c.db);
  const what = from === 'events' ? 'rebuilt from the event log' : 'restored from a backup';
  if (!(await lock.acquire(c.tenantId, c.workspaceId, `being ${what}`))) {
    throw new DomainError('LOCKED', 'Another restore or rebuild of this workspace is running');
  }
  try {
    // Let writes that passed the lock check just before it was taken commit first.
    await new Promise((r) => setTimeout(r, 1000));
    const backup = from === 'events' ? undefined : await new BackupStore(c.db).get(c.tenantId, c.workspaceId, from.backupId);
    if (from !== 'events' && !backup) throw new DomainError('NOT_FOUND', `Backup '${from.backupId}' not found`);
    const start = backup ? await loadSnapshot(c.artifacts, backup) : emptyState();
    const target = await replayFrom(c, start, backup?.eventSeq ?? 0);
    if (target.problems.length) {
      throw new DomainError('VALIDATION', `The event log cannot be replayed cleanly; nothing was changed`, target.problems.slice(0, 20));
    }
    await c.progress?.(10);
    const safety = await snapshotWorkspace(c, 'safety');
    await c.progress?.(20);
    await replaceWorkspaceGraph(c.sessions, c.registry, c.workspaceId, target, (done, total) => c.progress?.(20 + Math.floor((70 * done) / Math.max(total, 1))));
    const after = await readWorkspaceGraph(c.sessions, c.workspaceId);
    const check = compareStates(target, after);
    if (check.count) throw new Error(`The graph does not match after replacing it (${check.count} differences, e.g. ${check.differences[0]}); restore backup ${safety.id} to undo`);
    return {
      from: backup ? { backupId: backup.id, eventSeq: backup.eventSeq } : 'events',
      eventsReplayed: target.applied,
      elements: after.elements.size,
      relationships: after.relationships.size,
      checksum: stateChecksum(after),
      safetyBackupId: safety.id,
    };
  } finally {
    await lock.release(c.tenantId, c.workspaceId);
  }
}

/** Deletes snapshots beyond the newest BACKUPS_KEPT per workspace. Returns how many went. */
export async function pruneBackups(db: Db, artifacts: ArtifactStore): Promise<number> {
  const store = new BackupStore(db);
  let removed = 0;
  for (const w of await store.workspacesWithBackups()) {
    for (const b of await store.beyond(w.tenantId, w.workspaceId, BACKUPS_KEPT)) {
      await artifacts.delete(b.objectKey);
      await store.remove(b.id);
      removed++;
    }
  }
  return removed;
}

/**
 * Starts the daily backup of every active workspace once the UTC hour reaches `hour`: one backup
 * job per workspace per day (a workspace that already has today's job is skipped, so repeated
 * ticks are harmless). Jobs run as the system user and count towards the job quota like others.
 */
export async function startScheduledBackups(db: Db, queue: Pick<JobQueue, 'enqueue'>, hour: number, now = new Date()): Promise<string[]> {
  if (hour < 0 || now.getUTCHours() < hour) return [];
  const since = utcDayStart(now);
  const started: string[] = [];
  for (const t of await new TenantStore(db).listActive()) {
    for (const ws of await new WorkspaceStore(db).list(t.id)) {
      if (await new JobStore(db).hasKindSince(t.id, ws.id, 'backup', since)) continue;
      const job = await new JobStore(db).create(t.id, { workspaceId: ws.id, kind: 'backup', params: { reason: 'scheduled' }, createdBy: 'system' });
      await queue.enqueue({ tenantId: t.id, jobId: job.id });
      started.push(job.id);
    }
  }
  return started;
}
