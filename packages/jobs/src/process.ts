import type { TableMapping } from '@d4/codecs';
import { DomainError } from '@d4/core';
import { JobStore, MetamodelStore, ScheduleStore, WorkspaceStore, type Db, type JobRow, type ScheduleRow } from '@d4/db';
import { canStillRead } from './access';
import { replaceFromLog, RestoreParams, snapshotWorkspace, verifyWorkspace, type BackupContext } from './backup';
import type { Mailer } from './mail';
import type { SessionProvider } from '@d4/graph';
import type { ArtifactStore } from './artifacts';
import { ExportParams, exportSnapshot, renderExport } from './export';
import { modelHandles } from './model-handles';
import type { JobMessage } from './queue';
import { RenderParams, renderPicture, renderSvg, type Rasterize } from './render';
import type { GraphQuotaGuard } from './usage';
import { runTabularImport } from './tabular-import';

export interface JobDeps {
  db: Db;
  graphs: { sessions(tenantId: string): SessionProvider };
  artifacts: ArtifactStore;
  /** PNG/PDF conversion; only the renderer service has it. */
  rasterize?: Rasterize;
  /** Emails scheduled reports to their recipients when configured. */
  mailer?: Mailer;
  /** Public web address, for links in emails. */
  appUrl?: string;
  /** Refuses imports that would pass the tenant's element or relationship limits. */
  quota?: GraphQuotaGuard;
}

/** Files up to this size are attached to report emails; larger ones are linked. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** What an import job keeps in the artefact store until it runs. */
export interface TabularJobInput {
  files: { name: string; content: string }[];
  mappings: { table: string; mapping: TableMapping }[];
}

export const inputKey = (jobId: string) => `jobs/${jobId}/input.json`;
export const outputKey = (jobId: string, filename: string) => `jobs/${jobId}/${filename}`;

/**
 * Runs one job attempt. Validation problems (DomainError) fail the job at once, because a retry
 * cannot fix them; anything else is rethrown so the queue retries, and only the last attempt
 * marks the job failed.
 */
export async function processJob(msg: JobMessage, deps: JobDeps, attempt: { made: number; max: number } = { made: 0, max: 1 }): Promise<void> {
  const store = new JobStore(deps.db);
  const job = await store.start(msg.tenantId, msg.jobId);
  if (!job) return; // already finished (duplicate delivery)
  let finished = false;
  try {
    const schedule = job.scheduleId ? await new ScheduleStore(deps.db).get(job.tenantId, job.scheduleId) : undefined;
    if (job.scheduleId) await checkOwner(job, deps.db, schedule);
    const result = await run(job, deps, store);
    await store.succeed(msg.tenantId, job.id, result.result, result.artifact);
    finished = true;
    if (schedule?.recipients.length && result.artifact) await deliver(job, schedule, result.artifact, deps, store);
  } catch (e) {
    const final = e instanceof DomainError || attempt.made + 1 >= attempt.max;
    await store.fail(msg.tenantId, job.id, e instanceof Error ? e.message : String(e), final);
    finished = final;
    if (!final) throw e;
  } finally {
    // Uploaded spreadsheets are only needed while the import runs.
    if (finished && job.kind === 'import-tabular' && job.artifactKey) {
      await deps.artifacts.delete(job.artifactKey).catch(() => undefined);
      await store.clearArtifact(job.tenantId, job.id, false);
    }
  }
}

/** A scheduled run acts as its owner: stop (and pause the schedule) when they lost access. */
async function checkOwner(job: JobRow, db: Db, schedule: ScheduleRow | undefined) {
  const access = await canStillRead(db, job.tenantId, job.workspaceId, job.createdBy);
  if (access.ok) return;
  if (schedule) await new ScheduleStore(db).update(job.tenantId, schedule.id, { enabled: false, pausedReason: `Paused: ${access.reason}` });
  throw new DomainError('VALIDATION', `Not run: ${access.reason}`);
}

