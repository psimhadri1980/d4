import { randomBytes, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AwsChunkedDecoder } from './chunked';
import { CHECKSUM_ALGORITHMS, Digests, verifyChecksums, type Checksums, type DigestResult } from './digest';
import { badDigest, incompleteBody, malformedXml, S3Error } from './errors';
import { verifyRequest, type Credentials, type Payload } from './sigv4';
import type { FileStore, NewObject, ObjectMeta } from './store';
import { el, elements, text, xmlDocument } from './xml';

interface S3ServerOptions {
  store: FileStore;
  credentials: Credentials;
  /** Buckets anyone may read objects from without signing (a public-read bucket policy in S3). */
  publicReadBuckets?: readonly string[];
  /** Largest single PUT or part; S3's own limit is 5 GiB. */
  maxObjectBytes?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

/** Headers stored with an object and returned on GET and HEAD. */
const STORED_HEADERS = ['cache-control', 'content-disposition', 'content-encoding', 'content-language', 'expires'];
/** Query parameters a GET may use to override response headers (presigned downloads). */
const RESPONSE_OVERRIDES: Record<string, string> = {
  'response-content-type': 'content-type',
  'response-content-language': 'content-language',
  'response-expires': 'expires',
  'response-cache-control': 'cache-control',
  'response-content-disposition': 'content-disposition',
  'response-content-encoding': 'content-encoding',
};
/** Sub-resources this mock does not implement (ACLs, tagging, versioning, policies …). */
const UNSUPPORTED = ['acl', 'tagging', 'versioning', 'versions', 'policy', 'cors', 'lifecycle', 'website', 'replication', 'encryption', 'logging', 'notification', 'retention', 'legal-hold', 'object-lock', 'torrent', 'select', 'restore', 'attributes'];
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 1024 * 1024;

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; bucket: string; key: string; payload: Payload };

/**
 * A development-only S3 endpoint with path-style addressing: buckets, objects (with ranges,
 * conditional requests, metadata and checksums), copies, batch deletes, ListObjects v1/v2 and
 * multipart uploads, answering with S3's XML documents, headers and error codes.
 */
