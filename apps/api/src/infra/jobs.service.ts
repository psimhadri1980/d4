import { Inject, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { JobQueue, RENDER_QUEUE, S3ArtifactStore } from '@d4/jobs';
import { APP_CONFIG, type AppConfig } from '../config';

/** The job queue (Redis) and artefact store (S3), when configured. */
@Injectable()
export class JobsInfra implements OnModuleDestroy {
  private readonly q?: JobQueue;
  private readonly rq?: JobQueue;
  private readonly a?: S3ArtifactStore;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.REDIS_URL && config.S3_ENDPOINT) {
      this.q = new JobQueue(config.REDIS_URL, config.JOB_QUEUE);
      this.rq = new JobQueue(config.REDIS_URL, config.RENDER_QUEUE ?? RENDER_QUEUE);
      this.a = new S3ArtifactStore({
        endpoint: config.S3_ENDPOINT,
        accessKey: config.S3_ACCESS_KEY,
        secretKey: config.S3_SECRET_KEY,
        bucket: config.S3_BUCKET,
      });
    }
  }

  get queue(): JobQueue {
    if (!this.q) throw new ServiceUnavailableException('Background jobs are not configured (REDIS_URL, S3_ENDPOINT)');
    return this.q;
  }

  /** Renders go to the renderer service (Chromium). */
  get renderQueue(): JobQueue {
    if (!this.rq) throw new ServiceUnavailableException('Background jobs are not configured (REDIS_URL, S3_ENDPOINT)');
    return this.rq;
  }

  get artifacts(): S3ArtifactStore {
    if (!this.a) throw new ServiceUnavailableException('Background jobs are not configured (REDIS_URL, S3_ENDPOINT)');
    return this.a;
  }

  async onModuleDestroy() {
    await this.q?.close();
    await this.rq?.close();
    this.a?.close();
  }
}
