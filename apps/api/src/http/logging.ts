import type { IncomingMessage } from 'node:http';
import { createLogger } from '@d4/runtime';
import { RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

/**
 * Request logs in the services' JSON shape: one line per request with `requestId` (Fastify's id:
 * the gateway's X-Request-Id, see main.ts), and the caller's `tenantId` and `userId` once authenticated
 * (AuthGuard assigns them). Health probes are not logged.
 */
export const LoggingModule = LoggerModule.forRootAsync({
  // A factory, so LOG_LEVEL is read when the app starts rather than when this file loads.
  useFactory: () => ({
    pinoHttp: {
      logger: createLogger('d4-api'),
      customProps: (req: IncomingMessage & { id?: unknown }) => ({ requestId: req.id }),
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    },
    assignResponse: true,
    exclude: [{ method: RequestMethod.GET, path: 'healthz' }, { method: RequestMethod.GET, path: 'readyz' }],
  }),
});
