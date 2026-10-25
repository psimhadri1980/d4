import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Server } from '../src/server';
import { FileStore } from '../src/store';

const credentials = { accessKey: 'test-key', secretKey: 'test-secret' };
let dir: string;
let server: Server;
let endpoint: string;
let s3: S3Client;

const client = (secretKey = credentials.secretKey) =>
  new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: credentials.accessKey, secretAccessKey: secretKey } });

async function start() {
  server = createS3Server({ store: await FileStore.open(dir), credentials });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  s3 = client();
}
const stop = () => new Promise<void>((r) => (s3.destroy(), server.close(() => r())));
const text = async (key: string, extra: Record<string, unknown> = {}) =>
  (await s3.send(new GetObjectCommand({ Bucket: 'bk1', Key: key, ...extra }))).Body!.transformToString();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'd4-mock-s3-'));
  await start();
  await s3.send(new CreateBucketCommand({ Bucket: 'bk1' }));
});
afterAll(stop);

describe('mock S3 with the AWS SDK', () => {
  it('creates, finds and refuses duplicate or invalid buckets', async () => {
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'bk1' }))).resolves.toBeTruthy();
    await expect(s3.send(new HeadBucketCommand({ Bucket: 'nope' }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    await expect(s3.send(new CreateBucketCommand({ Bucket: 'bk1' }))).rejects.toMatchObject({ name: 'BucketAlreadyOwnedByYou' });
    await expect(s3.send(new CreateBucketCommand({ Bucket: 'Bad_Name' }))).rejects.toMatchObject({ name: 'InvalidBucketName' });
    expect((await s3.send(new ListBucketsCommand({}))).Buckets?.map((b) => b.Name)).toContain('bk1');
  });

  it('round-trips bytes, content type, stored headers and metadata', async () => {
    const put = await s3.send(
      new PutObjectCommand({ Bucket: 'bk1', Key: 'dir/hello world+ä.txt', Body: 'Hello', ContentType: 'text/plain', ContentDisposition: 'attachment; filename="h.txt"', Metadata: { owner: 'Ada' } }),
    );
    expect(put.ETag).toBe('"8b1a9953c4611296a827abf8c47804d7"');
    const got = await s3.send(new GetObjectCommand({ Bucket: 'bk1', Key: 'dir/hello world+ä.txt' }));
    expect(await got.Body!.transformToString()).toBe('Hello');
    expect(got).toMatchObject({ ContentType: 'text/plain', ContentLength: 5, ContentDisposition: 'attachment; filename="h.txt"', Metadata: { owner: 'Ada' }, ETag: put.ETag });
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'bk1', Key: 'dir/hello world+ä.txt' }));
    expect(head).toMatchObject({ ContentLength: 5, ETag: put.ETag });
  });

  it('accepts streamed (aws-chunked) uploads with a trailing checksum', async () => {
    const parts = ['stream', 'ed ', 'body'];
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'streamed', Body: Readable.from(parts.map((p) => Buffer.from(p))), ContentLength: 13 }));
    expect(await text('streamed')).toBe('streamed body');
  });

  it('validates checksums on upload and returns them on GET', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'sum', Body: 'abc', ChecksumAlgorithm: 'SHA256' }));
    const got = await s3.send(new GetObjectCommand({ Bucket: 'bk1', Key: 'sum', ChecksumMode: 'ENABLED' }));
    expect(got.ChecksumSHA256).toBe('ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=');
    expect(await got.Body!.transformToString()).toBe('abc');
    await expect(s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'bad', Body: 'abc', ChecksumCRC32: 'AAAAAA==' }))).rejects.toMatchObject({ name: 'BadDigest' });
  });

  it('serves ranges and conditional requests', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'digits', Body: '0123456789' }));
    expect(await text('digits', { Range: 'bytes=2-4' })).toBe('234');
    expect(await text('digits', { Range: 'bytes=-3' })).toBe('789');
    expect(await text('digits', { Range: 'bytes=7-' })).toBe('789');
    await expect(text('digits', { Range: 'bytes=20-' })).rejects.toMatchObject({ $metadata: { httpStatusCode: 416 } });
    const { ETag } = await s3.send(new HeadObjectCommand({ Bucket: 'bk1', Key: 'digits' }));
    await expect(text('digits', { IfNoneMatch: ETag })).rejects.toMatchObject({ $metadata: { httpStatusCode: 304 } });
    await expect(text('digits', { IfMatch: '"other"' })).rejects.toMatchObject({ $metadata: { httpStatusCode: 412 } });
  });

  it('reports missing keys and deletes idempotently', async () => {
    await expect(text('missing')).rejects.toMatchObject({ name: 'NoSuchKey' });
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'gone', Body: 'x' }));
    await s3.send(new DeleteObjectCommand({ Bucket: 'bk1', Key: 'gone' }));
    await s3.send(new DeleteObjectCommand({ Bucket: 'bk1', Key: 'gone' }));
    await expect(text('gone')).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('lists with prefix, delimiter and pagination (v2 and v1)', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'list' }));
    for (const k of ['a/1', 'a/2', 'b/1', 'c', 'd']) await s3.send(new PutObjectCommand({ Bucket: 'list', Key: k, Body: k }));
    const page1 = await s3.send(new ListObjectsV2Command({ Bucket: 'list', Delimiter: '/', MaxKeys: 2 }));
    expect(page1).toMatchObject({ IsTruncated: true, KeyCount: 2, CommonPrefixes: [{ Prefix: 'a/' }, { Prefix: 'b/' }] });
    const page2 = await s3.send(new ListObjectsV2Command({ Bucket: 'list', Delimiter: '/', MaxKeys: 2, ContinuationToken: page1.NextContinuationToken }));
    expect(page2.Contents?.map((o) => o.Key)).toEqual(['c', 'd']);
    expect(page2.IsTruncated).toBe(false);
    const prefixed = await s3.send(new ListObjectsV2Command({ Bucket: 'list', Prefix: 'a/' }));
    expect(prefixed.Contents?.map((o) => [o.Key, o.Size])).toEqual([['a/1', 3], ['a/2', 3]]);
    const v1 = await s3.send(new ListObjectsCommand({ Bucket: 'list', Marker: 'b/1' }));
    expect(v1.Contents?.map((o) => o.Key)).toEqual(['c', 'd']);
  });

  it('copies objects and batch-deletes', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'src', Body: 'copy me', ContentType: 'text/x' }));
    const copy = await s3.send(new CopyObjectCommand({ Bucket: 'bk1', Key: 'dst', CopySource: 'bk1/src' }));
    expect(copy.CopyObjectResult?.ETag).toBeTruthy();
    expect(await text('dst')).toBe('copy me');
    const del = await s3.send(new DeleteObjectsCommand({ Bucket: 'bk1', Delete: { Objects: [{ Key: 'src' }, { Key: 'dst' }, { Key: 'never' }] } }));
    expect(del.Deleted?.map((d) => d.Key)).toEqual(['src', 'dst', 'never']);
    await expect(text('dst')).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('completes and aborts multipart uploads', async () => {
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'bk1', Key: 'big', ContentType: 'application/x-test' }));
    const first = Buffer.alloc(5 * 1024 * 1024, 'a');
    const p1 = await s3.send(new UploadPartCommand({ Bucket: 'bk1', Key: 'big', UploadId, PartNumber: 1, Body: first }));
    const p2 = await s3.send(new UploadPartCommand({ Bucket: 'bk1', Key: 'big', UploadId, PartNumber: 2, Body: 'tail' }));
    const done = await s3.send(
      new CompleteMultipartUploadCommand({ Bucket: 'bk1', Key: 'big', UploadId, MultipartUpload: { Parts: [{ PartNumber: 1, ETag: p1.ETag }, { PartNumber: 2, ETag: p2.ETag }] } }),
    );
    expect(done.ETag).toMatch(/^"[0-9a-f]{32}-2"$/);
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'bk1', Key: 'big' }));
    expect(head).toMatchObject({ ContentLength: first.length + 4, ContentType: 'application/x-test' });
    expect(await text('big', { Range: `bytes=${first.length}-` })).toBe('tail');

    const aborted = await s3.send(new CreateMultipartUploadCommand({ Bucket: 'bk1', Key: 'never' }));
    await s3.send(new AbortMultipartUploadCommand({ Bucket: 'bk1', Key: 'never', UploadId: aborted.UploadId }));
    await expect(s3.send(new UploadPartCommand({ Bucket: 'bk1', Key: 'never', UploadId: aborted.UploadId, PartNumber: 1, Body: 'x' }))).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('refuses a wrong secret and deleting a non-empty bucket', async () => {
    const wrong = client('not-the-secret');
    await expect(wrong.send(new ListBucketsCommand({}))).rejects.toMatchObject({ name: 'SignatureDoesNotMatch' });
    wrong.destroy();
    await expect(s3.send(new DeleteBucketCommand({ Bucket: 'bk1' }))).rejects.toMatchObject({ name: 'BucketNotEmpty' });
  });

  it('keeps everything across a restart', async () => {
    await s3.send(new PutObjectCommand({ Bucket: 'bk1', Key: 'durable', Body: 'still here', Metadata: { k: 'v' } }));
    await stop();
    await start();
    const got = await s3.send(new GetObjectCommand({ Bucket: 'bk1', Key: 'durable' }));
    expect(await got.Body!.transformToString()).toBe('still here');
    expect(got.Metadata).toEqual({ k: 'v' });
  });
});