export function createS3Server(options: S3ServerOptions): Server {
  const { store } = options;
  const maxBytes = options.maxObjectBytes ?? 5 * 1024 ** 3;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://s3.local');
    if (url.pathname === '/_health') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    res.setHeader('x-amz-request-id', randomBytes(8).toString('hex').toUpperCase());
    res.setHeader('x-amz-id-2', randomBytes(24).toString('base64'));
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      throw new S3Error('InvalidURI', 400, "Couldn't parse the specified URI.");
    }
    const slash = path.indexOf('/', 1);
    const anonymousRead =
      (req.method === 'GET' || req.method === 'HEAD') && slash > 0 && !req.headers.authorization && !url.search &&
      (options.publicReadBuckets ?? []).includes(path.slice(1, slash));
    const payload: Payload = anonymousRead ? { kind: 'unsigned' } : verifyRequest(req, url, options.credentials);
    const ctx: Ctx = {
      req,
      res,
      url,
      payload,
      bucket: slash < 0 ? path.slice(1) : path.slice(1, slash),
      key: slash < 0 ? '' : path.slice(slash + 1),
    };
    const q = url.searchParams;
    const sub = UNSUPPORTED.find((s) => q.has(s));
    if (sub) throw new S3Error('NotImplemented', 501, `The ${sub} sub-resource is not implemented by the D4 S3 mock.`);
    const m = req.method;

    if (!ctx.bucket) {
      if (m === 'GET') return listBuckets(res);
      throw methodNotAllowed();
    }
    if (!ctx.key) {
      if (m === 'PUT') return createBucket(ctx);
      if (m === 'HEAD') return headBucket(ctx);
      if (m === 'DELETE') return deleteBucket(ctx);
      if (m === 'POST' && q.has('delete')) return deleteObjects(ctx);
      if (m === 'GET' && q.has('location')) return sendXml(res, 200, xmlDocument('LocationConstraint', []));
      if (m === 'GET' && q.has('uploads')) throw new S3Error('NotImplemented', 501, 'ListMultipartUploads is not implemented by the D4 S3 mock.');
      if (m === 'GET') return listObjects(ctx);
      throw methodNotAllowed();
    }
    if (m === 'PUT' && q.has('uploadId')) return uploadPart(ctx);
    if (m === 'PUT' && ctx.req.headers['x-amz-copy-source']) return copyObject(ctx);
    if (m === 'PUT') return putObject(ctx);
    if (m === 'GET' && q.has('uploadId')) throw new S3Error('NotImplemented', 501, 'ListParts is not implemented by the D4 S3 mock.');
    if (m === 'GET' || m === 'HEAD') return getObject(ctx, m === 'HEAD');
    if (m === 'DELETE' && q.has('uploadId')) return abortUpload(ctx);
    if (m === 'DELETE') return deleteObject(ctx);
    if (m === 'POST' && q.has('uploads')) return createUpload(ctx);
    if (m === 'POST' && q.has('uploadId')) return completeUpload(ctx);
    throw methodNotAllowed();
  }

  // ── Buckets ───────────────────────────────────────────────────────────

  function listBuckets(res: ServerResponse) {
    const buckets = store.listBuckets().map((b) => el('Bucket', [el('Name', b.name), el('CreationDate', b.created)]));
    sendXml(res, 200, xmlDocument('ListAllMyBucketsResult', [el('Owner', [el('ID', 'd4'), el('DisplayName', 'd4')]), el('Buckets', buckets)]));
  }

  async function createBucket(ctx: Ctx) {
    await readSmallBody(ctx);
    await store.createBucket(ctx.bucket);
    ctx.res.writeHead(200, { location: `/${ctx.bucket}` }).end();
  }

  function headBucket(ctx: Ctx) {
    if (!store.hasBucket(ctx.bucket)) throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
    ctx.res.writeHead(200, { 'x-amz-bucket-region': 'us-east-1' }).end();
  }

  async function deleteBucket(ctx: Ctx) {
    await store.deleteBucket(ctx.bucket);
    ctx.res.writeHead(204).end();
  }

  function listObjects(ctx: Ctx) {
    const q = ctx.url.searchParams;
    const v2 = q.get('list-type') === '2';
    const prefix = q.get('prefix') ?? '';
    const delimiter = q.get('delimiter') ?? '';
    const maxKeys = Math.min(1000, Math.max(0, Number(q.get('max-keys') ?? 1000) || 0));
    const urlEncode = q.get('encoding-type') === 'url';
    const enc = (s: string) => (urlEncode ? encodeURIComponent(s).replace(/%2F/g, '/') : s);
    let after = '';
    let skipPrefix = false;
    if (v2 && q.get('continuation-token')) {
      try {
        ({ after, skipPrefix } = JSON.parse(Buffer.from(q.get('continuation-token')!, 'base64url').toString()) as { after: string; skipPrefix: boolean });
      } catch {
        throw new S3Error('InvalidArgument', 400, 'The continuation token provided is incorrect');
      }
    } else {
      after = (v2 ? q.get('start-after') : q.get('marker')) ?? '';
    }
    const page = store.list(ctx.bucket, { prefix, delimiter, after, skipPrefix, maxKeys });
    const contents = page.objects.map((o) =>
      el('Contents', [el('Key', enc(o.key)), el('LastModified', o.lastModified), el('ETag', o.etag), el('Size', o.size), el('StorageClass', 'STANDARD'), ...(v2 ? [] : [el('Owner', [el('ID', 'd4'), el('DisplayName', 'd4')])])]),
    );
    const common = page.prefixes.map((p) => el('CommonPrefixes', [el('Prefix', enc(p))]));
    const shared = [el('Name', ctx.bucket), el('Prefix', enc(prefix)), ...(delimiter ? [el('Delimiter', enc(delimiter))] : []), el('MaxKeys', maxKeys), ...(urlEncode ? [el('EncodingType', 'url')] : []), el('IsTruncated', page.truncated)];
    const paging = v2
      ? [
          el('KeyCount', page.objects.length + page.prefixes.length),
          ...(q.get('continuation-token') ? [el('ContinuationToken', q.get('continuation-token')!)] : []),
          ...(q.get('start-after') ? [el('StartAfter', enc(q.get('start-after')!))] : []),
          ...(page.truncated && page.next ? [el('NextContinuationToken', Buffer.from(JSON.stringify(page.next)).toString('base64url'))] : []),
        ]
      : [el('Marker', enc(after)), ...(page.truncated && page.next && delimiter ? [el('NextMarker', enc(page.next.after))] : [])];
    sendXml(ctx.res, 200, xmlDocument('ListBucketResult', [...shared, ...paging, ...contents, ...common]));
  }

  async function deleteObjects(ctx: Ctx) {
    const body = await readSmallBody(ctx);
    if (!store.hasBucket(ctx.bucket)) throw new S3Error('NoSuchBucket', 404, 'The specified bucket does not exist');
    const keys = elements(body, 'Object').map((o) => text(o, 'Key'));
    if (!keys.length || keys.length > 1000 || keys.some((k) => k === undefined)) throw malformedXml();
    const quiet = text(body, 'Quiet') === 'true';
    for (const k of keys) await store.delete(ctx.bucket, k!);
    sendXml(ctx.res, 200, xmlDocument('DeleteResult', quiet ? [] : keys.map((k) => el('Deleted', [el('Key', k!)]))));
  }

  // ── Objects ───────────────────────────────────────────────────────────

  async function putObject(ctx: Ctx) {
    const { file, digest, sent } = await receiveBody(ctx);
    const meta = await store.put(ctx.bucket, ctx.key, file, {
      ...objectFields(ctx.req),
      size: digest.bytes,
      etag: `"${digest.md5.toString('hex')}"`,
      // A computed CRC32 lets clients validate full-object GETs even when they sent no checksum.
      checksums: { crc32: digest.checksums.crc32!, ...sent },
    });
    ctx.res.writeHead(200, { etag: meta.etag, ...checksumHeaders(sent) }).end();
  }

  async function copyObject(ctx: Ctx) {
    const raw = decodeURIComponent(String(ctx.req.headers['x-amz-copy-source']).split('?')[0]!).replace(/^\//, '');
    const slash = raw.indexOf('/');
    if (slash < 1) throw new S3Error('InvalidArgument', 400, 'Copy Source must mention the source bucket and key: sourcebucket/sourcekey');
    const from = { bucket: raw.slice(0, slash), key: raw.slice(slash + 1) };
    const source = store.head(from.bucket, from.key);
    const replace = ctx.req.headers['x-amz-metadata-directive'] === 'REPLACE';
    if (!replace && from.bucket === ctx.bucket && from.key === ctx.key) {
      throw new S3Error('InvalidRequest', 400, 'This copy request is illegal because it is trying to copy an object to itself without changing the metadata.');
    }
    const fields: NewObject = { ...source, ...(replace ? objectFields(ctx.req) : {}) };
    const meta = await store.copy(from, { bucket: ctx.bucket, key: ctx.key }, fields);
    sendXml(ctx.res, 200, xmlDocument('CopyObjectResult', [el('LastModified', meta.lastModified), el('ETag', meta.etag)]));
  }

  async function getObject(ctx: Ctx, headOnly: boolean) {
    const meta = store.head(ctx.bucket, ctx.key);
    const notModified = preconditions(ctx.req, meta);
    const lastModified = new Date(meta.lastModified).toUTCString();
    const headers: Record<string, string | number> = {
      'content-type': meta.contentType,
      etag: meta.etag,
      'last-modified': lastModified,
      'accept-ranges': 'bytes',
      ...meta.headers,
      ...Object.fromEntries(Object.entries(meta.metadata).map(([k, v]) => [`x-amz-meta-${k}`, v])),
    };
    for (const [param, name] of Object.entries(RESPONSE_OVERRIDES)) {
      const v = ctx.url.searchParams.get(param);
      if (v !== null) headers[name] = v;
    }
    if (notModified) return void ctx.res.writeHead(304, { etag: meta.etag, 'last-modified': lastModified }).end();
    const range = parseRange(ctx.req.headers.range, meta.size);
    if (!range && ctx.req.headers['x-amz-checksum-mode'] === 'ENABLED') Object.assign(headers, checksumHeaders(meta.checksums));
    if (range) {
      headers['content-range'] = `bytes ${range.start}-${range.end}/${meta.size}`;
      headers['content-length'] = range.end - range.start + 1;
    } else {
      headers['content-length'] = meta.size;
    }
    ctx.res.writeHead(range ? 206 : 200, headers);
    if (headOnly || meta.size === 0) return void ctx.res.end();
    await pipeline(store.read(ctx.bucket, ctx.key, range), ctx.res);
  }

  async function deleteObject(ctx: Ctx) {
    await store.delete(ctx.bucket, ctx.key);
    ctx.res.writeHead(204).end();
  }

  // ── Multipart uploads ─────────────────────────────────────────────────

  async function createUpload(ctx: Ctx) {
    const id = await store.createUpload(ctx.bucket, ctx.key, objectFields(ctx.req));
    sendXml(ctx.res, 200, xmlDocument('InitiateMultipartUploadResult', [el('Bucket', ctx.bucket), el('Key', ctx.key), el('UploadId', id)]));
  }

  async function uploadPart(ctx: Ctx) {
    const id = ctx.url.searchParams.get('uploadId')!;
    const part = Number(ctx.url.searchParams.get('partNumber'));
    if (!Number.isInteger(part) || part < 1 || part > 10_000) throw new S3Error('InvalidArgument', 400, 'Part number must be an integer between 1 and 10000, inclusive');
    await store.upload(id, ctx.bucket, ctx.key);
    const { file, digest, sent } = await receiveBody(ctx);
    const etag = `"${digest.md5.toString('hex')}"`;
    await store.putPart(id, part, file, etag, digest.bytes);
    ctx.res.writeHead(200, { etag, ...checksumHeaders(sent) }).end();
  }

  async function completeUpload(ctx: Ctx) {
    const id = ctx.url.searchParams.get('uploadId')!;
    const upload = await store.upload(id, ctx.bucket, ctx.key);
    const body = await readSmallBody(ctx);
    const listed = elements(body, 'Part').map((p) => ({ number: Number(text(p, 'PartNumber')), etag: text(p, 'ETag') ?? '' }));
    if (!listed.length) throw malformedXml();
    const parts = [];
    for (const [i, p] of listed.entries()) {
      if (i > 0 && p.number <= listed[i - 1]!.number) throw new S3Error('InvalidPartOrder', 400, 'The list of parts was not in ascending order. Parts must be ordered by part number.');
      const stored = await store.part(id, p.number);
      if (!stored || stored.etag.replace(/"/g, '') !== p.etag.replace(/"/g, '')) {
        throw new S3Error('InvalidPart', 400, 'One or more of the specified parts could not be found. The part may not have been uploaded, or the specified entity tag may not match the part\'s entity tag.');
      }
      if (i < listed.length - 1 && stored.size < MIN_PART_BYTES) throw new S3Error('EntityTooSmall', 400, 'Your proposed upload is smaller than the minimum allowed object size.');
      parts.push(stored);
    }
    const joined = await store.joinParts(parts.map((p) => p.path));
    const md5s = Buffer.concat(parts.map((p) => Buffer.from(p.etag.replace(/"/g, ''), 'hex')));
    const etag = `"${createHash('md5').update(md5s).digest('hex')}-${parts.length}"`;
    const size = parts.reduce((n, p) => n + p.size, 0);
    await store.put(ctx.bucket, ctx.key, joined, { ...upload.object, size, etag, checksums: {} });
    await store.removeUpload(id);
    sendXml(ctx.res, 200, xmlDocument('CompleteMultipartUploadResult', [el('Location', `/${ctx.bucket}/${ctx.key}`), el('Bucket', ctx.bucket), el('Key', ctx.key), el('ETag', etag)]));
  }

  async function abortUpload(ctx: Ctx) {
    const id = ctx.url.searchParams.get('uploadId')!;
    await store.upload(id, ctx.bucket, ctx.key);
    await store.removeUpload(id);
    ctx.res.writeHead(204).end();
  }

  // ── Bodies ────────────────────────────────────────────────────────────

  /** The request body with aws-chunked framing removed, plus where its trailers will appear. */
  function decodedBody(ctx: Ctx): { stream: Readable; trailers: () => Record<string, string>; expected?: number } {
    const declared = ctx.req.headers['x-amz-decoded-content-length'] ?? ctx.req.headers['content-length'];
    const expected = declared === undefined ? undefined : Number(declared);
    if (ctx.payload.kind !== 'chunked') return { stream: ctx.req, trailers: () => ({}), ...(expected !== undefined && { expected }) };
    const decoder = new AwsChunkedDecoder();
    return { stream: ctx.req.pipe(decoder), trailers: () => decoder.trailers, ...(expected !== undefined && { expected }) };
  }

  /** Streams an object or part body to a temporary file, checking size, SHA-256, Content-MD5 and checksums. */
  async function receiveBody(ctx: Ctx): Promise<{ file: string; digest: DigestResult; sent: Checksums }> {
    const { stream, trailers, expected } = decodedBody(ctx);
    if (expected !== undefined && expected > maxBytes) throw new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.');
    const digests = new Digests();
    const file = store.tempPath();
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _e, done) {
        seen += chunk.length;
        if (seen > maxBytes) return done(new S3Error('EntityTooLarge', 400, 'Your proposed upload exceeds the maximum allowed object size.'));
        digests.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(stream, meter, createWriteStream(file));
      const digest = digests.result();
      checkBody(ctx, digest, expected);
      const sent = sentChecksums(ctx.req, trailers());
      verifyChecksums(sent, digest.checksums);
      return { file, digest, sent };
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
  }

  /** Small XML request bodies (Delete, CompleteMultipartUpload, CreateBucketConfiguration). */
  async function readSmallBody(ctx: Ctx): Promise<string> {
    const { stream, trailers, expected } = decodedBody(ctx);
    const digests = new Digests();
    const chunks: Buffer[] = [];
    let size = 0;
    const sink = new Writable({
      write(chunk: Buffer, _e, done) {
        size += chunk.length;
        if (size > MAX_XML_BYTES) return done(new S3Error('MaxMessageLengthExceeded', 400, 'Your request was too big.'));
        chunks.push(chunk);
        digests.update(chunk);
        done();
      },
    });
    await pipeline(stream, sink);
    const digest = digests.result();
    checkBody(ctx, digest, expected);
    verifyChecksums(sentChecksums(ctx.req, trailers()), digest.checksums);
    return Buffer.concat(chunks).toString('utf8');
  }

  function checkBody(ctx: Ctx, digest: DigestResult, expected: number | undefined) {
    if (expected !== undefined && digest.bytes !== expected) throw incompleteBody();
    if (ctx.payload.kind === 'sha256' && ctx.payload.hex !== digest.sha256Hex) {
      throw new S3Error('XAmzContentSHA256Mismatch', 400, "The provided 'x-amz-content-sha256' header does not match what was computed.");
    }
    const md5 = ctx.req.headers['content-md5'];
    if (md5 && md5 !== digest.md5.toString('base64')) throw badDigest('Content-MD5');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof S3Error ? e : new S3Error('InternalError', 500, 'We encountered an internal error. Please try again.');
      if (!(e instanceof S3Error)) options.log?.('request failed', { method: req.method, url: req.url, error: e instanceof Error ? e.message : String(e) });
      if (res.headersSent) return void res.destroy();
      // Let the client finish sending, so it reads the error instead of a reset connection.
      req.resume();
      res.setHeader('connection', 'close');
      if (req.method === 'HEAD') return void res.writeHead(err.status).end();
      sendXml(res, err.status, `<?xml version="1.0" encoding="UTF-8"?>\n${el('Error', [el('Code', err.code), el('Message', err.message), el('Resource', req.url ?? '/'), el('RequestId', String(res.getHeader('x-amz-request-id') ?? ''))])}`);
    });
  });
}

function sendXml(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'application/xml', 'content-length': Buffer.byteLength(body) }).end(body);
}

