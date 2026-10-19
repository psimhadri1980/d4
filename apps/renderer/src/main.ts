import { createServer } from 'node:http';
import { createDb } from '@d4/db';
import { processJob, RENDER_QUEUE, S3ArtifactStore, SmtpMailer, startJobWorker, TenantGraphs, type JobDeps } from '@d4/jobs';
import { Chromium } from './chromium';
import { loadConfig } from './config';

/**
 * The renderer: takes render jobs from their own queue and turns roadmaps and graph views into
 * PNG and PDF with headless Chromium. Kept apart from the job worker so Chromium's memory and the
 * Playwright image only weigh on this service.
 */
async function main() {
  const config = loadConfig();
  const db = createDb(config.POSTGRES_URL, 4);
  const graphs = new TenantGraphs(db.db, {
    user: config.NEO4J_USER,
    password: config.NEO4J_PASSWORD,
    ...(config.NEO4J_URI && { uriOverride: config.NEO4J_URI }),
  });
  const artifacts = new S3ArtifactStore({
    endpoint: config.S3_ENDPOINT,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
  const browser = new Chromium();
  const mailer = config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) : undefined;
  const deps: JobDeps = { db: db.db, graphs, artifacts, rasterize: browser.rasterize, appUrl: config.APP_URL, ...(mailer && { mailer }) };

  const worker = startJobWorker(
    config.REDIS_URL,
    async (msg, attempt) => {
      const started = Date.now();
      try {
        await processJob(msg, deps, attempt);
        log('job done', { ...msg, ms: Date.now() - started });
      } catch (e) {
        log('job attempt failed', { ...msg, attempt: attempt.made + 1, of: attempt.max, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
    },
    { concurrency: config.RENDER_CONCURRENCY, queue: config.RENDER_QUEUE ?? RENDER_QUEUE },
  );
  worker.on('error', (e) => log('worker error', { error: e.message }));

  let ready = false;
  worker.on('ready', () => {
    ready = true;
    log('renderer ready', { queue: config.RENDER_QUEUE ?? RENDER_QUEUE, concurrency: config.RENDER_CONCURRENCY });
  });
  const health = createServer((req, res) => {
    const ok = req.url === '/healthz' && ready && worker.isRunning();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'starting' }));
  }).listen(config.RENDER_HEALTH_PORT);

  const shutdown = async (signal: string) => {
    log('shutting down', { signal });
    health.close();
    // Lets running jobs finish; queued ones stay in Redis for the next worker.
    await worker.close();
    await browser.close();
    mailer?.close();
    await graphs.close();
    artifacts.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function log(message: string, fields: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), message, ...fields })}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
