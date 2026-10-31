import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { S3ArtifactStore } from '@d4/infra';
import { APP_CONFIG, type AppConfig } from '../config';
import { z } from '../http/zod';

/** The lifecycle contracts the shell understands (`LIFECYCLE_CONTRACT` in @d4/web-platform). */
export const CONTRACTS = [2] as const;

/** Where a tenant's uploaded releases are served: `/mfe/_r/<tenant>/<name>/<version>/` (the gateway reads the bucket). */
export const releasePrefix = (tenantId: string, name: string) => `/mfe/_r/${tenantId}/${name}/`;

const TYPES: Record<string, string> = {
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', map: 'application/json', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2',
};
const MAX_BYTES = 5 * 1024 * 1024;
// Versioned paths never change, so browsers and the gateway may keep them for a year.
const IMMUTABLE = 'public, max-age=31536000, immutable';

const FilePath = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9._/-]+\\.(${Object.keys(TYPES).join('|')})$`), 'a relative path with a known extension')
  .refine((p) => !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'), 'no empty, . or .. segments');

export const Version = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'a semantic version');

/** A release as the build writes it: its manifest and its files (base64), each with a SHA-256. */
export const ReleaseBody = z
  .object({
    manifest: z
      .object({
        name: z.string(),
        version: Version,
        contract: z.number().int().refine((c) => (CONTRACTS as readonly number[]).includes(c), `supported contracts: ${CONTRACTS.join(', ')}`),
        entry: FilePath,
        framework: z.enum(['react', 'vanilla', 'other']),
        /** Major versions of the shell's shared packages the module was built against, e.g. `{ react: '18' }`; the shell refuses a mismatch. */
        shared: z.record(z.string().min(1), z.string().regex(/^\d+$/, 'a major version')).default({}),
        files: z.record(FilePath, z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256 in hex')),
      })
      .strict(),
    files: z.record(FilePath, z.string()),
  })
  .strict();

/** Stores module releases in the web-modules bucket; a version, once stored, never changes. */
@Injectable()
export class WebModuleReleases implements OnModuleDestroy {
  private readonly store?: S3ArtifactStore;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.S3_ENDPOINT && config.S3_ACCESS_KEY && config.S3_SECRET_KEY) {
      this.store = new S3ArtifactStore({ endpoint: config.S3_ENDPOINT, accessKey: config.S3_ACCESS_KEY, secretKey: config.S3_SECRET_KEY, bucket: config.S3_WEB_MODULES_BUCKET });
    }
  }

  /** Checks a release and stores it; returns the entry URL to register. */
  private get s3(): S3ArtifactStore {
    if (!this.store) throw new ServiceUnavailableException('Module releases need S3 (S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY)');
    return this.store;
  }

  /** The versions of a module this tenant has uploaded, oldest first by semver. */
  async versions(tenantId: string, name: string): Promise<string[]> {
    const semver = (v: string) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? p.padStart(10, '0') : p)).join('.');
    return (await this.s3.folders(`${tenantId}/${name}/`)).sort((a, b) => semver(a).localeCompare(semver(b)));
  }

  /** Deletes an uploaded version; the caller makes sure it is not the active one. */
  async remove(tenantId: string, name: string, version: string): Promise<void> {
    const key = `${tenantId}/${name}/${version}/`;
    if (!(await this.s3.exists(`${key}manifest.json`))) throw new NotFoundException(`${name} ${version} is not released`);
    // The manifest first: without it the version no longer counts as released.
    await this.s3.delete(`${key}manifest.json`);
    await this.s3.deletePrefix(key);
  }

  async publish(tenantId: string, name: string, body: z.output<typeof ReleaseBody>): Promise<{ entry: string; version: string; contract: number; framework: string }> {
    const store = this.s3;
    const { manifest, files } = body;
    if (manifest.name !== name) throw new BadRequestException(`The manifest names '${manifest.name}', not '${name}'`);
    const listed = Object.keys(manifest.files).sort();
    if (JSON.stringify(listed) !== JSON.stringify(Object.keys(files).sort())) throw new BadRequestException('The files must be exactly those the manifest lists');
    if (!files[manifest.entry]) throw new BadRequestException(`The entry ${manifest.entry} is not among the files`);

    const bytes: Record<string, Buffer> = {};
    let total = 0;
    for (const [path, b64] of Object.entries(files)) {
      const buf = Buffer.from(b64, 'base64');
      if (createHash('sha256').update(buf).digest('hex') !== manifest.files[path]) throw new BadRequestException(`${path} does not match its SHA-256 in the manifest`);
      bytes[path] = buf;
      total += buf.byteLength;
    }
    if (total > MAX_BYTES) throw new BadRequestException(`A release may hold at most ${MAX_BYTES / 1024 / 1024} MB`);

    const key = `${tenantId}/${name}/${manifest.version}/`;
    if (await store.exists(`${key}manifest.json`)) throw new ConflictException(`${name} ${manifest.version} is already released; versions never change`);
    for (const [path, buf] of Object.entries(bytes)) await store.put(key + path, buf, TYPES[path.split('.').pop()!]!, IMMUTABLE);
    // The manifest last: its presence marks a complete release.
    await store.put(`${key}manifest.json`, JSON.stringify(manifest), 'application/json', IMMUTABLE);
    return { entry: `${releasePrefix(tenantId, name)}${manifest.version}/${manifest.entry}`, version: manifest.version, contract: manifest.contract, framework: manifest.framework };
  }

  onModuleDestroy() {
    this.store?.close();
  }
}
