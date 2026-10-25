import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { S3Error } from './errors';

export interface Credentials {
  accessKey: string;
  secretKey: string;
}

/** What the signature says about the body: its SHA-256, unsigned, or aws-chunked (optionally with trailers). */
export type Payload = { kind: 'sha256'; hex: string } | { kind: 'unsigned' } | { kind: 'chunked' };

/** S3 rejects requests whose timestamp is more than 15 minutes off. */
const MAX_SKEW_MS = 15 * 60_000;

/** AWS URI encoding: every byte except A–Z, a–z, 0–9, `-_.~` (and `/` in paths). */
function uriEncode(s: string, keepSlash = false): string {
  const encoded = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
const header = (req: IncomingMessage, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(',') : v;
};

/**
 * Verifies an AWS Signature Version 4 request, in the Authorization header or as a presigned
 * URL, and returns how the body is signed. Chunk signatures of signed aws-chunked bodies are
 * not checked; the request signature still covers the headers and the declared payload mode.
 */
export function verifyRequest(req: IncomingMessage, url: URL, creds: Credentials, now = Date.now()): Payload {
  const auth = header(req, 'authorization');
  if (auth) {
    const m = /^AWS4-HMAC-SHA256\s+Credential=([^,\s]+),\s*SignedHeaders=([^,\s]+),\s*Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header is malformed.');
    const payloadHash = header(req, 'x-amz-content-sha256');
    if (!payloadHash) throw new S3Error('InvalidRequest', 400, 'Missing required header for this request: x-amz-content-sha256');
    check(req, url, creds, now, { credential: m[1]!, signedHeaders: m[2]!, signature: m[3]!, date: header(req, 'x-amz-date'), payloadHash });
    return payload(payloadHash);
  }
  const q = url.searchParams;
  if (q.has('X-Amz-Signature')) {
    if (q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') throw new S3Error('AuthorizationQueryParametersError', 400, 'X-Amz-Algorithm only supports "AWS4-HMAC-SHA256"');
    const date = q.get('X-Amz-Date') ?? undefined;
    const expires = Number(q.get('X-Amz-Expires'));
    if (date && Number.isFinite(expires) && parseAmzDate(date) + expires * 1000 < now) throw new S3Error('AccessDenied', 403, 'Request has expired');
    check(req, url, creds, now, {
      credential: q.get('X-Amz-Credential') ?? '',
      signedHeaders: q.get('X-Amz-SignedHeaders') ?? '',
      signature: q.get('X-Amz-Signature') ?? '',
      date,
      payloadHash: 'UNSIGNED-PAYLOAD',
      presigned: true,
    });
    return { kind: 'unsigned' };
  }
  throw new S3Error('AccessDenied', 403, 'Access Denied');
}

interface SignedParts {
  credential: string;
  signedHeaders: string;
  signature: string;
  date: string | undefined;
  payloadHash: string;
  presigned?: boolean;
}

function check(req: IncomingMessage, url: URL, creds: Credentials, now: number, p: SignedParts) {
  const [accessKey, day, region, service, terminator] = p.credential.split('/');
  if (accessKey !== creds.accessKey) {
    throw new S3Error('InvalidAccessKeyId', 403, 'The AWS Access Key Id you provided does not exist in our records.');
  }
  if (!day || !region || service !== 's3' || terminator !== 'aws4_request' || !p.date?.startsWith(day)) {
    throw new S3Error('AuthorizationHeaderMalformed', 400, 'The authorization header is malformed; the credential scope is invalid.');
  }
  if (!p.presigned && Math.abs(now - parseAmzDate(p.date)) > MAX_SKEW_MS) {
    throw new S3Error('RequestTimeTooSkewed', 403, 'The difference between the request time and the current time is too large.');
  }
  const signed = p.signedHeaders.split(';');
  const query = [...url.searchParams]
    .filter(([k]) => !(p.presigned && k === 'X-Amz-Signature'))
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers = signed.map((h) => `${h}:${(header(req, h) ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = [req.method, uriEncode(decodeURIComponent(url.pathname), true), query, headers, signed.join(';'), p.payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', p.date, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${creds.secretKey}`, day), region), 's3'), 'aws4_request');
  const expected = hmac(key, stringToSign);
  const given = Buffer.from(p.signature, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new S3Error('SignatureDoesNotMatch', 403, 'The request signature we calculated does not match the signature you provided. Check your key and signing method.');
  }
}

function payload(hash: string): Payload {
  if (hash === 'UNSIGNED-PAYLOAD') return { kind: 'unsigned' };
  if (hash.startsWith('STREAMING-')) return { kind: 'chunked' };
  if (/^[0-9a-f]{64}$/.test(hash)) return { kind: 'sha256', hex: hash };
  throw new S3Error('InvalidArgument', 400, 'x-amz-content-sha256 must be UNSIGNED-PAYLOAD, a STREAMING- mode, or a SHA-256 value');
}

/** `20261025T101500Z` → epoch milliseconds. */
function parseAmzDate(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw new S3Error('AccessDenied', 403, 'AWS authentication requires a valid Date or x-amz-date header');
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
}
