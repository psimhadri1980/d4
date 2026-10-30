import { Controller, Get } from '@nestjs/common';
import { roadmapFromGraph, type LaneKind, type RoadmapView } from '@d4/core';
import type { GraphQueries } from '@d4/graph';
import { RoadmapQuery } from './model.schemas';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { z } from '../http/zod';
import { ValidQuery } from '../http/zod.pipe';

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
  @Get()
  async get(@Workspace('read') workspace: OpenWorkspace, @ValidQuery(RoadmapQuery) q: z.output<typeof RoadmapQuery>) {
    return roadmapFor(workspace, workspace.scope.workspaceId, q.scope, { lanes: q.lanes, today: q.today });
  }
}
