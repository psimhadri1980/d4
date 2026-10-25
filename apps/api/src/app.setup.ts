import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import mercurius from 'mercurius';
import { APP_CONFIG, corsOrigins, type AppConfig } from './config';
import { GraphqlService } from './graphql/graphql.service';

/** Shared by main.ts and the end-to-end tests. Call before `app.init()` / `app.listen()`. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.enableShutdownHooks();
  // content-disposition carries export file names to the browser.
  const origins = corsOrigins(app.get<AppConfig>(APP_CONFIG));
  if (origins.length) app.enableCors({ origin: origins, exposedHeaders: ['content-disposition'] });
  // GraphQL is a Fastify plugin outside Nest routing; it authenticates in its own context.
  await app.register(mercurius as never, app.get(GraphqlService).options() as never);
}
