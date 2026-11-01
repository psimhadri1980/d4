import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, startQueueService } from '../src';

const REDIS = process.env.D4_TEST_REDIS_URL;

describe.skipIf(!REDIS)('startQueueService health', () => {
  it('answers liveness always, and readiness only while its dependencies are up', async () => {
    vi.spyOn(process, 'on').mockImplementation(() => process);
    const log = createLogger('d4-test', new Writable({ write: (_c, _e, done) => done() }));
    let dbUp = true;
    startQueueService({
      log,
      redisUrl: REDIS!,
      queue: `health-test-${Date.now()}`,
      concurrency: 1,
      healthPort: 3099,
      ready: async () => {
        if (!dbUp) throw new Error('down');
      },
      handle: async () => {},
    });
    const get = (path: string) => fetch(`http://127.0.0.1:3099${path}`).then((r) => r.status);

    expect(await get('/healthz')).toBe(200);
    await vi.waitFor(async () => expect(await get('/readyz')).toBe(200), { timeout: 5000 });
    dbUp = false;
    expect(await get('/readyz')).toBe(503);
    expect(await get('/healthz')).toBe(200);
    expect(await get('/other')).toBe(404);
  });
});
