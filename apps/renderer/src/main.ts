import { startTelemetry } from '@d4/runtime/telemetry';
startTelemetry('d4-renderer');

import { openJobDeps, processJob, RENDER_QUEUE } from '@d4/jobs';
import { createLogger, runMain, startQueueService } from '@d4/runtime';
import { Chromium } from './chromium';
import { loadConfig } from './config';

const log = createLogger('d4-renderer');

/**
 * The renderer: takes render jobs from their own queue and turns roadmaps and graph views into
 * PNG and PDF with headless Chromium. Kept apart from the job worker so Chromium's memory and the
 * Playwright image only weigh on this service.
 */
runMain(log, async () => {
  const config = loadConfig();
  const browser = new Chromium(config.CHROMIUM_PATH);
  const opened = openJobDeps(config, { rasterize: browser.rasterize });

  const service = startQueueService({
    log,
    redisUrl: config.REDIS_URL,
    queue: config.RENDER_QUEUE ?? RENDER_QUEUE,
    concurrency: config.RENDER_CONCURRENCY,
    healthPort: config.RENDER_HEALTH_PORT,
    handle: (msg, attempt) => processJob(msg, opened.deps, attempt),
  });
  service.onShutdown(() => browser.close());
  service.onShutdown(() => opened.close());
});
