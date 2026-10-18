import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { diffModels, type ModelDiff } from '@d4/core';
import type { GraphQueries } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { DiffQuery } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { resolveView } from './view';
import { WorkspaceAccess } from './workspace-access.service';

export type DiffResult = ModelDiff & { names: Record<string, string> };

/** Compares two views of a workspace; shared by REST and GraphQL. */
export async function diffFor(
  queries: Pick<GraphQueries, 'getElement' | 'snapshot'>,
  registry: MetamodelRegistry,
  workspaceId: string,
  q: { fromAsOf?: string; fromScenario?: string; toAsOf?: string; toScenario?: string },
): Promise<DiffResult> {
  const [from, to] = await Promise.all([
    resolveView(queries, registry, workspaceId, { asOf: q.fromAsOf, scenario: q.fromScenario }),
    resolveView(queries, registry, workspaceId, { asOf: q.toAsOf, scenario: q.toScenario }),
  ]);
  const snapshot = await queries.snapshot(workspaceId);
  const diff = diffModels(snapshot, from, to);
  // Relationship rows need the names of their ends, which may not be in the diff itself.
  const wanted = new Set(
    [...diff.relationships.added, ...diff.relationships.removed, ...diff.relationships.changed.map((c) => c.after)].flatMap((r) => [r.fromId, r.toId]),
  );
  const names: Record<string, string> = {};
  for (const e of snapshot.elements) if (wanted.has(e.id)) names[e.id] = String(e.attrs['name'] ?? e.id);
  return { ...diff, names };
}

@Controller('v1/workspaces/:ws/diff')
export class DiffController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Get()
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(DiffQuery, query);
    const scope = await this.access.resolve(p, ws, 'read');
    return diffFor(this.models.for(scope).queries, scope.registry, scope.workspaceId, q);
  }
}
