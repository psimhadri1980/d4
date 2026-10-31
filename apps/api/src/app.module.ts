import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { FEATURES } from './features';
import { HealthController } from './health/health.controller';
import { ApiExceptionFilter } from './http/errors';
import { LoggingModule } from './http/logging';
import { OpenApiController } from './http/openapi';
import { InfraModule } from './infra/infra.module';

@Module({
  imports: [LoggingModule, InfraModule, AuthModule, ...FEATURES.map((f) => f.module)],
  controllers: [HealthController, OpenApiController],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule {}
