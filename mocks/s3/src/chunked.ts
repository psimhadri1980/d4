import { Transform, type TransformCallback } from 'node:stream';
import { incompleteBody, S3Error } from './errors';

const malformed = () => new S3Error('InvalidRequest', 400, 'The aws-chunked request body is malformed.');
/** A chunk header or trailer line longer than this is not aws-chunked. */
const MAX_LINE = 4096;

/**
 * Decodes an `aws-chunked` body (what the AWS SDK sends for streaming uploads and flexible
 * checksums): `<hex size>[;chunk-signature=…]\r\n<data>\r\n` … `0…\r\n`, then optional trailers
 * such as `x-amz-checksum-crc32:…` and an empty line. Trailers are collected in `trailers`.
 */
export class AwsChunkedDecoder extends Transform {
  readonly trailers: Record<string, string> = {};
  private buf: Buffer = Buffer.alloc(0);
  private state: 'size' | 'data' | 'data-end' | 'trailers' | 'done' = 'size';
  private remaining = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.drain();
      done();
    } catch (e) {
      done(e as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    // A final chunk without trailers may end without the closing empty line.
    done(this.state === 'done' || (this.state === 'trailers' && !this.buf.length) ? null : incompleteBody());
  }

  private drain(): void {
    for (;;) {
      if (this.state === 'done') return;
      if (this.state === 'data') {
        if (!this.buf.length) return;
        const n = Math.min(this.remaining, this.buf.length);
        this.push(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        if (!this.remaining) this.state = 'data-end';
        continue;
      }
      const eol = this.buf.indexOf('\r\n');
      if (eol < 0) {
        if (this.buf.length > MAX_LINE) throw malformed();
        return;
      }
      const line = this.buf.subarray(0, eol).toString('latin1');
      this.buf = this.buf.subarray(eol + 2);
      if (this.state === 'data-end') {
        if (line) throw malformed();
        this.state = 'size';
      } else if (this.state === 'size') {
        const size = parseInt(line.split(';')[0]!, 16);
        if (!Number.isInteger(size) || size < 0) throw malformed();
        this.remaining = size;
        this.state = size ? 'data' : 'trailers';
      } else if (!line) {
        this.state = 'done';
      } else {
        const colon = line.indexOf(':');
        if (colon > 0) this.trailers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }
  }
}
