import { Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { CreateRelationshipBody, DeleteQuery, UpdateBody } from './model.schemas';
import { Workspace, type OpenWorkspace } from '../workspaces/workspace.decorator';
import { z } from '../http/zod';
import { ValidBody, ValidQuery } from '../http/zod.pipe';

@Controller('v1/workspaces/:ws/relationships')
export class RelationshipsController {

  @Post()
  async create(@Workspace('write') { service, scope }: OpenWorkspace, @ValidBody(CreateRelationshipBody) input: z.output<typeof CreateRelationshipBody>) {
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
    @ValidBody(UpdateBody) input: z.output<typeof UpdateBody>,
  ) {
    return service.updateRelationship(scope.ctx, { id, ...input });
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Workspace('write') { service, scope }: OpenWorkspace,
    @Param('id') id: string,
    @ValidQuery(DeleteQuery) { expectedVersion }: z.output<typeof DeleteQuery>,
  ) {
    await service.deleteRelationship(scope.ctx, { id, expectedVersion });
  }

  @Get(':id/history')
  async history(@Workspace('read') { events, scope }: OpenWorkspace, @Param('id') id: string) {

    const list = await events.forSubject(scope.tenantId, id);
    return list.filter((e) => e.workspaceId === scope.workspaceId);
  }
}
