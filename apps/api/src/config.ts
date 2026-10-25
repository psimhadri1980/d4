import { loadConfig as load, neo4j, oidc, optional, postgres, queues, s3, telemetry, webhooks, type Config, type Env } from '@d4/config';
import { z } from 'zod';

const ApiEnv = {
  API_PORT: z.coerce.number().default(3000),
  ...postgres,
  ...neo4j,
  ...oidc,
  ...telemetry,
  /** Background jobs; without these the jobs endpoints answer 503. */
  REDIS_URL: optional(z.string().url()),
  S3_ENDPOINT: optional(s3.S3_ENDPOINT),
  S3_ACCESS_KEY: optional(s3.S3_ACCESS_KEY),
  S3_SECRET_KEY: optional(s3.S3_SECRET_KEY),
  S3_BUCKET: s3.S3_BUCKET,
  ...queues,
  ...webhooks,
  /** The browser-facing web address; the default CORS origin. */
  D4_PUBLIC_URL: optional(z.string().url()),
  /** Comma-separated browser origins allowed to call the API (embedders); defaults to D4_PUBLIC_URL. */
  CORS_ORIGINS: optional(z.string()),
};
export type AppConfig = Config<typeof ApiEnv>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: Env = process.env): AppConfig {
  return load(ApiEnv, env);
}

/** Origins allowed by CORS; none when the web app and the API share an origin. */
export function corsOrigins(config: AppConfig): string[] {
  const list = config.CORS_ORIGINS ?? config.D4_PUBLIC_URL ?? '';
  return list.split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean);
}
