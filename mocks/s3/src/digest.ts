import { createHash, type Hash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { badDigest } from './errors';

export type ChecksumAlgorithm = 'crc32' | 'crc32c' | 'crc64nvme' | 'sha1' | 'sha256';
export type Checksums = Partial<Record<ChecksumAlgorithm, string>>;
export const CHECKSUM_ALGORITHMS: readonly ChecksumAlgorithm[] = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'];
/** The ones this mock computes; CRC32C and CRC64NVME values are stored and returned as sent. */
const COMPUTED: readonly ChecksumAlgorithm[] = ['crc32', 'sha1', 'sha256'];

export interface DigestResult {
  bytes: number;
  md5: Buffer;
  sha256Hex: string;
  checksums: Checksums;
}

/** The digests S3 compares or returns, computed as the body streams past. */
export class Digests {
  private readonly md5: Hash = createHash('md5');
  private readonly sha1: Hash = createHash('sha1');
  private readonly sha256: Hash = createHash('sha256');
  private crc = 0;
  private bytes = 0;

  update(chunk: Buffer): void {
    this.md5.update(chunk);
    this.sha1.update(chunk);
    this.sha256.update(chunk);
    this.crc = crc32(chunk, this.crc);
    this.bytes += chunk.length;
  }

  result(): DigestResult {
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(this.crc >>> 0);
    const sha256 = this.sha256.digest();
    return {
      bytes: this.bytes,
      md5: this.md5.digest(),
      sha256Hex: sha256.toString('hex'),
      checksums: { crc32: crc.toString('base64'), sha1: this.sha1.digest('base64'), sha256: sha256.toString('base64') },
    };
  }
}

/** Throws BadDigest when a checksum the client sent (header or trailer) does not match the body. */
export function verifyChecksums(sent: Checksums, computed: Checksums): void {
  for (const alg of COMPUTED) {
    if (sent[alg] !== undefined && sent[alg] !== computed[alg]) throw badDigest(alg.toUpperCase());
  }
}
