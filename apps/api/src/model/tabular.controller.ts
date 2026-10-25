import { Body, Controller, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { suggestMapping, type TableMapping } from '@d4/codecs';
import { readTables, runTabularImport } from '@d4/jobs';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { TabularAnalyzeBody, TabularImportBody, z } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });
const PREVIEW_ROWS = 5;

const decodeUploads =(files: { name: string; content: string }[]) =>
  files.map((f) => ({ name: f.name, bytes: new Uint8Array(Buffer.from(f.content, 'base64')) }));

/**
 * Spreadsheet import in two steps: `analyze` reads the files and suggests a mapping per table;
 * the import then plans (dry run) or applies the mapped rows like a model document import. For
 * large files, the same work runs as a background job (see JobsController).
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
    const tables = await readTables(decodeUploads(files));
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
    return runTabularImport(this.models.for(scope), scope.registry, scope.ctx, decodeUploads(files), mappings as { table: string; mapping: TableMapping }[], dryRun);
  }
}
