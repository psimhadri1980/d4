import type { Type } from '@nestjs/common';
import { AdminModule } from './admin/admin.module';
import { registerAdminRoutes } from './admin/admin.openapi';
import { CatalogModule } from './catalog/catalog.module';
import { registerCatalogRoutes } from './catalog/catalog.openapi';
import type { ApiRoute } from './http/api-doc';
import { IntegrationsModule } from './integrations/integrations.module';
import { registerIntegrationRoutes } from './integrations/integrations.openapi';
import { JobsModule } from './jobs/jobs.module';
import { registerJobRoutes } from './jobs/jobs.openapi';
import { ModelModule } from './model/model.module';
import { registerModelRoutes } from './model/model.openapi';
import { WebModulesModule } from './web-modules/web-modules.module';
import { registerWebModuleRoutes } from './web-modules/web-modules.openapi';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { registerWorkspaceRoutes } from './workspaces/workspaces.openapi';

/** A feature of the API: its Nest module and the OpenAPI paths it describes. */
interface ApiFeature {
  module: Type;
  routes(route: ApiRoute): void;
}

/**
 * Every feature, in the order of the OpenAPI document. The app module imports them and the
 * document is built from them, so adding a feature means one entry here (ADR 0008).
 */
export const FEATURES: ApiFeature[] = [
  { module: WorkspacesModule, routes: registerWorkspaceRoutes },
  { module: ModelModule, routes: registerModelRoutes },
  { module: JobsModule, routes: registerJobRoutes },
  { module: AdminModule, routes: registerAdminRoutes },
  { module: IntegrationsModule, routes: registerIntegrationRoutes },
  { module: CatalogModule, routes: registerCatalogRoutes },
  { module: WebModulesModule, routes: registerWebModuleRoutes },
];
