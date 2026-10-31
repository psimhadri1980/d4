import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/** Where job inputs (uploads) and outputs (export files) are kept. */
export interface ArtifactStore {
  put(key: string, body: Uint8Array | string, contentType: string): Promise<number>;
  get(key: string): Promise<Uint8Array>;
  /** Removes an object; removing one that is already gone is not an error. */
  delete(key: string): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  region?: string;
}

/** S3 (the file-backed mock in mocks/s3 locally): path-style addressing, one bucket for job artefacts. */
export class S3ArtifactStore implements ArtifactStore {
  private readonly s3: S3Client;
  private bucketChecked = false;

  constructor(private readonly config: S3Config) {
    this.s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region ?? 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
    });
  }

  async put(key: string, body: Uint8Array | string, contentType: string, cacheControl?: string): Promise<number> {
    await this.ensureBucket();
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    await this.s3.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes, ContentType: contentType, CacheControl: cacheControl }));
    return bytes.byteLength;
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!res.Body) throw new Error(`artefact ${key} has no body`);
    return res.Body.transformToByteArray();
  }

  async exists(key: string): Promise<boolean> {
    await this.ensureBucket();
    return this.s3.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key })).then(
      () => true,
      (e: { name?: string }) => (e.name === 'NotFound' || e.name === 'NoSuchKey' ? false : Promise.reject(e)),
    );
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  /** Deployments create the bucket (locally the mock does, from S3_MOCK_BUCKETS); creating it here too keeps tests self-contained. */
  private async ensureBucket() {
    if (this.bucketChecked) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.config.bucket })).catch(() => undefined);
    }
    this.bucketChecked = true;
  }

  close() {
    this.s3.destroy();
  }
}

/** For tests and single-process runs. */
export class MemoryArtifactStore implements ArtifactStore {
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  async put(key: string, body: Uint8Array | string, contentType: string) {
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: bytes, contentType });
    return bytes.byteLength;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`no artefact ${key}`);
    return o.body;
  }
}
