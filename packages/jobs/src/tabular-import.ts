import { parseCsv, readWorkbook, suggestMapping, tablesToImport, type RowIssue, type Table, type TableMapping } from '@d4/codecs';
import { DomainError, planImport, type CommandContext, type ImportCounts, type ModelIssue } from '@d4/core';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { ModelHandles } from './model-handles';

export const MAX_TABULAR_ROWS = 50_000;

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

/** Decodes uploads into tables: CSV is one table, a workbook one per sheet. */
export async function readTables(files: UploadedFile[]): Promise<Table[]> {
  const tables: Table[] = [];
  for (const f of files) {
    if (/\.(csv|txt)$/i.test(f.name)) tables.push(parseCsv(f.name, new TextDecoder().decode(f.bytes)));
    else if (/\.xlsx$/i.test(f.name)) {
      try {
        tables.push(...(await readWorkbook(f.name, f.bytes)));
      } catch {
        throw new DomainError('VALIDATION', `${f.name} is not a readable .xlsx workbook`);
      }
    } else throw new DomainError('VALIDATION', `${f.name}: only .csv and .xlsx files can be imported`);
  }
  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  if (rows > MAX_TABULAR_ROWS) throw new DomainError('VALIDATION', `${rows} rows is more than the ${MAX_TABULAR_ROWS} allowed in one import`);
  return tables;
}

export interface TabularImportResult {
  ok: boolean;
  applied: boolean;
  issues: ModelIssue[];
  rowIssues: RowIssue[];
  rowsUsed: Record<string, number>;
  elements: ImportCounts;
  relationships: ImportCounts;
  keyToId: Record<string, string>;
}

/**
 * Plans (dry run) or applies mapped spreadsheet rows. Row problems block the import: a partial
 * import would surprise more than it helps. Shared by the import endpoint and import jobs.
 */
export async function runTabularImport(
  handles: Pick<ModelHandles, 'queries' | 'repository'>,
  reg: MetamodelRegistry,
  ctx: CommandContext,
  files: UploadedFile[],
  mappings: { table: string; mapping: TableMapping }[],
  dryRun: boolean,
  onProgress?: (percent: number) => Promise<void>,
): Promise<TabularImportResult> {
  const tables = await readTables(files);
  await onProgress?.(20);
  const byName = new Map(mappings.map((m) => [m.table, m.mapping]));
  const mapped = tables.map((table) => ({ table, mapping: byName.get(table.name) ?? suggestMapping(table, reg) }));
  const existing = await handles.queries.snapshot(ctx.workspaceId);
  await onProgress?.(40);
  const converted = tablesToImport(mapped, reg, existing);
  const plan = planImport(reg, ctx, converted.input, existing);
  await onProgress?.(70);
  const { change, ...summary } = plan;
  const ok = plan.ok && converted.issues.length === 0;
  const hasChanges = !!change && (change.elements.length > 0 || change.relationships.length > 0);
  if (ok && !dryRun && hasChanges) await handles.repository.apply(ctx.workspaceId, change!);
  return { ...summary, ok, applied: ok && !dryRun && hasChanges, rowIssues: converted.issues, rowsUsed: converted.used };
}
