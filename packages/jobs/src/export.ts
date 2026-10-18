import {
  elementsToCsv,
  EXPORT_FORMATS,
  EXPORT_MEDIA,
  fromSnapshot,
  relationshipsToCsv,
  stringifyModelDocument,
  toArchiMate,
  toCypherScript,
  toMermaid,
  toWorkbook,
  type ExportFormat,
  type ModelDocument,
} from '@d4/codecs';
import type { ModelSnapshot } from '@d4/core';
import { resolveView, type GraphQueries } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import { z } from 'zod';

export const ExportParams = z.object({
  format: z.enum(EXPORT_FORMATS).optional(),
  scope: z.array(z.string()).max(50).optional(),
  depth: z.number().int().min(1).max(3).optional(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  scenario: z.string().optional(),
});
export type ExportParams = z.infer<typeof ExportParams>;

export interface WorkspaceMeta {
  name: string;
  slug: string;
  description?: string | null;
}

export interface ExportFile {
  body: Uint8Array | string;
  contentType: string;
  filename: string;
  /** Counts for job results and logs. */
  elements: number;
  relationships: number;
}

type Queries = Pick<GraphQueries, 'getElement' | 'snapshot' | 'neighbourhood'>;

/** The workspace, or the neighbourhood of `scope` elements, as seen in the view. */
export async function exportSnapshot(queries: Queries, reg: MetamodelRegistry, workspaceId: string, p: ExportParams): Promise<ModelSnapshot> {
  const view = await resolveView(queries, reg, workspaceId, p);
  if (!p.scope?.length) return queries.snapshot(workspaceId, p.asOf || p.scenario ? view : undefined);
  const elements = new Map<string, ModelSnapshot['elements'][number]>();
  const relationships = new Map<string, ModelSnapshot['relationships'][number]>();
  for (const id of p.scope) {
    const sub = await queries.neighbourhood(workspaceId, id, { depth: p.depth ?? 1, limit: 2000, view });
    if (!sub) continue;
    for (const e of [sub.root, ...sub.elements]) elements.set(e.id, e);
    for (const r of sub.relationships) relationships.set(r.id, r);
  }
  return { elements: [...elements.values()], relationships: [...relationships.values()] };
}

export function modelDocument(reg: MetamodelRegistry, snapshot: ModelSnapshot, ws: WorkspaceMeta): ModelDocument {
  const mm = reg.metamodel;
  return fromSnapshot(reg, snapshot, {
    name: ws.name,
    ...(ws.description && { description: ws.description }),
    metamodel: `${mm.id}@${mm.version}`,
    exportedAt: new Date().toISOString(),
  });
}

/** Renders one export format. Shared by the export endpoint and export jobs. */
export async function renderExport(reg: MetamodelRegistry, snapshot: ModelSnapshot, ws: WorkspaceMeta, format: ExportFormat, asOf?: string): Promise<ExportFile> {
  const body =
    format === 'xlsx'
      ? await toWorkbook({ elements: elementsToCsv(snapshot, reg), relationships: relationshipsToCsv(snapshot) })
      : format === 'yaml' || format === 'json'
        ? stringifyModelDocument(modelDocument(reg, snapshot, ws), format)
        : format === 'elements-csv'
          ? elementsToCsv(snapshot, reg)
          : format === 'relationships-csv'
            ? relationshipsToCsv(snapshot)
            : format === 'mermaid'
              ? toMermaid(snapshot, reg, ws.name)
              : format === 'archimate'
                ? toArchiMate(snapshot, reg, { name: ws.name, ...(ws.description && { documentation: ws.description }) }).xml
                : toCypherScript(snapshot, reg);
  const media = EXPORT_MEDIA[format];
  return {
    body,
    contentType: format === 'xlsx' ? media.contentType : `${media.contentType}; charset=utf-8`,
    filename: `${ws.slug.replace(/[^a-z0-9-]/gi, '-')}${asOf ? `-${asOf}` : ''}.${media.extension}`,
    elements: snapshot.elements.length,
    relationships: snapshot.relationships.length,
  };
}
