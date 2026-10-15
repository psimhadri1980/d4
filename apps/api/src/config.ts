import { z } from 'zod';

const Env = z.object({
  API_PORT: z.coerce.number().default(3000),
  POSTGRES_URL: z.string().url(),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1),
  /** Overrides tenant bolt URIs in local dev, where the registry stores in-cluster hostnames. */
  NEO4J_URI: z.string().optional(),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().default('d4-api'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});
export type AppConfig = z.infer<typeof Env>;

export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  return parsed.data;
}
