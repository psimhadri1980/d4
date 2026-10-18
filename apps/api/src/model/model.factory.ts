import { Inject, Injectable } from '@nestjs/common';
import { modelHandles, type ModelHandles } from '@d4/jobs';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import type { WorkspaceScope } from './workspace-access.service';

export type { ModelHandles };

/** Builds the per-request domain objects for one tenant workspace (see `modelHandles`). */
@Injectable()
export class ModelFactory {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
  ) {}

  for(scope: WorkspaceScope): ModelHandles {
    return modelHandles(this.database.db, scope.registry, this.graph.sessions(scope.tenantId), scope.tenantId);
  }
}
