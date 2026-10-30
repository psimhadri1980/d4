import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { parse } from '../http/errors';
import { CreateRelationshipBody, DeleteQuery, UpdateBody } from '../http/schemas';
import { Workspace, type OpenWorkspace } from './workspace.decorator';

@Controller('v1/workspaces/:ws/relationships')
export class RelationshipsController {
  constructor() {}

  @Post()
  async create(@Workspace('write') { service, scope }: OpenWorkspace, @Body() body: unknown) {
    const input = parse(CreateRelationshipBody, body);
    return service.createRelationship(scope.ctx, input);
  }

  @Get(':id')
  async get(@Workspace('read') { queries, scope }: OpenWorkspace, @Param('id') id: string) {

    const rel = await queries.getRelationship(scope.workspaceId, id);
    if (!rel) throw new NotFoundException(`Relationship '${id}' not found`);
    return rel;
  }

  @Patch(':id')
  async update(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(UpdateBody, body);
    return service.updateRelationship(scope.ctx, { id, ...input });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const { expectedVersion } = parse(DeleteQuery, query);
    await service.deleteRelationship(scope.ctx, { id, expectedVersion });
  }

  @Get(':id/history')
  async history(@Workspace('read') { events, scope }: OpenWorkspace, @Param('id') id: string) {

    const list = await events.forSubject(scope.tenantId, id);
    return list.filter((e) => e.workspaceId === scope.workspaceId);
  }
}
