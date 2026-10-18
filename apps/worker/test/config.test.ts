import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

describe('worker config', () => {
  const base = { POSTGRES_URL: 'postgres://u:p@h/d', NEO4J_PASSWORD: 'x', REDIS_URL: 'redis://r:6379', S3_ENDPOINT: 'http://s3:8333' };

  it('applies defaults and treats empty values as unset', () => {
    expect(loadConfig({ ...base, NEO4J_URI: '', JOB_QUEUE: '' })).toMatchObject({
      NEO4J_USER: 'neo4j',
      S3_BUCKET: 'd4-exports',
      WORKER_CONCURRENCY: 2,
      WORKER_HEALTH_PORT: 3002,
      NEO4J_URI: undefined,
      JOB_QUEUE: undefined,
    });
  });

  it('names what is missing', () => {
    expect(() => loadConfig({ POSTGRES_URL: base.POSTGRES_URL })).toThrow(/NEO4J_PASSWORD.*REDIS_URL.*S3_ENDPOINT/);
  });
});
