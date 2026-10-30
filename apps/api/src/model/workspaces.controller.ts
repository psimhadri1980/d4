import { Controller, Get, Inject, Param } from '@nestjs/common';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { WorkspaceAccess } from './workspace-access.service';

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    @Inject(WorkspaceStore) private readonly workspaceStore: WorkspaceStore,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
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
  async metamodel(@CurrentPrincipal() p: Principal, @Param('ws') ws: string) {
    const scope = await this.access.resolve(p, ws, 'read');
    return scope.registry.metamodel;
  }
}
