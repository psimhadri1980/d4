import { describe, expect, it } from 'vitest';
import { principalFromClaims } from '../src/auth/auth.guard';

describe('principalFromClaims', () => {
  it('maps known realm roles and the tenant claim', () => {
    const p = principalFromClaims({
      sub: 'u1',
      tenant: 't_local',
      realm_access: { roles: ['viewer', 'query-author', 'offline_access'] },
    });
    expect(p).toEqual({ subject: 'u1', tenantId: 't_local', roles: ['viewer', 'query-author'] });
  });

  it('rejects tokens without a tenant', () => {
    expect(() => principalFromClaims({ sub: 'u1' })).toThrow(/tenant/);
  });
});
