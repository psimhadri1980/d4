import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { CreateRelationshipBody, DeleteQuery, UpdateBody } from '../http/schemas';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess, type Access } from './workspace-access.service';

@Controller('v1/workspaces/:ws/relationships')
export class RelationshipsController {
  constructor(
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(ModelFactory) private readonly models: ModelFactory,
  ) {}

  @Post()
  async create(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Body() body: unknown) {
    const input = parse(CreateRelationshipBody, body);
    const { service, scope } = await this.open(p, ws, 'write');
    return service.createRelationship(scope.ctx, input);
  }

  @Get(':id')
  async get(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string) {
    const { queries, scope } = await this.open(p, ws, 'read');
    const rel = await queries.getRelationship(scope.workspaceId, id);
    if (!rel) throw new NotFoundException(`Relationship '${id}' not found`);
    return rel;
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
    return service.updateRelationship(scope.ctx, { id, ...input });
  }

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
    await service.deleteRelationship(scope.ctx, { id, expectedVersion });
  }

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
