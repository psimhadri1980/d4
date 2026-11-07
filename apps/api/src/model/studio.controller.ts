import { Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { DomainError, ulid } from '@d4/core';
import { queryRootIds, STUDIO_MAX_ROOTS } from '@d4/graph';
import { StudioLensStore, type StudioLensRow } from '@d4/db';
import { StudioCountsBody, StudioLensBody, StudioProfileBody, StudioSearchBody } from './model.schemas';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { WorkspaceAccess } from '../workspaces/workspace-access.service';
import { CatalogService } from '../catalog/catalog.service';
import { QueryRunService } from '../catalog/query-run.service';
import { resolveView } from './view';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { z } from '../http/zod';
import { ValidBody } from '../http/zod.pipe';

/** Graph Studio reads. A POST because a lens does not fit in a query string; nothing is written. */
@Controller('v1/workspaces/:ws/studio')
export class StudioController {
  constructor(
    @Inject(StudioLensStore) private readonly lenses: StudioLensStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(QueryRunService) private readonly runner: QueryRunService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  @Post('search')
  @HttpCode(200)
  async search(
    @CurrentPrincipal() p: Principal,
    @Workspace('read') { queries, studio, scope }: OpenWorkspace,
    @ValidBody(StudioSearchBody) b: z.output<typeof StudioSearchBody>,
  ) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, b);
    let ids = b.ids;
    if (b.query) {
      // A query lens (D84): the catalog run path checks the grant, the version and the parameters.
      const run = await this.runner.run(p, scope.workspaceId, b.query.id, { params: b.query.params, version: b.query.version });
      const found = queryRootIds(run);
      if (!found.length && run.rows.length) throw new DomainError('VALIDATION', 'The lens query must return element ids in an `id` column, or element nodes');
      if (found.length > STUDIO_MAX_ROOTS || run.truncated) return { roots: [], elements: [], relationships: [], tooLarge: true, nodeCount: found.length };
      const within = b.ids ? new Set(b.ids) : null;
      ids = within ? found.filter((id) => within.has(id)) : found;
      if (!ids.length) return { roots: [], elements: [], relationships: [], tooLarge: false, nodeCount: 0 };
    }
    return studio.search(
      scope.workspaceId,
      { ids, types: b.types, name: b.name, attributes: b.attributes, facets: b.facets, match: b.match },
      { depth: b.depth, maxNodes: b.maxNodes, view },
    );
  }

  /** Root counts per search, for the lens list while the user has not chosen a lens (LS-5). */
  @Post('counts')
  @HttpCode(200)
  async counts(@Workspace('read') { queries, studio, scope }: OpenWorkspace, @ValidBody(StudioCountsBody) b: z.output<typeof StudioCountsBody>) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, b);
    return { counts: await studio.countRoots(scope.workspaceId, b.searches, b.cap, view, b.sample) };
  }

  /** What the lens editor offers for a contour: links to other types, and attribute values, with counts. */
  @Post('profile')
  @HttpCode(200)
  async profile(@Workspace('read') { queries, studio, scope }: OpenWorkspace, @ValidBody(StudioProfileBody) b: z.output<typeof StudioProfileBody>) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, b);
    return studio.profile(scope.workspaceId, b.type, b.attributes, view);
  }

  /** The caller's own lenses and every workspace lens (D82). */
  @Get('lenses')
  async listLenses(@Workspace('read') { scope }: OpenWorkspace) {
    return (await this.lenses.list(scope.tenantId, scope.workspaceId, scope.ctx.actor)).map(toLens);
  }

  @Post('lenses')
  async createLens(@CurrentPrincipal() p: Principal, @Workspace('read') { scope }: OpenWorkspace, @ValidBody(StudioLensBody) b: z.output<typeof StudioLensBody>) {
    await this.checkLens(p, scope.workspaceId, scope.registry, b);
    return toLens(await this.lenses.create(scope.tenantId, scope.workspaceId, ulid(), fields(b), scope.ctx.actor));
  }

  /** Only the lens's owner may change or delete it; others copy it ("Start from…"). */
  @Put('lenses/:id')
  async updateLens(
    @CurrentPrincipal() p: Principal,
    @Workspace('read') { scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidBody(StudioLensBody) b: z.output<typeof StudioLensBody>,
  ) {
    await this.owned(scope.tenantId, scope.workspaceId, id, scope.ctx.actor);
    await this.checkLens(p, scope.workspaceId, scope.registry, b);
    return toLens((await this.lenses.update(scope.tenantId, scope.workspaceId, id, fields(b)))!);
  }

  @Delete('lenses/:id')
  @HttpCode(204)
  async deleteLens(@Workspace('read') { scope }: OpenWorkspace, @Param('id') id: string) {
    await this.owned(scope.tenantId, scope.workspaceId, id, scope.ctx.actor);
    await this.lenses.remove(scope.tenantId, scope.workspaceId, id);
  }

  private async owned(tenantId: string, workspaceId: string, id: string, actor: string): Promise<StudioLensRow> {
    const row = await this.lenses.get(tenantId, workspaceId, id);
    // Someone else's private lens does not exist as far as the caller can tell.
    if (!row || (row.visibility === 'private' && row.createdBy !== actor)) throw new NotFoundException(`Lens '${id}' not found`);
    if (row.createdBy !== actor) throw new ForbiddenException('Only the owner of a lens can change or delete it');
    return row;
  }

  /** Types and relationships must exist in the metamodel; sharing a lens needs write access. */
  private async checkLens(p: Principal, workspaceId: string, registry: OpenWorkspace['scope']['registry'], b: z.output<typeof StudioLensBody>) {
    for (const t of [b.contour.type, ...b.facets.flatMap((f) => f.types)]) if (!registry.nodeType(t)) throw new RangeError(`Unknown element type '${t}'`);
    for (const f of b.facets) if (f.relationship && !registry.relationshipType(f.relationship)) throw new RangeError(`Unknown relationship type '${f.relationship}'`);
    if (b.visibility === 'workspace') await this.access.resolve(p, workspaceId, 'write');
    // A query the caller cannot see does not exist for them.
    if (b.query) await this.catalog.entry(p, b.query.id);
  }
}

const fields = (b: z.output<typeof StudioLensBody>) => {
  const { name, description, visibility, ...body } = b;
  return { name, description: description ?? null, visibility, body };
};

const toLens = (r: StudioLensRow) => ({
  ...(r.body as object),
  id: r.id,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  visibility: r.visibility,
  owner: r.createdBy,
  updatedAt: r.updatedAt.toISOString(),
});
