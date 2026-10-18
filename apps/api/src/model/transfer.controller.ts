import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from '@nestjs/common';
import {
  elementsToCsv,
  EXPORT_MEDIA,
  fromSnapshot,
  relationshipsToCsv,
  stringifyModelDocument,
  toArchiMate,
  toCypherScript,
  toImportInput,
  toMermaid,
  validateModelDocument,
} from '@d4/codecs';
import type { ModelSnapshot } from '@d4/core';
import { planImport } from '@d4/core';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { ExportQuery, z } from '../http/schemas';
import { resolveView } from './view';
import { Database } from '../infra/database.service';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });

/** The part of Fastify's reply we use; keeps fastify types out of the controller. */
interface Reply {
  header(name: string, value: string): unknown;
}

/** Model-as-code: whole-workspace import (idempotent, single change set) and export. */
@Controller('v1/workspaces/:ws')
export class TransferController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
    @Inject(Database) private readonly database: Database,
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
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) reply: Reply,
  ) {
    const q = parse(ExportQuery, query);
    const scope = await this.access.resolve(p, ws, 'read');
    const { queries } = this.models.for(scope);
    const reg = scope.registry;
    const isView = !!(q.asOf || q.scenario);
    const view = await resolveView(queries, reg, scope.workspaceId, q);

    let snapshot: ModelSnapshot;
    if (q.scope?.length) {
      const elements = new Map<string, ModelSnapshot['elements'][number]>();
      const relationships = new Map<string, ModelSnapshot['relationships'][number]>();
      for (const id of q.scope) {
        const sub = await queries.neighbourhood(scope.workspaceId, id, { depth: q.depth ?? 1, limit: 2000, view });
        if (!sub) continue;
        for (const e of [sub.root, ...sub.elements]) elements.set(e.id, e);
        for (const r of sub.relationships) relationships.set(r.id, r);
      }
      snapshot = { elements: [...elements.values()], relationships: [...relationships.values()] };
    } else {
      snapshot = await queries.snapshot(scope.workspaceId, isView ? view : undefined);
    }

    const row = await new WorkspaceStore(this.database.db).get(scope.tenantId, scope.workspaceId);
    const name = row?.name ?? scope.workspaceId;
    const mm = reg.metamodel;
    const doc = () =>
      fromSnapshot(reg, snapshot, {
        name,
        ...(row?.description && { description: row.description }),
        metamodel: `${mm.id}@${mm.version}`,
        exportedAt: new Date().toISOString(),
      });
    if (!q.format) return doc();

    const body =
      q.format === 'yaml' || q.format === 'json'
        ? stringifyModelDocument(doc(), q.format)
        : q.format === 'elements-csv'
          ? elementsToCsv(snapshot, reg)
          : q.format === 'relationships-csv'
            ? relationshipsToCsv(snapshot)
            : q.format === 'mermaid'
              ? toMermaid(snapshot, reg, name)
              : q.format === 'archimate'
                ? toArchiMate(snapshot, reg, { name, ...(row?.description && { documentation: row.description }) }).xml
                : toCypherScript(snapshot, reg);
    const media = EXPORT_MEDIA[q.format];
    const file = `${(row?.slug ?? 'model').replace(/[^a-z0-9-]/gi, '-')}${q.asOf ? `-${q.asOf}` : ''}.${media.extension}`;
    reply.header('content-type', `${media.contentType}; charset=utf-8`);
    reply.header('content-disposition', `attachment; filename="${file}"`);
    return body;
  }
}
