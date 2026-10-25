import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Environment settings shared by every D4 process. Each service composes the fragments it needs
 * into one schema and loads it with `loadConfig`, which also resolves `*_FILE` secrets, derives
 * connection URLs from their parts and refuses development secrets in production.
 */

export type Env = Record<string, string | undefined>;

/** Compose passes unset variables as empty strings; treat them as absent. */
export const optional = <T extends z.ZodTypeAny>(t: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), t.optional());

/** `true` or `1` turns a switch on; anything else, or nothing, leaves it off. */
export const flag = z.preprocess((v) => v === 'true' || v === '1', z.boolean());

const base = {
  /** `production` (the default) refuses development secrets and development-only switches. */
  D4_ENV: z.enum(['dev', 'production']).default('production'),
};

export const postgres = {
  /** Or POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD and POSTGRES_DB. */
  POSTGRES_URL: z.string().url(),
};

export const neo4j = {
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1),
  /** Overrides tenant bolt URIs in local dev, where the registry stores in-cluster hostnames. */
  NEO4J_URI: optional(z.string()),
  /** host=host:port pairs: how this process reaches tenant instances by the host in their registered URI. */
  NEO4J_HOSTS: optional(z.string()),
  /** Directory of `file:` secrets (tenant Neo4j passwords). */
  NEO4J_SECRETS_DIR: optional(z.string()),
};

export const redis = {
  REDIS_URL: z.string().url(),
};

export const s3 = {
  S3_ENDPOINT: z.string().url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().default('d4-exports'),
};

export const queues = {
  /** Queue names; tests and local processes use their own so a running worker does not take their jobs. */
  JOB_QUEUE: optional(z.string()),
  RENDER_QUEUE: optional(z.string()),
};

export const mail = {
  /** Report emails; without it, scheduled runs record delivery as skipped. */
  SMTP_URL: optional(z.string()),
  MAIL_FROM: z.string().default('D4 Reports <reports@d4.local>'),
};

export const publicUrl = {
  /** The browser-facing web address: links in emails, the allowed CORS origin. */
  D4_PUBLIC_URL: z.string().url(),
};

export const oidc = {
  OIDC_ISSUER: z.string().url(),
  OIDC_AUDIENCE: z.string().default('d4-api'),
  /**
   * Where to fetch signing keys when it differs from the public issuer URL, e.g. inside the
   * compose network (`http://keycloak:8080/...`) while tokens say `http://localhost:8080/...`.
   */
  OIDC_JWKS_URI: optional(z.string().url()),
};

export const telemetry = {
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.string().url()),
};

export const webhooks = {
  /** Allow http and private-network URLs for webhooks and connector sources. Local development only. */
  WEBHOOK_ALLOW_PRIVATE: flag,
};

/** The development credentials in deploy/env/dev-secrets.env; never accepted in production. */
const DEV_SECRET = 'd4-local-dev';

/** Reads `NAME_FILE=/path` into `NAME` (as Podman, Docker and Kubernetes mount secrets). */
function resolveFiles(env: Env): Env {
  const out: Env = { ...env };
  for (const [key, path] of Object.entries(env)) {
    if (!key.endsWith('_FILE') || !path) continue;
    const name = key.slice(0, -'_FILE'.length);
    if (!out[name]) out[name] = readFileSync(path, 'utf8').trim();
  }
  return out;
}

/** POSTGRES_URL from the same parts the postgres image takes, unless it is given whole. */
function derivePostgresUrl(env: Env): Env {
  const { POSTGRES_URL, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB } = env;
  if (POSTGRES_URL || !POSTGRES_HOST || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DB) return env;
  const auth = `${encodeURIComponent(POSTGRES_USER)}:${encodeURIComponent(POSTGRES_PASSWORD)}`;
  return { ...env, POSTGRES_URL: `postgres://${auth}@${POSTGRES_HOST}:${POSTGRES_PORT || 5432}/${POSTGRES_DB}` };
}

export type Config<S extends z.ZodRawShape> = z.infer<z.ZodObject<S & typeof base>>;

/** Parses the environment against a service's settings; one error lists every bad variable. */
export function loadConfig<S extends z.ZodRawShape>(shape: S, env: Env = process.env): Config<S> {
  const resolved = derivePostgresUrl(resolveFiles(env));
  const parsed = z.object({ ...shape, ...base }).safeParse(resolved);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const config = parsed.data as Config<S>;
  if (config.D4_ENV === 'production') {
    const problems = Object.keys(shape).flatMap((key) => {
      const value = (config as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.includes(DEV_SECRET)) return [`${key} uses the development secret`];
      if (key === 'WEBHOOK_ALLOW_PRIVATE' && value === true) return [`${key} is for local development only`];
      return [];
    });
    if (problems.length) throw new Error(`Invalid configuration for production (set D4_ENV=dev locally): ${problems.join('; ')}`);
  }
  return config;
}
