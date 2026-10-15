import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({
      POSTGRES_URL: 'postgres://d4:x@localhost:5432/d4',
      NEO4J_PASSWORD: 'x',
      OIDC_ISSUER: 'http://localhost:8080/realms/d4',
    });
    expect(c.API_PORT).toBe(3000);
    expect(c.OIDC_AUDIENCE).toBe('d4-api');
  });

  it('fails fast on missing settings', () => {
    expect(() => loadConfig({})).toThrow(/POSTGRES_URL/);
  });
});
