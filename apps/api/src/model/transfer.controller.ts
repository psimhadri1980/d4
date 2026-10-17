import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { fromSnapshot, toImportInput, validateModelDocument } from '@d4/codecs';
import { planImport } from '@d4/core';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/schemas';
import { Database } from '../infra/database.service';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

const ImportQuery = z.object({ dryRun: z.enum(['true', 'false']).optional() });

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

  @Get('export')
  async export(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    const scope = await this.access.resolve(p, ws, 'read');
    const { queries } = this.models.for(scope);
    const row = await new WorkspaceStore(this.database.db).get(scope.tenantId, scope.workspaceId);
    const mm = scope.registry.metamodel;
    return fromSnapshot(scope.registry, await queries.snapshot(scope.workspaceId), {
      name: row?.name ?? scope.workspaceId,
      ...(row?.description && { description: row.description }),
      metamodel: `${mm.id}@${mm.version}`,
      exportedAt: new Date().toISOString(),
    });
  }
}
