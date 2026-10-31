import { startTelemetry } from '@d4/runtime/telemetry';
startTelemetry('d4-worker');

import { openJobDeps, pruneArtifacts, pruneBackups, processJob, runDueConnectors, runDueSchedules, runWebhookPass, startScheduledBackups } from '@d4/jobs';
import { GraphQuotaGuard, JobQueue, meterUsage, RENDER_QUEUE, JOB_QUEUE } from '@d4/infra';
import { createLogger, runMain, startQueueService } from '@d4/runtime';
import { loadConfig } from './config';

const log = createLogger('d4-worker');

/**
 * The job worker: takes job ids from the Redis queue and runs them with the same code the API
 * uses for direct exports and imports. Several workers can run side by side; a job's database
 * record makes duplicate deliveries harmless.
 */
runMain(log, async () => {
  const config = loadConfig();
  const opened = openJobDeps(config, { allowPrivateUrls: config.WEBHOOK_ALLOW_PRIVATE });
  const { deps, graphs, artifacts } = opened;
  const db = deps.db;
  deps.quota = new GraphQuotaGuard(db);

  const service = startQueueService({
    log,
    redisUrl: config.REDIS_URL,
    queue: config.JOB_QUEUE ?? JOB_QUEUE,
    concurrency: config.WORKER_CONCURRENCY,
    healthPort: config.WORKER_HEALTH_PORT,
    handle: (msg, attempt) => processJob(msg, deps, attempt),
  });

  // Report schedules: every worker polls; row locks make each due schedule run once.
  const queues = { jobs: new JobQueue(config.REDIS_URL, config.JOB_QUEUE), render: new JobQueue(config.REDIS_URL, config.RENDER_QUEUE ?? RENDER_QUEUE) };
  let lastPrune = 0;
  service.every(config.SCHEDULER_INTERVAL_MS, 'scheduler', async () => {
    const started = await runDueSchedules(db, queues);
    if (started.length) log.info({ jobs: started }, 'scheduled reports started');
    const syncs = await runDueConnectors(db, queues.jobs);
    if (syncs.length) log.info({ jobs: syncs.length }, 'connector syncs started');
    const backups = await startScheduledBackups(db, queues.jobs, config.BACKUP_HOUR_UTC);
    if (backups.length) log.info({ jobs: backups.length }, 'daily backups started');
    // Once an hour: delete files past the retention period.
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      const removed = await pruneArtifacts(db, artifacts, new Date(Date.now() - config.ARTIFACT_RETENTION_DAYS * 86_400_000));
      if (removed) log.info({ removed, retentionDays: config.ARTIFACT_RETENTION_DAYS }, 'old files deleted');
      // Also hourly: today's usage reading per tenant, for billing and the Admin page's history.
      const metered = await meterUsage(db, graphs);
      log.info({ tenants: metered }, 'usage recorded');
      const prunedBackups = await pruneBackups(db, artifacts);
      if (prunedBackups) log.info({ removed: prunedBackups }, 'old backups deleted');
    }
  });
  // Webhooks: relay new events from the outbox and send due deliveries; row locks share the work.
  service.every(config.WEBHOOK_INTERVAL_MS, 'webhooks', async () => {
    const r = await runWebhookPass(db, { allowPrivate: config.WEBHOOK_ALLOW_PRIVATE });
    if (r.sent || r.failed) log.info(r, 'webhook deliveries');
  });

  service.onShutdown(() => Promise.all([queues.jobs.close(), queues.render.close()]));
  service.onShutdown(() => opened.close());
});
