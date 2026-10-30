import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { ConnectionsQuery, CreateElementBody, DeleteQuery, ListElementsQuery, NeighbourhoodQuery, UpdateBody } from './model.schemas';
import { resolveView } from './view';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { z } from '../http/zod';
import { ValidBody, ValidQuery } from '../http/zod.pipe';

@Controller('v1/workspaces/:ws/elements')
export class ElementsController {

  @Get()
  async list(@Workspace('read') { queries, scope }: OpenWorkspace, @ValidQuery(ListElementsQuery) q: z.output<typeof ListElementsQuery>) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.listElements(
      scope.workspaceId,
      { types: q.type, layer: q.layer, lifecycle: q.lifecycle, search: q.q },
      { first: q.first, after: q.after },
      view,
    );
  }

  @Post()
  async create(@Workspace('write') { service, scope }: OpenWorkspace, @ValidBody(CreateElementBody) input: z.output<typeof CreateElementBody>) {
    return service.createElement(scope.ctx, input);
  }

  @Get(':id')
  async get(@Workspace('read') { queries, scope }: OpenWorkspace, @Param('id') id: string) {

    const el = await queries.getElement(scope.workspaceId, id);
    if (!el) throw new NotFoundException(`Element '${id}' not found`);
    return el;
  }

  @Patch(':id')
  async update(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidBody(UpdateBody) input: z.output<typeof UpdateBody>,
  ) {
    return service.updateElement(scope.ctx, { id, ...input });
  }

  /** Soft delete; attached relationships are deleted too. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidQuery(DeleteQuery) { expectedVersion }: z.output<typeof DeleteQuery>,
  ) {
    await service.deleteElement(scope.ctx, { id, expectedVersion });
  }

  @Get(':id/relationships')
  async connections(
    @Workspace('read') { queries, scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidQuery(ConnectionsQuery) q: z.output<typeof ConnectionsQuery>,
  ) {
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.connections(scope.workspaceId, id, { direction: q.direction, types: q.type }, view);
  }

  @Get(':id/neighbourhood')
  async neighbourhood(
    @Workspace('read') { queries, scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidQuery(NeighbourhoodQuery) q: z.output<typeof NeighbourhoodQuery>,
  ) {
    const sub = await queries.neighbourhood(scope.workspaceId, id, {
      depth: q.depth,
      types: q.type,
      limit: q.limit,
      view: await resolveView(queries, scope.registry, scope.workspaceId, q),
    });
    if (!sub) throw new NotFoundException(`Element '${id}' not found`);
    return sub;
  }

  /** Change history from the event log, oldest first. */
  @Get(':id/history')
  async history(@Workspace('read') { events, scope }: OpenWorkspace, @Param('id') id: string) {

    const list = await events.forSubject(scope.tenantId, id);
    return list.filter((e) => e.workspaceId === scope.workspaceId);
  }
}
