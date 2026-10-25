import { UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { ROLES, type Role } from '@d4/db';
import { APP_CONFIG, type AppConfig } from '../config';

export type { Role };

/** Identity taken from a verified token, before D4's own records are consulted. */
interface TokenIdentity {
  subject: string;
  tenantId: string;
  roles: Role[];
  email?: string;
  displayName?: string;
}

/** The authenticated caller: token identity plus D4 user id and tenant-wide role bindings. */
export interface Principal {
  subject: string;
  userId: string;
  tenantId: string;
  roles: Role[];
}

export const JWKS = Symbol('JWKS');
export const jwksProvider = {
  provide: JWKS,
  inject: [APP_CONFIG],
  useFactory: (c: AppConfig): JWTVerifyGetKey =>
    createRemoteJWKSet(
      new URL(c.OIDC_JWKS_URI ?? `${c.OIDC_ISSUER}/protocol/openid-connect/certs`),
    ),
};

/** Tenant comes only from the signed `tenant` claim; unknown realm roles are ignored. */
export function principalFromClaims(claims: JWTPayload): TokenIdentity {
  const tenantId = claims['tenant'];
  if (typeof tenantId !== 'string' || !claims.sub) {
    throw new UnauthorizedException('Token lacks subject or tenant claim');
  }
  const realmRoles = (claims['realm_access'] as { roles?: unknown } | undefined)?.roles;
  const roles = Array.isArray(realmRoles)
    ? realmRoles.filter((r): r is Role => (ROLES as readonly string[]).includes(r))
    : [];
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return {
    subject: claims.sub,
    tenantId,
    roles,
    ...(str(claims['email']) && { email: str(claims['email']) }),
    ...(str(claims['name']) && { displayName: str(claims['name']) }),
  };
}

export const hasAnyRole = (held: readonly Role[], wanted: readonly Role[]) =>
  held.includes('admin') || wanted.some((r) => held.includes(r));
