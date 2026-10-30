import { startTelemetry } from '@d4/runtime/telemetry';
startTelemetry('d4-api');

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG, type AppConfig } from './config';

async function bootstrap() {
  // Model imports can be large; 20 MB covers tens of thousands of elements.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    // Request ids come from the gateway (X-Request-Id), so its log and ours share them.
    new FastifyAdapter({ bodyLimit: 20 * 1024 * 1024, requestIdHeader: 'x-request-id', genReqId: () => randomUUID() }),
    { bufferLogs: true },
  );
  app.useLogger(app.get(Logger));
  await configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.API_PORT, '0.0.0.0');
}

void bootstrap();
