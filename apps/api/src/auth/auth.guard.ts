import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service';
import { hasAnyRole, type Principal, type Role } from './identity';

export * from './identity';

const PUBLIC_KEY = 'd4:public';
const ROLES_KEY = 'd4:roles';
/** Skip authentication (health probes, OpenAPI document). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/**
 * Require at least one of the given tenant-wide roles; `admin` always passes. Not used yet: it
 * replaces the per-handler admin checks in the planned refactor (docs/REFACTOR_PLAN.md, P4).
 * @public
 */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // Explicit tokens throughout: the dev runner (tsx/esbuild) does not emit decorator metadata.
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    const principal = await this.auth.authenticate(req.headers['authorization']);
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (required?.length && !hasAnyRole(principal.roles, required)) throw new ForbiddenException();
    return true;
  }
}
