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
  RENDER_QUEUE: optional(z.string()),
  /** Chromium is memory-hungry: one render at a time by default. */
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** Health endpoint for container checks. */
  RENDER_HEALTH_PORT: z.coerce.number().int().default(3003),
});
export type RendererConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RendererConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
