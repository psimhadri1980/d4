import { OpenApiGeneratorV3, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/auth.guard';
import { registerAdminRoutes } from '../admin/admin.openapi';
import { registerCatalogRoutes } from '../catalog/catalog.openapi';
import { registerIntegrationRoutes } from '../integrations/integrations.openapi';
import { registerJobRoutes } from '../jobs/jobs.openapi';
import { registerModelRoutes } from '../model/model.openapi';
import { registerWorkspaceRoutes } from '../workspaces/workspaces.openapi';
import type { ApiRoute } from './api-doc';

type OpenApiDocument =ReturnType<OpenApiGeneratorV3['generateDocument']>;

export function buildOpenApiDocument(): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearer', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  const route: ApiRoute = (r) => registry.registerPath({ security: [{ bearer: [] }], ...r });
  // Each feature describes its own paths, next to its controllers.
  for (const register of [registerWorkspaceRoutes, registerModelRoutes, registerJobRoutes, registerAdminRoutes, registerIntegrationRoutes, registerCatalogRoutes]) register(route);

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'D4 API',
      version: '0.1.0',
      description:
        'Commands and reads for the D4 design-to-delivery graph. Graph-shaped reads are also available via GraphQL at /api/graphql.',
    },
    // Browsers and clients reach the API through the gateway, which strips this prefix.
    servers: [{ url: '/api' }],
  });
}

@Controller()
export class OpenApiController {
  private readonly document: OpenApiDocument = buildOpenApiDocument();

  @Public()
  @Get('v1/openapi.json')
  openapi(): OpenApiDocument {
    return this.document;
  }
}
