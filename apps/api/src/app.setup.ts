import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import mercurius from 'mercurius';
import { GraphqlService } from './graphql/graphql.service';

/** Shared by main.ts and the end-to-end tests. Call before `app.init()` / `app.listen()`. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.enableShutdownHooks();
  // No CORS: the browser reaches the API through the gateway on the web app's origin (/api).
  // GraphQL is a Fastify plugin outside Nest routing; it authenticates in its own context.
  await app.register(mercurius as never, app.get(GraphqlService).options() as never);
}