const methodNotAllowed = () => new S3Error('MethodNotAllowed', 405, 'The specified method is not allowed against this resource.');

/** Content type, stored headers and user metadata from a PUT, copy (REPLACE) or multipart create. */
function objectFields(req: IncomingMessage): Pick<ObjectMeta, 'contentType' | 'headers' | 'metadata'> {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
  const headers = Object.fromEntries(STORED_HEADERS.flatMap((h) => (req.headers[h] ? [[h, one(req.headers[h])!]] : [])));
  // aws-chunked is framing, not part of the object's encoding.
  if (headers['content-encoding']) {
    const rest = headers['content-encoding'].split(',').map((s) => s.trim()).filter((s) => s && s !== 'aws-chunked');
    if (rest.length) headers['content-encoding'] = rest.join(', ');
    else delete headers['content-encoding'];
  }
  const metadata = Object.fromEntries(
    Object.entries(req.headers).flatMap(([k, v]) => (k.startsWith('x-amz-meta-') && v !== undefined ? [[k.slice('x-amz-meta-'.length), one(v)!]] : [])),
  );
  return { contentType: one(req.headers['content-type']) ?? 'binary/octet-stream', headers, metadata };
}

/** Checksums the client declared, in headers or aws-chunked trailers. */
function sentChecksums(req: IncomingMessage, trailers: Record<string, string>): Checksums {
  return Object.fromEntries(
    CHECKSUM_ALGORITHMS.flatMap((alg) => {
      const v = req.headers[`x-amz-checksum-${alg}`] ?? trailers[`x-amz-checksum-${alg}`];
      return typeof v === 'string' ? [[alg, v]] : [];
    }),
  );
}

