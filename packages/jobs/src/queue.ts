import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

export const JOB_QUEUE = 'd4-jobs';
/** Attempts per job (the first run plus retries) for transient failures. */
export const JOB_ATTEMPTS = 3;

/** The queue carries only identifiers; everything else is in the jobs table and artefact store. */
export interface JobMessage {
  tenantId: string;
  jobId: string;
}

/** `redis://[:password@]host:port[/db]` → BullMQ connection options. */
export function redisConnection(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.password && { password: decodeURIComponent(u.password) }),
    ...(u.pathname.length > 1 && { db: Number(u.pathname.slice(1)) }),
    // Required by BullMQ workers; keeps commands waiting through a Redis restart.
    maxRetriesPerRequest: null,
  };
}

export class JobQueue {
  private readonly queue: Queue<JobMessage>;

  constructor(redisUrl: string, name = JOB_QUEUE) {
    this.queue = new Queue<JobMessage>(name, { connection: redisConnection(redisUrl) });
  }

  /** The job id doubles as the queue id, so enqueuing the same job twice is a no-op. */
  async enqueue(msg: JobMessage): Promise<void> {
    await this.queue.add('run', msg, {
      jobId: msg.jobId,
      attempts: JOB_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  close() {
    return this.queue.close();
  }

  /** Removes the queue's keys from Redis (tests). */
  obliterate() {
    return this.queue.obliterate({ force: true });
  }
}

export function startJobWorker(
  redisUrl: string,
  handle: (msg: JobMessage, attempt: { made: number; max: number }) => Promise<void>,
  opts: { concurrency?: number; queue?: string } = {},
): Worker<JobMessage> {
  return new Worker<JobMessage>(
    opts.queue ?? JOB_QUEUE,
    (job: Job<JobMessage>) => handle(job.data, { made: job.attemptsMade, max: job.opts.attempts ?? 1 }),
    { connection: redisConnection(redisUrl), concurrency: opts.concurrency ?? 2 },
  );
}
