import { createServer } from 'node:http';
import { createDb } from '@d4/db';
import { GraphQuotaGuard, JobQueue, meterUsage, runDueConnectors, processJob, pruneBackups, startScheduledBackups, pruneArtifacts, RENDER_QUEUE, runDueSchedules, runWebhookPass, S3ArtifactStore, SmtpMailer, startJobWorker, graphConfig, TenantGraphs, type JobDeps } from '@d4/jobs';
import { loadConfig } from './config';

/**
 * The job worker: takes job ids from the Redis queue and runs them with the same code the API
 * uses for direct exports and imports. Several workers can run side by side; a job's database
 * record makes duplicate deliveries harmless.
 */
async function main() {
  const config = loadConfig();
  const db = createDb(config.POSTGRES_URL, 4);
  const graphs = new TenantGraphs(db.db, graphConfig(config));
  const artifacts = new S3ArtifactStore({
    endpoint: config.S3_ENDPOINT,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
    bucket: config.S3_BUCKET,
  });
  const mailer = config.SMTP_URL ? new SmtpMailer(config.SMTP_URL, config.MAIL_FROM) : undefined;
  const deps: JobDeps = { db: db.db, graphs, artifacts, appUrl: config.APP_URL, quota: new GraphQuotaGuard(db.db), allowPrivateUrls: config.WEBHOOK_ALLOW_PRIVATE, ...(mailer && { mailer }) };

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
    { concurrency: config.WORKER_CONCURRENCY, ...(config.JOB_QUEUE && { queue: config.JOB_QUEUE }) },
  );
  worker.on('error', (e) => log('worker error', { error: e.message }));

  let ready = false;
  worker.on('ready', () => {
    ready = true;
    log('worker ready', { queue: config.JOB_QUEUE ?? 'd4-jobs', concurrency: config.WORKER_CONCURRENCY });
  });
  // Report schedules: every worker polls; row locks make each due schedule run once.
  const queues = { jobs: new JobQueue(config.REDIS_URL, config.JOB_QUEUE), render: new JobQueue(config.REDIS_URL, config.RENDER_QUEUE ?? RENDER_QUEUE) };
  let ticking = false;
  let lastPrune = 0;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const started = await runDueSchedules(db.db, queues);
      if (started.length) log('scheduled reports started', { jobs: started });
      const syncs = await runDueConnectors(db.db, queues.jobs);
      if (syncs.length) log('connector syncs started', { jobs: syncs.length });
      const backups = await startScheduledBackups(db.db, queues.jobs, config.BACKUP_HOUR_UTC);
      if (backups.length) log('daily backups started', { jobs: backups.length });
      // Once an hour: delete files past the retention period.
      if (Date.now() - lastPrune > 3_600_000) {
        lastPrune = Date.now();
        const removed = await pruneArtifacts(db.db, artifacts, new Date(Date.now() - config.ARTIFACT_RETENTION_DAYS * 86_400_000));
        if (removed) log('old files deleted', { removed, retentionDays: config.ARTIFACT_RETENTION_DAYS });
        // Also hourly: today's usage reading per tenant, for billing and the Admin page's history.
        const metered = await meterUsage(db.db, graphs);
        log('usage recorded', { tenants: metered });
        const prunedBackups = await pruneBackups(db.db, artifacts);
        if (prunedBackups) log('old backups deleted', { removed: prunedBackups });
      }
    } catch (e) {
      log('scheduler tick failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      ticking = false;
    }
  };
  // Webhooks: relay new events from the outbox and send due deliveries; row locks share the work.
  let sending = false;
  const webhookTick = async () => {
    if (sending) return;
    sending = true;
    try {
      const r = await runWebhookPass(db.db, { allowPrivate: config.WEBHOOK_ALLOW_PRIVATE });
      if (r.sent || r.failed) log('webhook deliveries', r);
    } catch (e) {
      log('webhook pass failed', { error: e instanceof Error ? e.message : String(e) });
    } finally {
      sending = false;
    }
  };
  const webhookTimer = config.WEBHOOK_INTERVAL_MS > 0 ? setInterval(() => void webhookTick(), config.WEBHOOK_INTERVAL_MS) : undefined;
  const timer = config.SCHEDULER_INTERVAL_MS > 0 ? setInterval(() => void tick(), config.SCHEDULER_INTERVAL_MS) : undefined;

  const health = createServer((req, res) => {
    const ok = req.url === '/healthz' && ready && worker.isRunning();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'starting' }));
  }).listen(config.WORKER_HEALTH_PORT);

  const shutdown = async (signal: string) => {
    log('shutting down', { signal });
    health.close();
    if (timer) clearInterval(timer);
    if (webhookTimer) clearInterval(webhookTimer);
    await Promise.all([queues.jobs.close(), queues.render.close()]);
    // Lets running jobs finish; queued ones stay in Redis for the next worker.
    await worker.close();
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
