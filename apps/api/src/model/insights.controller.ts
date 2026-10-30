import { Controller, Get, Param, Query } from '@nestjs/common';
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
import { parse } from '../http/errors';
import { MatrixParams, ViewArgsSchema } from '../http/schemas';
import { resolveView } from './view';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';

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
  /** Matrices: crud, capability-application, data-store-roles, lifecycle. */
  @Get('matrix/:kind')
  async matrix(@Workspace('read') { scope, queries }: OpenWorkspace, @Param('kind') kind: string, @Query() query: unknown) {
    const { kind: k } = parse(MatrixParams, { kind });
    const q = parse(ViewArgsSchema, query);
    return matrixFor(queries, scope.registry, scope.workspaceId, k, q);
  }

  /** The decision log (ADRs), newest first. */
  @Get('decisions')
  async decisions(@Workspace('read') { scope, queries }: OpenWorkspace, @Query() query: unknown) {
    const q = parse(ViewArgsSchema, query);
    return decisionsFor(queries, scope.registry, scope.workspaceId, q);
  }
}