function checksumHeaders(checksums: Checksums): Record<string, string> {
  return Object.fromEntries(Object.entries(checksums).map(([alg, v]) => [`x-amz-checksum-${alg}`, v]));
}

/** If-Match / If-Unmodified-Since fail with 412; If-None-Match / If-Modified-Since return true for 304. */
function preconditions(req: IncomingMessage, meta: ObjectMeta): boolean {
  const tags = (h: string | undefined) => h?.split(',').map((t) => t.trim().replace(/^W\//, ''));
  const modified = Math.floor(new Date(meta.lastModified).getTime() / 1000) * 1000;
  const ifMatch = tags(req.headers['if-match']);
  const ifNoneMatch = tags(req.headers['if-none-match']);
  const failed = () => new S3Error('PreconditionFailed', 412, 'At least one of the pre-conditions you specified did not hold');
  if (ifMatch && !ifMatch.includes('*') && !ifMatch.includes(meta.etag)) throw failed();
  if (!ifMatch && req.headers['if-unmodified-since'] && modified > Date.parse(req.headers['if-unmodified-since'])) throw failed();
  if (ifNoneMatch) return ifNoneMatch.includes('*') || ifNoneMatch.includes(meta.etag);
  return !!req.headers['if-modified-since'] && modified <= Date.parse(req.headers['if-modified-since']);
}

/** One `bytes=` range (S3 ignores multi-range requests and serves the whole object). */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return undefined;
  let start: number;
  let end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) throw new S3Error('InvalidRange', 416, 'The requested range is not satisfiable');
  return { start, end };
}
