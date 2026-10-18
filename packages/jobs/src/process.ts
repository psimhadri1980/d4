import type { TableMapping } from '@d4/codecs';
import { DomainError } from '@d4/core';
import { JobStore, MetamodelStore, WorkspaceStore, type Db, type JobRow } from '@d4/db';
import type { SessionProvider } from '@d4/graph';
import type { ArtifactStore } from './artifacts';
import { ExportParams, exportSnapshot, renderExport } from './export';
import { modelHandles } from './model-handles';
import type { JobMessage } from './queue';
import { runTabularImport } from './tabular-import';

export interface JobDeps {
  db: Db;
  graphs: { sessions(tenantId: string): SessionProvider };
  artifacts: ArtifactStore;
}

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
  try {
    const result = await run(job, deps, store);
    await store.succeed(msg.tenantId, job.id, result.result, result.artifact);
  } catch (e) {
    const final = e instanceof DomainError || attempt.made + 1 >= attempt.max;
    await store.fail(msg.tenantId, job.id, e instanceof Error ? e.message : String(e), final);
    if (!final) throw e;
  }
}

async function run(job: JobRow, deps: JobDeps, store: JobStore) {
  const ws = await new WorkspaceStore(deps.db).get(job.tenantId, job.workspaceId);
  if (!ws) throw new DomainError('NOT_FOUND', `Workspace '${job.workspaceId}' no longer exists`);
  const registry = await new MetamodelStore(deps.db).registryForWorkspace(job.tenantId, job.workspaceId);
  const handles = modelHandles(deps.db, registry, deps.graphs.sessions(job.tenantId), job.tenantId);
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

  const input = JSON.parse(new TextDecoder().decode(await deps.artifacts.get(inputKey(job.id)))) as TabularJobInput;
  const files = input.files.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.content, 'base64')) }));
  const dryRun = (job.params as { dryRun?: boolean }).dryRun === true;
  const result = await runTabularImport(handles, registry, { workspaceId: ws.id, actor: job.createdBy }, files, input.mappings, dryRun, progress);
  return { result: { ...result } as Record<string, unknown>, artifact: undefined };
}
