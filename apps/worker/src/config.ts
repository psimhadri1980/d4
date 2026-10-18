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
  JOB_QUEUE: optional(z.string()),
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
