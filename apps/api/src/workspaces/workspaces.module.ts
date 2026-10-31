import { Global, Module } from '@nestjs/common';
import { ModelFactory } from './model.factory';
import { WorkspaceAccess } from './workspace-access.service';
import { WorkspacesController } from './workspaces.controller';

/** Workspace access checks and per-workspace model handles (`@Workspace(access)`), used by every feature. */
@Global()
@Module({
  controllers: [WorkspacesController],
  providers: [WorkspaceAccess, ModelFactory],
  exports: [WorkspaceAccess, ModelFactory],
})
export class WorkspacesModule {}
