import { createServer } from 'node:http';
import { startJobWorker, type JobMessage } from '@d4/infra';
import { errorMessage, type Logger } from './log';

export interface QueueServiceOptions {
  log: Logger;
  redisUrl: string;
  queue: string;
  concurrency: number;
  /** `GET /healthz` answers 200 once the worker is connected and running. */
  healthPort: number;
  handle: (msg: JobMessage, attempt: { made: number; max: number }) => Promise<void>;
}

export interface QueueService {
  /** Runs `fn` every `ms` (never twice at once), logging failures; `ms <= 0` turns it off. */
  every(ms: number, name: string, fn: () => Promise<void>): void;
  /** Called on SIGTERM/SIGINT after the worker has finished its running jobs, in order. */
  onShutdown(fn: () => unknown): void;
}

/**
 * The loop of a queue-consuming service (worker, renderer): the BullMQ worker with per-job logs,
 * a health endpoint, periodic tasks and an orderly shutdown that lets running jobs finish.
 */
export function startQueueService(o: QueueServiceOptions): QueueService {
  const { log } = o;
  const worker = startJobWorker(
    o.redisUrl,
    async (msg, attempt) => {
      const started = Date.now();
      try {
        await o.handle(msg, attempt);
        log.info({ ...msg, ms: Date.now() - started }, 'job done');
      } catch (e) {
        log.warn({ ...msg, attempt: attempt.made + 1, of: attempt.max, error: errorMessage(e) }, 'job attempt failed');
        throw e;
      }
    },
    { concurrency: o.concurrency, queue: o.queue },
  );
  worker.on('error', (e) => log.error({ error: e.message }, 'worker error'));

  let ready = false;
  worker.on('ready', () => {
    ready = true;
    log.info({ queue: o.queue, concurrency: o.concurrency }, 'ready');
  });
  const health = createServer((req, res) => {
    const ok = req.url === '/healthz' && ready && worker.isRunning();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'starting' }));
  }).listen(o.healthPort);

  const timers: NodeJS.Timeout[] = [];
  const closers: (() => unknown)[] = [];

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    health.close();
    timers.forEach(clearInterval);
    // Lets running jobs finish; queued ones stay in Redis for the next worker.
    await worker.close();
    for (const close of closers) await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  return {
    every(ms, name, fn) {
      if (ms <= 0) return;
      let running = false;
      timers.push(
        setInterval(() => {
          if (running) return;
          running = true;
          fn()
            .catch((e) => log.error({ task: name, error: errorMessage(e) }, 'periodic task failed'))
            .finally(() => (running = false));
        }, ms),
      );
    },
    onShutdown(fn) {
      closers.push(fn);
    },
  };
}

/** Exits with the error when a service fails to start. */
export function runMain(log: Logger, main: () => Promise<void>) {
  main().catch((e) => {
    log.fatal({ error: errorMessage(e), stack: e instanceof Error ? e.stack : undefined }, 'start failed');
    process.exit(1);
  });
}
