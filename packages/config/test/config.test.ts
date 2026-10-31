import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, mail, neo4j, postgres, webhooks } from '../src';

const dev = { D4_ENV: 'dev' };

describe('loadConfig', () => {
  it('builds POSTGRES_URL from its parts unless it is given whole', () => {
    const parts = { POSTGRES_HOST: 'pg', POSTGRES_USER: 'd4', POSTGRES_PASSWORD: 'p@ss', POSTGRES_DB: 'd4' };
    expect(loadConfig(postgres, parts).POSTGRES_URL).toBe('postgres://d4:p%40ss@pg:5432/d4');
    expect(loadConfig(postgres, { ...parts, POSTGRES_PORT: '6543' }).POSTGRES_URL).toBe('postgres://d4:p%40ss@pg:6543/d4');
    expect(loadConfig(postgres, { ...parts, POSTGRES_URL: 'postgres://x:y@z/w' }).POSTGRES_URL).toBe('postgres://x:y@z/w');
  });

  it('reads NAME_FILE secrets', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'd4-config-')), 'neo4j');
    writeFileSync(file, 's3cret\n');
    expect(loadConfig(neo4j, { NEO4J_PASSWORD_FILE: file }).NEO4J_PASSWORD).toBe('s3cret');
  });

  it('applies defaults and treats empty values as unset', () => {
    expect(loadConfig({ ...neo4j, ...mail }, { NEO4J_PASSWORD: 'x', NEO4J_URI: '', SMTP_URL: '' })).toMatchObject({
      D4_ENV: 'production',
      NEO4J_USER: 'neo4j',
      NEO4J_URI: undefined,
      SMTP_URL: undefined,
      MAIL_FROM: 'D4 Reports <reports@d4.local>',
    });
  });

  it('names every missing variable', () => {
    expect(() => loadConfig({ ...postgres, ...neo4j }, {})).toThrow(/POSTGRES_URL.*NEO4J_PASSWORD/);
  });

  it('refuses development secrets and switches in production only', () => {
    const env = { POSTGRES_URL: 'postgres://d4:d4-local-dev@pg/d4', NEO4J_PASSWORD: 'd4-local-dev', WEBHOOK_ALLOW_PRIVATE: 'true' };
    const shape = { ...postgres, ...neo4j, ...webhooks };
    expect(() => loadConfig(shape, env)).toThrow(/POSTGRES_URL uses the development secret.*NEO4J_PASSWORD.*WEBHOOK_ALLOW_PRIVATE/);
    expect(loadConfig(shape, { ...env, ...dev }).WEBHOOK_ALLOW_PRIVATE).toBe(true);
  });
});
