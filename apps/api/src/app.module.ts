import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { jwksProvider } from './auth/identity';
import { APP_CONFIG, loadConfig } from './config';
import { GraphqlService } from './graphql/graphql.service';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/errors';
import { OpenApiController } from './http/openapi';
import { Database } from './infra/database.service';
import { TenantGraphService } from './infra/tenant-graph.service';
import { ElementsController } from './model/elements.controller';
import { ModelFactory } from './model/model.factory';
import { RelationshipsController } from './model/relationships.controller';
import { TransferController } from './model/transfer.controller';
import { WorkspaceAccess } from './model/workspace-access.service';
import { WorkspacesController } from './model/workspaces.controller';

@Module({
  controllers: [
    HealthController,
    OpenApiController,
    WorkspacesController,
    ElementsController,
    RelationshipsController,
    TransferController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    jwksProvider,
    Database,
    TenantGraphService,
    AuthService,
    WorkspaceAccess,
    ModelFactory,
    GraphqlService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
