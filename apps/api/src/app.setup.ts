import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import mercurius from 'mercurius';
import { GraphqlService } from './graphql/graphql.service';

/** Shared by main.ts and the end-to-end tests. Call before `app.init()` / `app.listen()`. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.enableShutdownHooks();
  // content-disposition carries export file names to the browser.
  app.enableCors({ origin: ['http://localhost:5173'], exposedHeaders: ['content-disposition'] });
  // GraphQL is a Fastify plugin outside Nest routing; it authenticates in its own context.
  await app.register(mercurius as never, app.get(GraphqlService).options() as never);
}
