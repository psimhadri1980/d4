import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import mercurius from 'mercurius';
import { GraphqlService } from './graphql/graphql.service';

/** Shared by main.ts and the end-to-end tests. Call before `app.init()` / `app.listen()`. */
export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.enableShutdownHooks();
  // Fastify 5 refuses a JSON content type with an empty body; keep accepting it (as Fastify 4 did)
  // so clients that always send the header, on DELETE for example, still work.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req) => {
      if (req.headers['content-length'] === '0' || (!req.headers['content-length'] && !req.headers['transfer-encoding']))
        delete req.headers['content-type'];
    });
  // No CORS: the browser reaches the API through the gateway on the web app's origin (/api).
  // GraphQL is a Fastify plugin outside Nest routing; it authenticates in its own context.
  await app.register(mercurius as never, app.get(GraphqlService).options() as never);
}
