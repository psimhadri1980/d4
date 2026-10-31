import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Checksums } from './digest';
import { noSuchBucket, noSuchKey, noSuchUpload, S3Error } from './errors';

/** What S3 keeps about an object besides its bytes. */
export interface ObjectMeta {
  key: string;
  size: number;
  /** Quoted, as S3 sends it: MD5 hex, or `<md5 of part MD5s>-<parts>` after a multipart upload. */
  etag: string;
  lastModified: string;
  contentType: string;
  /** Returned as stored: Cache-Control, Content-Disposition, Content-Encoding, Content-Language, Expires. */
  headers: Record<string, string>;
  /** User metadata (`x-amz-meta-*`), names lower-case without the prefix. */
  metadata: Record<string, string>;
  checksums: Checksums;
}

export type NewObject = Omit<ObjectMeta, 'key' | 'lastModified'>;

interface Upload {
  bucket: string;
  key: string;
  object: Pick<ObjectMeta, 'contentType' | 'headers' | 'metadata'>;
}

interface ListOptions {
  prefix: string;
  delimiter: string;
  /** Keys up to and including this one are skipped; with `skipPrefix`, so is everything under it. */
  after: string;
  skipPrefix: boolean;
  maxKeys: number;
}

interface Listing {
  objects: ObjectMeta[];
  prefixes: string[];
  truncated: boolean;
  /** Where the next page starts: the last key or common prefix returned. */
  next?: { after: string; skipPrefix: boolean };
}

/** S3 orders keys by their UTF-8 bytes. */
const byBytes = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
/** File names for keys: any key is up to 1024 bytes and may contain `/` or `..`. */
const fileName = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Buckets and objects in plain files, with an in-memory index rebuilt at start:
 *
 *   <root>/buckets/<bucket>/.bucket.json          creation date
 *   <root>/buckets/<bucket>/<sha256(key)>          object bytes
 *   <root>/buckets/<bucket>/<sha256(key)>.json     ObjectMeta
 *   <root>/uploads/<id>/upload.json, <part>        multipart uploads in progress
 *   <root>/tmp/                                    bodies being received
 */
export class FileStore {
  private readonly buckets = new Map<string, { created: string; objects: Map<string, ObjectMeta> }>();

  private constructor(private readonly root: string) {}

