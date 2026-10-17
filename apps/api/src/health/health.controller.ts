import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';

@Controller()
export class HealthController {
  constructor(
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
  ) {}

  /** Liveness: the process is up. */
  @Public()
  @Get('healthz')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: the control-plane database is reachable. */
  @Public()
  @Get('readyz')
  async ready() {
    try {
      await this.database.ping();
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('control plane unreachable');
    }
  }

  /** Authenticated: who am I, and is my tenant's graph reachable? */
  @Get('v1/me')
  async me(@CurrentPrincipal() principal: Principal) {
    let graph: 'ok' | 'unreachable' = 'ok';
    try {
      await this.graph.ping(principal.tenantId);
    } catch {
      graph = 'unreachable';
    }
    return { ...principal, graph };
  }
}
