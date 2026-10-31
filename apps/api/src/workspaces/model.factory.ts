import { Inject, Injectable } from '@nestjs/common';
import { modelHandles, type ModelHandles } from '@d4/jobs';
import { GraphQuotaGuard } from '@d4/infra';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import type { WorkspaceScope } from './workspace-access.service';

export type { ModelHandles };

/** Builds the per-request domain objects for one tenant workspace (see `modelHandles`). */
@Injectable()
export class ModelFactory {
  /** One per process, so its cached graph counts are shared by every request. */
  private readonly quota: GraphQuotaGuard;

  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
  ) {
    this.quota = new GraphQuotaGuard(database.db);
  }

  for(scope: WorkspaceScope): ModelHandles {
    return modelHandles(this.database.db, scope.registry, this.graph.sessions(scope.tenantId), scope.tenantId, this.quota);
  }
}
