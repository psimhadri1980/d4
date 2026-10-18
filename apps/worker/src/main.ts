import { createServer } from 'node:http';
import { createDb } from '@d4/db';
import { processJob, S3ArtifactStore, startJobWorker, TenantGraphs, type JobDeps } from '@d4/jobs';
import { loadConfig } from './config';

/**
 * The job worker: takes job ids from the Redis queue and runs them with the same code the API
 * uses for direct exports and imports. Several workers can run side by side; a job's database
 * record makes duplicate deliveries harmless.
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
  const deps: JobDeps = { db: db.db, graphs, artifacts };

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
  const health = createServer((req, res) => {
    const ok = req.url === '/healthz' && ready && worker.isRunning();
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: ok ? 'ok' : 'starting' }));
  }).listen(config.WORKER_HEALTH_PORT);

  const shutdown = async (signal: string) => {
    log('shutting down', { signal });
    health.close();
    // Lets running jobs finish; queued ones stay in Redis for the next worker.
    await worker.close();
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
