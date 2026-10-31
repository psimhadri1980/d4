import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { jwksProvider } from './identity';

/** Bearer-token authentication on every route (see `@Public()` and `@Roles()`); GraphQL authenticates with AuthService too. */
@Global()
@Module({
  providers: [jwksProvider, AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
