import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  buildMatrix,
  DECISION_RELATIONSHIPS,
  decisionLog,
  LIFECYCLE,
  lifecycleMatrix,
  MATRIX_ELEMENT_TYPES,
  MATRIX_RELATIONSHIPS,
  type DecisionRecord,
  type Matrix,
  type MatrixKind,
} from '@d4/core';
import type { GraphQueries } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { MatrixParams, ViewArgsSchema } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { resolveView } from './view';
import { WorkspaceAccess } from './workspace-access.service';

type Queries = Pick<GraphQueries, 'getElement' | 'subgraphOf' | 'lifecycleCounts'>;
interface ViewQ {
  asOf?: string;
  scenario?: string;
}

/** Shared by REST and GraphQL. */
export async function matrixFor(queries: Queries, registry: MetamodelRegistry, ws: string, kind: MatrixKind, q: ViewQ): Promise<Matrix & { truncated: boolean }> {
  const view = await resolveView(queries, registry, ws, q);
  if (kind === 'lifecycle') return { ...lifecycleMatrix(await queries.lifecycleCounts(ws, view), [...LIFECYCLE]), truncated: false };
  const g = await queries.subgraphOf(ws, MATRIX_RELATIONSHIPS[kind], MATRIX_ELEMENT_TYPES[kind], view);
  return { ...buildMatrix(kind, g), truncated: g.truncated };
}

export async function decisionsFor(queries: Queries, registry: MetamodelRegistry, ws: string, q: ViewQ): Promise<DecisionRecord[]> {
  const view = await resolveView(queries, registry, ws, q);
  return decisionLog(await queries.subgraphOf(ws, DECISION_RELATIONSHIPS, ['Decision'], view));
}

@Controller('v1/workspaces/:ws')
export class InsightsController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  /** Matrices: crud, capability-application, data-store-roles, lifecycle. */
  @Get('matrix/:kind')
  async matrix(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('kind') kind: string, @Query() query: unknown) {
    const { kind: k } = parse(MatrixParams, { kind });
    const q = parse(ViewArgsSchema, query);
    const scope = await this.access.resolve(p, ws, 'read');
    return matrixFor(this.models.for(scope).queries, scope.registry, scope.workspaceId, k, q);
  }

  /** The decision log (ADRs), newest first. */
  @Get('decisions')
  async decisions(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(ViewArgsSchema, query);
    const scope = await this.access.resolve(p, ws, 'read');
    return decisionsFor(this.models.for(scope).queries, scope.registry, scope.workspaceId, q);
  }
}
