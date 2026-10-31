import { Controller, Get, Inject } from '@nestjs/common';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Workspace, type OpenWorkspace } from './workspace.decorator';

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    @Inject(WorkspaceStore) private readonly workspaceStore: WorkspaceStore,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal) {
    const rows = await this.workspaceStore.list(p.tenantId);
    return rows.map(({ id, slug, name, description, metamodelId }) => ({
      id,
      slug,
      name,
      description,
      metamodelId,
    }));
  }

  /** The workspace's metamodel, for building forms, pickers and legends. */
  @Get(':ws/metamodel')
  async metamodel(@Workspace('read') { scope }: OpenWorkspace) {

    return scope.registry.metamodel;
  }
}
