import { loadConfig as load, mail, neo4j, postgres, publicUrl, queues, redis, s3, webhooks, type Config, type Env } from '@d4/config';
import { z } from 'zod';

const WorkerEnv = {
  ...postgres,
  ...neo4j,
  ...redis,
  ...s3,
  ...mail,
  ...publicUrl,
  ...queues,
  ...webhooks,
  /** How often to look for due report schedules; 0 turns the scheduler off. */
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Export, report and picture files are deleted this many days after the job finished. */
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /** How often to relay new model events to webhooks and send due deliveries; 0 turns it off. */
  WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),
  /** UTC hour after which each active workspace gets its daily backup; -1 turns daily backups off. */
  BACKUP_HOUR_UTC: z.coerce.number().int().min(-1).max(23).default(2),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Health endpoint for container checks. */
  WORKER_HEALTH_PORT: z.coerce.number().int().default(3002),
};
type WorkerConfig =Config<typeof WorkerEnv>;

export function loadConfig(env: Env = process.env): WorkerConfig {
  return load(WorkerEnv, env);
}
