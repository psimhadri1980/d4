import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { RoleStore, TenantStore, UserStore } from '@d4/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { JWKS, principalFromClaims, type Principal, type Role } from './identity';

const CACHE_TTL_MS = 60_000;

/**
 * Turns a bearer token into a Principal: verifies it, checks the tenant is active, provisions the
 * user just-in-time and merges realm roles with tenant-wide role bindings. Results are cached
 * briefly per token identity so most requests cost one signature check.
 */
@Injectable()
export class AuthService {
  private readonly cache = new Map<string, { principal: Principal; expires: number }>();

  constructor(
    @Inject(RoleStore) private readonly roleStore: RoleStore,
    @Inject(TenantStore) private readonly tenantStore: TenantStore,
    @Inject(UserStore) private readonly userStore: UserStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(JWKS) private readonly jwks: JWTVerifyGetKey,
  ) {}

  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException();
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(authorization.slice(7), this.jwks, {
        issuer: this.config.OIDC_ISSUER,
        audience: this.config.OIDC_AUDIENCE,
      }));
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
    const token = principalFromClaims(claims);

    const key = `${token.tenantId}|${token.subject}|${token.roles.join(',')}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.principal;

    const tenant = await this.tenantStore.get(token.tenantId);
    if (!tenant || tenant.status !== 'active') throw new ForbiddenException('Tenant is not active');

    const user = await this.userStore.upsertFromToken(token.tenantId, token);
    const bound = await this.roleStore.effectiveRoles(token.tenantId, user.id);
    const roles = [...new Set<Role>([...token.roles, ...bound])].sort();

    const principal: Principal = { subject: token.subject, userId: user.id, tenantId: token.tenantId, roles };
    this.cache.set(key, { principal, expires: Date.now() + CACHE_TTL_MS });
    if (this.cache.size > 10_000) this.cache.clear();
    return principal;
  }
}
