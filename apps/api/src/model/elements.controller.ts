import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import {
  ConnectionsQuery,
  CreateElementBody,
  DeleteQuery,
  ListElementsQuery,
  NeighbourhoodQuery,
  UpdateBody,
} from '../http/schemas';
import { ModelFactory } from './model.factory';
import { resolveView } from './view';
import { WorkspaceAccess, type Access } from './workspace-access.service';

@Controller('v1/workspaces/:ws/elements')
export class ElementsController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Query() query: unknown) {
    const q = parse(ListElementsQuery, query);
    const { queries, scope } = await this.open(p, ws, 'read');
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.listElements(
      scope.workspaceId,
      { types: q.type, layer: q.layer, lifecycle: q.lifecycle, search: q.q },
      { first: q.first, after: q.after },
      view,
    );
  }

  @Post()
  async create(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const input = parse(CreateElementBody, body);
    const { service, scope } = await this.open(p, ws, 'write');
    return service.createElement(scope.ctx, input);
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { queries, scope } = await this.open(p, ws, 'read');
    const el = await queries.getElement(scope.workspaceId, id);
    if (!el) throw new NotFoundException(`Element '${id}' not found`);
    return el;
  }

  @Patch(':id')
  async update(
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateBody, body);
    const { service, scope } = await this.open(p, ws, 'write');
    return service.updateElement(scope.ctx, { id, ...input });
  }

  /** Soft delete; attached relationships are deleted too. */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const { expectedVersion } = parse(DeleteQuery, query);
    const { service, scope } = await this.open(p, ws, 'write');
    await service.deleteElement(scope.ctx, { id, expectedVersion });
  }

  @Get(':id/relationships')
  async connections(
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(ConnectionsQuery, query);
    const { queries, scope } = await this.open(p, ws, 'read');
    const view = await resolveView(queries, scope.registry, scope.workspaceId, q);
    return queries.connections(scope.workspaceId, id, { direction: q.direction, types: q.type }, view);
  }

  @Get(':id/neighbourhood')
  async neighbourhood(
    @CurrentPrincipal() p: Principal,
    @Param('ws') ws: string,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const q = parse(NeighbourhoodQuery, query);
    const { queries, scope } = await this.open(p, ws, 'read');
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
  async history(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { events, scope } = await this.open(p, ws, 'read');
    const list = await events.forSubject(scope.tenantId, id);
    return list.filter((e) => e.workspaceId === scope.workspaceId);
  }

  private async open(p: Principal, ws: string, need: Access) {
    const scope = await this.access.resolve(p, ws, need);
    return { scope, ...this.models.for(scope) };
  }
}
