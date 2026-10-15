import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, jwksProvider } from './auth/auth.guard';
import { APP_CONFIG, loadConfig } from './config';
import { ControlPlaneService } from './control-plane.service';
import { HealthController } from './health/health.controller';
import { TenantGraphService } from './neo4j/tenant-graph.service';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    jwksProvider,
    ControlPlaneService,
    TenantGraphService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
