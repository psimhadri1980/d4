import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import { toImportInput, validateModelDocument } from '@d4/codecs';
import { planImport } from '@d4/core';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { exportSnapshot, modelDocument, renderExport } from '@d4/jobs';
import { ExportQuery } from './model.schemas';
import { z } from '../http/zod';
import { ModelFactory } from '../workspaces/model.factory';
import { WorkspaceAccess } from '../workspaces/workspace-access.service';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { ValidQuery } from '../http/zod.pipe';

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });

/** The part of Fastify's reply we use; keeps fastify types out of the controller. */
interface Reply {
  header(name: string, value: string): unknown;
}

/** Model-as-code: whole-workspace import (idempotent, single change set) and export. */
@Controller('v1/workspaces/:ws')
export class TransferController {
  constructor(
    @Inject(WorkspaceStore) private readonly workspaceStore: WorkspaceStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Post('import')
  @HttpCode(200)
  async import(
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Query() query: unknown,
    @Body() body: unknown,
  ) {
    const dryRun = parse(ImportQuery, query).dryRun === 'true';
    // Dry runs only need read access.
    const scope = await this.access.resolve(p, ws, dryRun ? 'read' : 'write');
    const doc = validateModelDocument(body);
    const { queries, repository } = this.models.for(scope);

    const plan = planImport(scope.registry, scope.ctx, toImportInput(doc), await queries.snapshot(scope.workspaceId));
    const { change, ...summary } = plan;

    const hasChanges = !!change && (change.elements.length > 0 || change.relationships.length > 0);
    if (plan.ok && !dryRun && hasChanges) {
      // One unit of work: a single Neo4j transaction and a single event-log transaction.
      await repository.apply(scope.workspaceId, change!);
    }
    return { ...summary, applied: plan.ok && !dryRun && hasChanges };
  }

  /**
   * Exports the workspace, or the neighbourhood of `scope` elements, in a view. Without `format`
   * this returns the model document as JSON (what `d4 export` and re-import use).
   */
  @Get('export')
  async export(
    @Workspace('read') { scope, queries }: OpenWorkspace,
    @ValidQuery(ExportQuery) q: z.output<typeof ExportQuery>,
    @Res({ passthrough: true }) reply: Reply,
  ) {
    const snapshot = await exportSnapshot(queries, scope.registry, scope.workspaceId, q);
    const row = await this.workspaceStore.get(scope.tenantId, scope.workspaceId);
    const meta = { name: row?.name ?? scope.workspaceId, slug: row?.slug ?? 'model', description: row?.description ?? null };
    if (!q.format) return modelDocument(scope.registry, snapshot, meta);

    const file = await renderExport(scope.registry, snapshot, meta, q.format, q.asOf);
    reply.header('content-type', file.contentType);
    reply.header('content-disposition', `attachment; filename="${file.filename}"`);
    return typeof file.body === 'string' ? file.body : Buffer.from(file.body);
  }
}
