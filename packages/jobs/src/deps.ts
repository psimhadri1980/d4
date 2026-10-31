import { createDb } from '@d4/db';
import { S3ArtifactStore, SmtpMailer, graphConfig, TenantGraphs, type GraphEnv } from '@d4/infra';
import type { JobDeps } from './process';

/** The settings a job-running service reads (see the @d4/config fragments). */
export interface JobDepsEnv extends GraphEnv {
  POSTGRES_URL: string;
  S3_ENDPOINT: string;
  S3_ACCESS_KEY: string;
  S3_SECRET_KEY: string;
  S3_BUCKET: string;
  SMTP_URL?: string | undefined;
  MAIL_FROM: string;
  D4_PUBLIC_URL: string;
}

/**
 * Opens what jobs run against: Postgres, the tenant graphs, the artefact store and, when
 * SMTP_URL is set, the mailer. `close()` releases them in reverse order.
 */
export function openJobDeps(env: JobDepsEnv, extra: Partial<JobDeps> = {}) {
  const db = createDb(env.POSTGRES_URL, 4);
  const graphs = new TenantGraphs(db.db, graphConfig(env));
  const artifacts = new S3ArtifactStore({ endpoint: env.S3_ENDPOINT, accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY, bucket: env.S3_BUCKET });
  const mailer = env.SMTP_URL ? new SmtpMailer(env.SMTP_URL, env.MAIL_FROM) : undefined;
  const deps: JobDeps = { db: db.db, graphs, artifacts, appUrl: env.D4_PUBLIC_URL, ...(mailer && { mailer }), ...extra };
  return {
    deps,
    graphs,
    artifacts,
    async close() {
      mailer?.close();
      await graphs.close();
      artifacts.close();
      await db.close();
    },
  };
}
