import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/errors';
import { LoggingModule } from './http/logging';
import { OpenApiController } from './http/openapi';
import { InfraModule } from './infra/infra.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { JobsModule } from './jobs/jobs.module';
import { ModelModule } from './model/model.module';
import { WorkspacesModule } from './workspaces/workspaces.module';

@Module({
  imports: [LoggingModule, InfraModule, AuthModule, WorkspacesModule, ModelModule, CatalogModule, JobsModule, IntegrationsModule, AdminModule],
  controllers: [HealthController, OpenApiController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
