import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { roadmapFromGraph, type LaneKind, type RoadmapView } from '@d4/core';
import type { GraphQueries } from '@d4/graph';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { RoadmapQuery } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';

const today = () => new Date().toISOString().slice(0, 10);

/** Builds a scheduled roadmap for a scope; shared by REST and GraphQL. */
export async function roadmapFor(
  handles: { queries: Pick<GraphQueries, 'planningGraph'> },
  workspaceId: string,
  scope: string[],
  opts: { lanes?: LaneKind; today?: string },
): Promise<RoadmapView> {
  const graph = await handles.queries.planningGraph(workspaceId, scope);
  return roadmapFromGraph(graph, { lanes: opts.lanes, today: opts.today ?? today() });
}

@Controller('v1/workspaces/:ws/roadmap')
export class RoadmapController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Get()
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(RoadmapQuery, query);
    const scope = await this.access.resolve(p, ws, 'read');
    return roadmapFor(this.models.for(scope), scope.workspaceId, q.scope, { lanes: q.lanes, today: q.today });
  }
}
