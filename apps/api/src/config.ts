import { z } from 'zod';

/** Compose passes unset variables as empty strings; treat them as absent. */
const optional = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), t.optional());

const Env = z.object({
  API_PORT: z.coerce.number().default(3000),
  POSTGRES_URL: z.string().url(),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1),
  /** Overrides tenant bolt URIs in local dev, where the registry stores in-cluster hostnames. */
  NEO4J_URI: optional(z.string()),
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().default('d4-api'),
  /**
   * Where to fetch signing keys when it differs from the public issuer URL, e.g. inside
   * docker-compose (`http://keycloak:8080/...`) while tokens say `http://localhost:8080/...`.
   */
  OIDC_JWKS_URI: optional(z.string().url()),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.string().url()),
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
