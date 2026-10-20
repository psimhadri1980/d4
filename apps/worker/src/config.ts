import { z } from 'zod';

const optional = <T extends z.ZodTypeAny>(t: T) => z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const Env = z.object({
  POSTGRES_URL: z.string().url(),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1),
  NEO4J_URI: optional(z.string()),
  REDIS_URL: z.string().url(),
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().default('d4'),
  S3_SECRET_KEY: z.string().default('d4-local-dev'),
  S3_BUCKET: z.string().default('d4-exports'),
  /** Report emails; without it, scheduled runs record delivery as skipped. */
  SMTP_URL: optional(z.string()),
  MAIL_FROM: z.string().default('D4 Reports <reports@d4.local>'),
  /** Public web address used in report emails. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  JOB_QUEUE: optional(z.string()),
  RENDER_QUEUE: optional(z.string()),
  /** How often to look for due report schedules; 0 turns the scheduler off. */
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).default(30_000),
  /** Export, report and picture files are deleted this many days after the job finished. */
  ARTIFACT_RETENTION_DAYS: z.coerce.number().int().min(1).default(30),
  /** How often to relay new model events to webhooks and send due deliveries; 0 turns it off. */
  WEBHOOK_INTERVAL_MS: z.coerce.number().int().min(0).default(5_000),
  /** Allow http and private-network webhook URLs. Local development only. */
  WEBHOOK_ALLOW_PRIVATE: z.preprocess((v) => v === 'true' || v === '1', z.boolean()).default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  /** Health endpoint for container checks. */
  WORKER_HEALTH_PORT: z.coerce.number().int().default(3002),
});
export type WorkerConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
