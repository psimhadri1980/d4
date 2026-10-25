import { loadConfig as load, mail, neo4j, optional, postgres, publicUrl, redis, s3, type Config, type Env } from '@d4/config';
import { z } from 'zod';

const RendererEnv = {
  ...postgres,
  ...neo4j,
  ...redis,
  ...s3,
  ...mail,
  ...publicUrl,
  RENDER_QUEUE: optional(z.string()),
  /** Chromium is memory-hungry: one render at a time by default. */
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  /** Health endpoint for container checks. */
  RENDER_HEALTH_PORT: z.coerce.number().int().default(3003),
  /** A Chromium other than the one Playwright installed. */
  CHROMIUM_PATH: optional(z.string()),
};
type RendererConfig =Config<typeof RendererEnv>;

export function loadConfig(env: Env = process.env): RendererConfig {
  return load(RendererEnv, env);
}
