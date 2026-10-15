import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Principal } from './auth.guard';

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Principal => ctx.switchToHttp().getRequest().principal,
);
