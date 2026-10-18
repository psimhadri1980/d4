import { Body, Controller, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { parseCsv, readWorkbook, suggestMapping, tablesToImport, type Table, type TableMapping } from '@d4/codecs';
import { DomainError, planImport } from '@d4/core';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { TabularAnalyzeBody, TabularImportBody, z } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });
export const MAX_TABULAR_ROWS = 50_000;
const PREVIEW_ROWS = 5;

/** Decodes uploaded files (base64) into tables: CSV is one table, a workbook one per sheet. */
async function readTables(files: { name: string; content: string }[]): Promise<Table[]> {
  const tables: Table[] = [];
  for (const f of files) {
    const bytes = Buffer.from(f.content, 'base64');
    if (/\.csv$/i.test(f.name) || /\.txt$/i.test(f.name)) tables.push(parseCsv(f.name, bytes.toString('utf8')));
    else if (/\.xlsx$/i.test(f.name)) {
      try {
        tables.push(...(await readWorkbook(f.name, new Uint8Array(bytes))));
      } catch {
        throw new DomainError('VALIDATION', `${f.name} is not a readable .xlsx workbook`);
      }
    } else throw new DomainError('VALIDATION', `${f.name}: only .csv and .xlsx files can be imported`);
  }
  const rows = tables.reduce((n, t) => n + t.rows.length, 0);
  if (rows > MAX_TABULAR_ROWS) throw new DomainError('VALIDATION', `${rows} rows is more than the ${MAX_TABULAR_ROWS} allowed in one import`);
  return tables;
}

/**
 * Spreadsheet import in two steps: `analyze` reads the files and suggests a mapping per table;
 * the import then plans (dry run) or applies the mapped rows like a model document import.
 */
@Controller('v1/workspaces/:ws/import/tabular')
export class TabularController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Post('analyze')
  @HttpCode(200)
  async analyze(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const { files } = parse(TabularAnalyzeBody, body);
    const scope = await this.access.resolve(p, ws, 'read');
    const tables = await readTables(files);
    return {
      tables: tables.map((t) => ({
        name: t.name,
        headers: t.headers,
        rowCount: t.rows.length,
        preview: t.rows.slice(0, PREVIEW_ROWS),
        mapping: suggestMapping(t, scope.registry),
      })),
    };
  }

  @Post()
  @HttpCode(200)
  async import(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown, @Body() body: unknown) {
    const dryRun = parse(ImportQuery, query).dryRun === 'true';
    const { files, mappings } = parse(TabularImportBody, body);
    // Dry runs only need read access, as for model documents.
    const scope = await this.access.resolve(p, ws, dryRun ? 'read' : 'write');
    const tables = await readTables(files);
    const byName = new Map(mappings.map((m) => [m.table, m.mapping as TableMapping]));
    const mapped = tables.map((table) => ({ table, mapping: byName.get(table.name) ?? suggestMapping(table, scope.registry) }));

    const { queries, repository } = this.models.for(scope);
    const existing = await queries.snapshot(scope.workspaceId);
    const converted = tablesToImport(mapped, scope.registry, existing);
    const plan = planImport(scope.registry, scope.ctx, converted.input, existing);
    const { change, ...summary } = plan;
    // Row problems block the import too: a partial import would surprise more than it helps.
    const ok = plan.ok && converted.issues.length === 0;
    const hasChanges = !!change && (change.elements.length > 0 || change.relationships.length > 0);
    if (ok && !dryRun && hasChanges) await repository.apply(scope.workspaceId, change!);
    return { ...summary, ok, applied: ok && !dryRun && hasChanges, rowIssues: converted.issues, rowsUsed: converted.used };
  }
}
