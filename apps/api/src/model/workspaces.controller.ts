import { Controller, Get, Inject, Param } from '@nestjs/common';
import { WorkspaceStore } from '@d4/db';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Database } from '../infra/database.service';
import { WorkspaceAccess } from './workspace-access.service';

@Controller('v1/workspaces')
export class WorkspacesController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
  ) {}

  @Get()
  async list(@CurrentPrincipal() p: Principal) {
    const rows = await new WorkspaceStore(this.database.db).list(p.tenantId);
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
