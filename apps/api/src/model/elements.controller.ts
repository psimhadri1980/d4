import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { parse } from '../http/errors';
import {
  ConnectionsQuery,
  CreateElementBody,
  DeleteQuery,
  ListElementsQuery,
  NeighbourhoodQuery,
  UpdateBody,
} from '../http/schemas';
import { resolveView } from './view';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';

@Controller('v1/workspaces/:ws/elements')
export class ElementsController {
  constructor() {}

  @Get()
  async list(@Workspace('read') { queries, scope }: OpenWorkspace, @Query() query: unknown) {
    const q = parse(ListElementsQuery, query);
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.listElements(
      scope.workspaceId,
      { types: q.type, layer: q.layer, lifecycle: q.lifecycle, search: q.q },
      { first: q.first, after: q.after },
      view,
    );
  }

  @Post()
  async create(@Workspace('write') { service, scope }: OpenWorkspace, @Body() body: unknown) {
    const input = parse(CreateElementBody, body);
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
    @Body() body: unknown,
  ) {
    const input = parse(UpdateBody, body);
    return service.updateElement(scope.ctx, { id, ...input });
  }

  /** Soft delete; attached relationships are deleted too. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const { expectedVersion } = parse(DeleteQuery, query);
    await service.deleteElement(scope.ctx, { id, expectedVersion });
  }

  @Get(':id/relationships')
  async connections(
    @Workspace('read') { queries, scope }: OpenWorkspace,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(ConnectionsQuery, query);
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.connections(scope.workspaceId, id, { direction: q.direction, types: q.type }, view);
  }

  @Get(':id/neighbourhood')
  async neighbourhood(
    @Workspace('read') { queries, scope }: OpenWorkspace,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(NeighbourhoodQuery, query);
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
