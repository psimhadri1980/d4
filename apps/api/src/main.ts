import { startTelemetry } from './telemetry';
startTelemetry();

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG, type AppConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await configureApp(app);
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.API_PORT, '0.0.0.0');
}

void bootstrap();
