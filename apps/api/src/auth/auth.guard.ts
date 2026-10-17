import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { APP_CONFIG, type AppConfig } from '../config';

export const ROLES = [
  'viewer',
  'contributor',
  'planner',
  'architect',
  'query-author',
  'query-steward',
  'admin',
] as const;
export type Role = (typeof ROLES)[number];

export interface Principal {
  subject: string;
  tenantId: string;
  roles: Role[];
}

const PUBLIC_KEY = 'd4:public';
const ROLES_KEY = 'd4:roles';
/** Skip authentication (health probes). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Require at least one of the given roles; `admin` always passes. */
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const JWKS = Symbol('JWKS');
export const jwksProvider = {
  provide: JWKS,
  inject: [APP_CONFIG],
  useFactory: (c: AppConfig): JWTVerifyGetKey =>
    createRemoteJWKSet(
      new URL(c.OIDC_JWKS_URI ?? `${c.OIDC_ISSUER}/protocol/openid-connect/certs`),
    ),
};

/** Extracts a Principal from a verified token; tenant comes only from the signed `tenant` claim. */
export function principalFromClaims(claims: JWTPayload): Principal {
  const tenantId = claims['tenant'];
  if (typeof tenantId !== 'string' || !claims.sub) {
    throw new UnauthorizedException('Token lacks subject or tenant claim');
  }
  const realmRoles = (claims['realm_access'] as { roles?: unknown } | undefined)?.roles;
  const roles = Array.isArray(realmRoles)
    ? realmRoles.filter((r): r is Role => (ROLES as readonly string[]).includes(r))
    : [];
  return { subject: claims.sub, tenantId, roles };
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // Explicit tokens throughout: the dev runner (tsx/esbuild) does not emit decorator metadata.
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; principal?: Principal }>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(header.slice(7), this.jwks, {
        issuer: this.config.OIDC_ISSUER,
        audience: this.config.OIDC_AUDIENCE,
      }));
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    const principal = principalFromClaims(claims);
    req.principal = principal;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (required?.length && !principal.roles.includes('admin') && !required.some((r) => principal.roles.includes(r))) {
      throw new ForbiddenException();
    }
    return true;
  }
}
