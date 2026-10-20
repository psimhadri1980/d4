import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { CatalogController, CatalogRunController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { PackInstaller } from './catalog/pack-installer.service';
import { QueryRunService } from './catalog/query-run.service';
import { jwksProvider } from './auth/identity';
import { APP_CONFIG, loadConfig } from './config';
import { GraphqlService } from './graphql/graphql.service';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/errors';
import { OpenApiController } from './http/openapi';
import { Database } from './infra/database.service';
import { JobsInfra } from './infra/jobs.service';
import { TenantGraphService } from './infra/tenant-graph.service';
import { AdminController } from './model/admin.controller';
import { WebhooksController } from './model/webhooks.controller';
import { ProposalsController } from './model/proposals.controller';
import { ElementsController } from './model/elements.controller';
import { ModelFactory } from './model/model.factory';
import { DiffController } from './model/diff.controller';
import { InsightsController } from './model/insights.controller';
import { JobsController } from './model/jobs.controller';
import { RoadmapController } from './model/roadmap.controller';
import { SchedulesController } from './model/schedules.controller';
import { RelationshipsController } from './model/relationships.controller';
import { TabularController } from './model/tabular.controller';
import { TransferController } from './model/transfer.controller';
import { WorkspaceAccess } from './model/workspace-access.service';
import { WorkspacesController } from './model/workspaces.controller';

@Module({
  controllers: [
    HealthController,
    OpenApiController,
    WorkspacesController,
    AdminController,
    WebhooksController,
    ProposalsController,
    ElementsController,
    RelationshipsController,
    RoadmapController,
    DiffController,
    InsightsController,
    TransferController,
    TabularController,
    JobsController,
    SchedulesController,
    CatalogController,
    CatalogRunController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    jwksProvider,
    Database,
    TenantGraphService,
    JobsInfra,
    AuthService,
    WorkspaceAccess,
    ModelFactory,
    GraphqlService,
    PackInstaller,
    CatalogService,
    QueryRunService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