  static async open(root: string): Promise<FileStore> {
    const store = new FileStore(root);
    await Promise.all(['buckets', 'uploads', 'tmp'].map((d) => mkdir(join(root, d), { recursive: true })));
    await rm(join(root, 'tmp'), { recursive: true, force: true });
    await mkdir(join(root, 'tmp'));
    for (const name of await readdir(join(root, 'buckets'))) {
      const dir = join(root, 'buckets', name);
      const { created } = JSON.parse(await readFile(join(dir, '.bucket.json'), 'utf8')) as { created: string };
      const objects = new Map<string, ObjectMeta>();
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.json') || f === '.bucket.json') continue;
        const meta = JSON.parse(await readFile(join(dir, f), 'utf8')) as ObjectMeta;
        objects.set(meta.key, meta);
      }
      store.buckets.set(name, { created, objects });
    }
    return store;
  }

  listBuckets(): { name: string; created: string }[] {
    return [...this.buckets].map(([name, b]) => ({ name, created: b.created })).sort((a, b) => byBytes(a.name, b.name));
  }

  hasBucket(name: string): boolean {
    return this.buckets.has(name);
  }

  async createBucket(name: string): Promise<void> {
    if (!/^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name) || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
      throw new S3Error('InvalidBucketName', 400, 'The specified bucket is not valid.');
    }
    if (this.buckets.has(name)) {
      throw new S3Error('BucketAlreadyOwnedByYou', 409, 'Your previous request to create the named bucket succeeded and you already own it.');
    }
    const created = new Date().toISOString();
    await mkdir(join(this.root, 'buckets', name), { recursive: true });
    await this.writeJson(join(this.root, 'buckets', name, '.bucket.json'), { created });
    this.buckets.set(name, { created, objects: new Map() });
  }

  async deleteBucket(name: string): Promise<void> {
    if (this.bucket(name).objects.size) throw new S3Error('BucketNotEmpty', 409, 'The bucket you tried to delete is not empty');
    await rm(join(this.root, 'buckets', name), { recursive: true, force: true });
    this.buckets.delete(name);
  }

  head(bucket: string, key: string): ObjectMeta {
    const meta = this.bucket(bucket).objects.get(key);
    if (!meta) throw noSuchKey();
    return meta;
  }

  read(bucket: string, key: string, range?: { start: number; end: number }): ReadStream {
    this.head(bucket, key);
    return createReadStream(this.objectPath(bucket, key), range);
  }

  /** A fresh path under tmp/ for a body being received; `put` moves it into place. */
  tempPath(): string {
    return join(this.root, 'tmp', randomBytes(12).toString('hex'));
  }

  async put(bucket: string, key: string, file: string, object: NewObject): Promise<ObjectMeta> {
    const b = this.bucket(bucket);
    checkKey(key);
    const meta: ObjectMeta = { ...object, key, lastModified: new Date().toISOString() };
    await rename(file, this.objectPath(bucket, key));
    await this.writeJson(`${this.objectPath(bucket, key)}.json`, meta);
    b.objects.set(key, meta);
    return meta;
  }

  async copy(from: { bucket: string; key: string }, to: { bucket: string; key: string }, object: NewObject): Promise<ObjectMeta> {
    this.head(from.bucket, from.key);
    const tmp = this.tempPath();
    await copyFile(this.objectPath(from.bucket, from.key), tmp);
    return this.put(to.bucket, to.key, tmp, object);
  }

  async delete(bucket: string, key: string): Promise<void> {
    const b = this.bucket(bucket);
    if (!b.objects.delete(key)) return;
    const path = this.objectPath(bucket, key);
    await Promise.all([rm(path, { force: true }), rm(`${path}.json`, { force: true })]);
  }

  list(bucket: string, o: ListOptions): Listing {
    const objects: ObjectMeta[] = [];
    const prefixes: string[] = [];
    let next: Listing['next'];
    for (const key of [...this.bucket(bucket).objects.keys()].sort(byBytes)) {
      if (!key.startsWith(o.prefix)) continue;
      if (o.after && (byBytes(key, o.after) <= 0 || (o.skipPrefix && key.startsWith(o.after)))) continue;
      const cut = o.delimiter ? key.indexOf(o.delimiter, o.prefix.length) : -1;
      const prefix = cut >= 0 ? key.slice(0, cut + o.delimiter.length) : undefined;
      if (prefix !== undefined && prefixes[prefixes.length - 1] === prefix) continue;
      if (objects.length + prefixes.length === o.maxKeys) return { objects, prefixes, truncated: true, ...(next && { next }) };
      if (prefix !== undefined) {
        prefixes.push(prefix);
        next = { after: prefix, skipPrefix: true };
      } else {
        objects.push(this.head(bucket, key));
        next = { after: key, skipPrefix: false };
      }
    }
    return { objects, prefixes, truncated: false };
  }

  async createUpload(bucket: string, key: string, object: Upload['object']): Promise<string> {
    this.bucket(bucket);
    checkKey(key);
    const id = randomBytes(24).toString('base64url');
    await mkdir(join(this.root, 'uploads', id));
    await this.writeJson(join(this.root, 'uploads', id, 'upload.json'), { bucket, key, object } satisfies Upload);
    return id;
  }

  async upload(id: string, bucket: string, key: string): Promise<Upload> {
    const raw = await readFile(join(this.root, 'uploads', id, 'upload.json'), 'utf8').catch(() => undefined);
    const upload = raw ? (JSON.parse(raw) as Upload) : undefined;
    if (!upload || upload.bucket !== bucket || upload.key !== key) throw noSuchUpload();
    return upload;
  }

  async putPart(id: string, part: number, file: string, etag: string, size: number): Promise<void> {
    const path = join(this.root, 'uploads', id, String(part));
    await rename(file, path);
    await this.writeJson(`${path}.json`, { etag, size });
  }

  async part(id: string, part: number): Promise<{ etag: string; size: number; path: string } | undefined> {
    const path = join(this.root, 'uploads', id, String(part));
    const raw = await readFile(`${path}.json`, 'utf8').catch(() => undefined);
    return raw ? { ...(JSON.parse(raw) as { etag: string; size: number }), path } : undefined;
  }

  /** Concatenates parts into one file under tmp/, which `put` then moves into place. */
  async joinParts(paths: string[]): Promise<string> {
    const tmp = this.tempPath();
    const out = createWriteStream(tmp);
    for (const p of paths) await pipeline(createReadStream(p), out, { end: false });
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    return tmp;
  }

  async removeUpload(id: string): Promise<void> {
    await rm(join(this.root, 'uploads', id), { recursive: true, force: true });
  }

  private bucket(name: string) {
    const b = this.buckets.get(name);
    if (!b) throw noSuchBucket();
    return b;
  }

  private objectPath(bucket: string, key: string): string {
    return join(this.root, 'buckets', bucket, fileName(key));
  }

  /** Write-then-rename, so a crash never leaves half a metadata file. */
  private async writeJson(path: string, value: unknown): Promise<void> {
    const tmp = this.tempPath();
    await writeFile(tmp, JSON.stringify(value));
    await rename(tmp, path);
  }
}

function checkKey(key: string) {
  if (!key || Buffer.byteLength(key) > 1024) throw new S3Error('KeyTooLongError', 400, 'Your key is too long');
}