/** Emails the report; a failed delivery is recorded on the job but does not fail it. */
async function deliver(job: JobRow, s: ScheduleRow, artifact: { key: string; name: string; type: string; bytes: number }, deps: JobDeps, store: JobStore) {
  if (!deps.mailer) {
    await store.addResult(job.tenantId, job.id, { delivery: { status: 'skipped', reason: 'email is not configured' } });
    return;
  }
  const link = `${(deps.appUrl ?? 'http://localhost:5173').replace(/\/$/, '')}/w/${job.workspaceId}/reports`;
  const attach = artifact.bytes <= MAX_ATTACHMENT_BYTES;
  try {
    await deps.mailer.send({
      to: s.recipients,
      subject: `${s.name} (${new Date().toISOString().slice(0, 10)})`,
      text: [
        `The scheduled report "${s.name}" is ready.`,
        attach ? `The file ${artifact.name} is attached.` : `The file ${artifact.name} is too large to attach; download it from Reports.`,
        `Reports: ${link}`,
        '',
        'You receive this because you are a recipient of this D4 report.',
      ].join('\n'),
      ...(attach && { attachments: [{ filename: artifact.name, content: await deps.artifacts.get(artifact.key), contentType: artifact.type }] }),
    });
    await store.addResult(job.tenantId, job.id, { delivery: { status: 'sent', recipients: s.recipients.length, attached: attach } });
  } catch (e) {
    await store.addResult(job.tenantId, job.id, { delivery: { status: 'failed', error: e instanceof Error ? e.message : String(e) } });
  }
}

/**
 * Deletes report and export files older than `before`. Job records stay, marked as expired, so
 * history remains; returns how many files were removed.
 */
export async function pruneArtifacts(db: Db, artifacts: ArtifactStore, before: Date): Promise<number> {
  const store = new JobStore(db);
  let removed = 0;
  for (;;) {
    const batch = await store.withExpiredArtifacts(before, 100);
    if (!batch.length) return removed;
    for (const j of batch) {
      await artifacts.delete(j.artifactKey!).catch(() => undefined);
      await store.clearArtifact(j.tenantId, j.id, true);
      removed++;
    }
  }
}

async function run(job: JobRow, deps: JobDeps, store: JobStore) {
  const ws = await new WorkspaceStore(deps.db).get(job.tenantId, job.workspaceId);
  if (!ws) throw new DomainError('NOT_FOUND', `Workspace '${job.workspaceId}' no longer exists`);
  const registry = await new MetamodelStore(deps.db).registryForWorkspace(job.tenantId, job.workspaceId);
  const handles = modelHandles(deps.db, registry, deps.graphs.sessions(job.tenantId), job.tenantId, deps.quota);
  const progress = (p: number) => store.progress(job.tenantId, job.id, p);

  if (job.kind === 'export') {
    const p = ExportParams.parse(job.params);
    const snapshot = await exportSnapshot(handles.queries, registry, ws.id, p);
    await progress(50);
    const file = await renderExport(registry, snapshot, ws, p.format ?? 'yaml', p.asOf);
    const key = outputKey(job.id, file.filename);
    const bytes = await deps.artifacts.put(key, file.body, file.contentType);
    return {
      result: { format: p.format ?? 'yaml', elements: file.elements, relationships: file.relationships },
      artifact: { key, name: file.filename, type: file.contentType, bytes },
    };
  }

  if (job.kind === 'render') {
    const p = RenderParams.parse(job.params);
    const { svg, title } = await renderSvg(handles.queries, registry, ws, p);
    await progress(40);
    const file = await renderPicture(svg, title, p, deps.rasterize);
    const key = outputKey(job.id, file.filename);
    const bytes = await deps.artifacts.put(key, file.body, file.contentType);
    return {
      result: { target: p.target, format: p.format, title, width: Math.round(svg.width), height: Math.round(svg.height) },
      artifact: { key, name: file.filename, type: file.contentType, bytes },
    };
  }

  if (job.kind === 'backup' || job.kind === 'verify' || job.kind === 'restore' || job.kind === 'rebuild') {
    const c: BackupContext = {
      db: deps.db,
      artifacts: deps.artifacts,
      sessions: deps.graphs.sessions(job.tenantId),
      registry,
      tenantId: job.tenantId,
      workspaceId: ws.id,
      actor: job.createdBy,
      jobId: job.id,
      progress,
    };
    let result: Record<string, unknown>;
    if (job.kind === 'backup') {
      const b = await snapshotWorkspace(c, (job.params as { reason?: 'scheduled' }).reason ?? 'manual');
      result = { backupId: b.id, elements: b.elements, relationships: b.relationships, bytes: b.bytes, eventSeq: b.eventSeq, checksum: b.checksum };
    } else if (job.kind === 'verify') result = await verifyWorkspace(c);
    else result = await replaceFromLog(c, job.kind === 'restore' ? RestoreParams.parse(job.params) : 'events');
    return { result, artifact: undefined };
  }

  const input = JSON.parse(new TextDecoder().decode(await deps.artifacts.get(inputKey(job.id)))) as TabularJobInput;
  const files = input.files.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.content, 'base64')) }));
  const dryRun = (job.params as { dryRun?: boolean }).dryRun === true;
  const result = await runTabularImport(handles, registry, { workspaceId: ws.id, actor: job.createdBy }, files, input.mappings, dryRun, progress);
  return { result: { ...result } as Record<string, unknown>, artifact: undefined };
}
