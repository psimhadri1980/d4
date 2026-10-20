import { CONNECTOR_KINDS, Mapping, mapRecords, planSync, SourceError } from '@d4/connectors';
import { DomainError, planImport, type Element } from '@d4/core';
import { claimDueConnectors, ConnectorStore, JobStore, type ConnectorRow, type Db } from '@d4/db';
import type { MetamodelRegistry } from '@d4/metamodel';
import { z } from 'zod';
import type { ModelHandles } from './model-handles';
import { Cadence, nextRun } from './schedule';
import type { JobQueue } from './queue';
import { assertJobQuota } from './usage';
import { checkWebhookUrl } from './webhooks';

export const SyncParams = z.object({ connectorId: z.string().min(1), dryRun: z.boolean().default(false) }).strict();

const first = <T>(xs: T[], n = 20) => xs.slice(0, n);

/**
 * One sync: fetch the source, map records to elements and relationships, decide what to write
 * (planSync), plan it like an import (validation, matching, one change set) and apply it unless
 * this is a dry run. Afterwards the connector remembers what it wrote, to tell later D4 edits
 * from source changes.
 */
export async function runSync(
  db: Db,
  handles: ModelHandles,
  registry: MetamodelRegistry,
  ctx: { tenantId: string; workspaceId: string },
  params: z.infer<typeof SyncParams>,
  opts: { allowPrivate: boolean; fetch?: typeof fetch; progress?: (p: number) => Promise<void> },
) {
  const store = new ConnectorStore(db);
  const connector = await store.get(ctx.tenantId, ctx.workspaceId, params.connectorId);
  if (!connector) throw new DomainError('NOT_FOUND', `Connector '${params.connectorId}' not found`);
  if (!connector.enabled) throw new DomainError('VALIDATION', 'The connector is turned off');
  const kind = CONNECTOR_KINDS[connector.kind];
  if (!kind) throw new DomainError('VALIDATION', `Unknown connector kind '${connector.kind}'`);
  const mapping = Mapping.parse(connector.mapping);

  let fetched: { records: unknown[]; pages: number };
  try {
    fetched = await kind.fetch(connector.config, connector.secret, mapping.itemsPath, {
      ...(opts.fetch && { fetch: opts.fetch }),
      checkUrl: (url) => checkWebhookUrl(url, opts.allowPrivate),
    });
  } catch (e) {
    // The source said no or sent something unusable: retrying will not help.
    if (e instanceof SourceError) throw new DomainError('VALIDATION', e.message);
    throw e;
  }
  await opts.progress?.(30);

  const mapped = mapRecords(connector.key, mapping, fetched.records);
  const previous = await store.items(connector.id);
  const snapshot = await handles.queries.snapshot(ctx.workspaceId);
  // The snapshot holds live items only; deletions made in D4 since the last sync must be respected.
  const live = new Set(snapshot.elements.map((e) => e.id));
  const gone: Element[] = [];
  for (const p of previous) {
    if (live.has(p.elementId)) continue;
    const el = await handles.repository.getElement(ctx.workspaceId, p.elementId);
    if (el?.deleted) gone.push(el);
  }
  const plan = planSync(mapped, { elements: [...snapshot.elements, ...gone], relationships: snapshot.relationships }, previous, connector.conflictPolicy);
  await opts.progress?.(50);

  const imported = planImport(registry, { workspaceId: ctx.workspaceId, actor: `connector:${connector.key}` }, plan.input, snapshot);
  const change = imported.change;
  const writes = !!change && (change.elements.length > 0 || change.relationships.length > 0);
  const applied = imported.ok && !params.dryRun && writes;
  if (applied) await handles.repository.apply(ctx.workspaceId, change!);
  await opts.progress?.(85);

  if (imported.ok && !params.dryRun) {
    const versions = new Map<string, number>([...snapshot.elements.map((e) => [e.id, e.version] as const), ...(change?.elements ?? []).map((e) => [e.id, e.version] as const)]);
    await store.saveItems(
      connector.id,
      plan.included.flatMap((i) => {
        const elementId = imported.keyToId[i.externalKey];
        return elementId ? [{ externalKey: i.externalKey, elementId, syncedVersion: versions.get(elementId) ?? 1, sourceHash: i.hash }] : [];
      }),
    );
  }

  return {
    connector: { id: connector.id, key: connector.key, name: connector.name },
    dryRun: params.dryRun,
    applied,
    ok: imported.ok && mapped.problems.length === 0,
    records: fetched.records.length,
    pages: fetched.pages,
    elements: imported.elements,
    relationships: imported.relationships,
    unchanged: plan.unchanged.length,
    conflicts: { count: plan.conflicts.length, items: first(plan.conflicts) },
    deletedInD4: { count: plan.deletedInD4.length, items: first(plan.deletedInD4) },
    missingInSource: { count: plan.missingInSource.length, items: first(plan.missingInSource) },
    unresolved: { count: plan.unresolved.length, items: first(plan.unresolved) },
    mappingProblems: { count: mapped.problems.length, items: first(mapped.problems) },
    issues: first(imported.issues, 50),
  };
}

/** Starts the syncs whose cadence is due: one job each, owned by the connector's creator. */
export async function runDueConnectors(db: Db, queue: Pick<JobQueue, 'enqueue'>, now = new Date()): Promise<string[]> {
  const due = await claimDueConnectors(db, now, (row: ConnectorRow) => nextRun(Cadence.parse(row.cadence), now));
  const started: string[] = [];
  for (const c of due) {
    try {
      await assertJobQuota(db, c.tenantId, now);
    } catch {
      continue; // over quota: this run is skipped, the cadence continues
    }
    const job = await new JobStore(db).create(c.tenantId, { workspaceId: c.workspaceId, kind: 'sync', params: { connectorId: c.id, dryRun: false }, createdBy: c.createdBy });
    await queue.enqueue({ tenantId: c.tenantId, jobId: job.id });
    await new ConnectorStore(db).recordRun(c.tenantId, c.id, job.id, now);
    started.push(job.id);
  }
  return started;
}
