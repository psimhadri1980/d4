import { createHash } from 'node:crypto';
import { BadRequestException, Controller, Delete, Get, Headers, HttpCode, Inject, NotFoundException, Param, Post, Put, Res } from '@nestjs/common';
import { WebModuleStore, type WebModuleRow } from '@d4/db';
import type { Principal } from '../auth/identity';
import { Roles } from '../auth/auth.guard';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/zod';
import { ValidBody } from '../http/zod.pipe';
import { CONTRACTS, ReleaseBody, releasePrefix, WebModuleReleases } from './releases';

/** The part of Fastify's reply this controller uses. */
interface Reply {
  header(name: string, value: string): unknown;
  code(status: number): unknown;
}

const ModuleName = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase letters, digits and dashes, 2–32 characters, starting with a letter');

/**
 * A module's details. The entry must be a same-origin path under the module's own `/mfe/<name>/`
 * or a release this tenant uploaded (`/mfe/_r/<tenant>/<name>/`): registering a module runs its
 * code in every member's browser, so it can only point at code the platform serves.
 */
const ModuleBody = z
  .object({
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().default(null),
    owner: z.string().trim().max(80).nullable().default(null),
    entry: z
      .string()
      .regex(/^\/mfe\/[a-z0-9_-]+\/[A-Za-z0-9._/-]+\.m?js$/, 'a path under /mfe/<name>/ ending in .js')
      .refine((e) => !e.split('/').some((seg, i) => i > 0 && (seg === '' || seg === '.' || seg === '..')), 'no empty, . or .. segments'),
    version: z.string().trim().min(1).max(40),
    contract: z.number().int().refine((c) => (CONTRACTS as readonly number[]).includes(c), `supported contracts: ${CONTRACTS.join(', ')}`),
    framework: z.enum(['react', 'vanilla', 'other']),
    enabled: z.boolean().default(true),
  })
  .strict();

const view = (m: WebModuleRow) => ({
  name: m.name,
  title: m.title,
  description: m.description,
  owner: m.owner,
  entry: m.entry,
  version: m.version,
  contract: m.contract,
  framework: m.framework,
  enabled: m.enabled,
  updatedAt: m.updatedAt.toISOString(),
});

/**
 * What the shell loads: the tenant's enabled modules. The shell asks again every so often and on
 * focus; the ETag makes an unchanged registry a bodiless 304.
 */
@Controller('v1')
export class WebModulesController {
  constructor(@Inject(WebModuleStore) private readonly store: WebModuleStore) {}

  @Get('web-modules')
  async enabled(@CurrentPrincipal() p: Principal, @Headers('if-none-match') ifNoneMatch: string | undefined, @Res({ passthrough: true }) res: Reply) {
    const modules = (await this.store.list(p.tenantId)).filter((m) => m.enabled).map(({ name, title, entry, version, contract }) => ({ name, title, entry, version, contract }));
    const etag = `"${createHash('sha1').update(JSON.stringify(modules)).digest('base64url')}"`;
    res.header('etag', etag);
    res.header('cache-control', 'no-cache');
    if (ifNoneMatch === etag) {
      res.code(304);
      return;
    }
    return { modules };
  }
}

/** Registering, releasing, turning off and removing modules. Admin only. */
@Controller('v1/admin')
@Roles('admin')
export class AdminWebModulesController {
  constructor(
    @Inject(WebModuleStore) private readonly store: WebModuleStore,
    @Inject(WebModuleReleases) private readonly releases: WebModuleReleases,
  ) {}

  @Get('web-modules')
  async list(@CurrentPrincipal() p: Principal) {
    return (await this.store.list(p.tenantId)).map(view);
  }

  /** Registers a module, or records a new release of it (entry, version, details). */
  @Put('web-modules/:name')
  async put(@CurrentPrincipal() p: Principal, @Param('name') name: string, @ValidBody(ModuleBody) b: z.output<typeof ModuleBody>) {
    parse(ModuleName, name);
    if (!b.entry.startsWith(`/mfe/${name}/`) && !b.entry.startsWith(releasePrefix(p.tenantId, name))) {
      throw new BadRequestException(`The entry must be under /mfe/${name}/ or ${releasePrefix(p.tenantId, name)}`);
    }
    return view(await this.store.put(p.tenantId, name, b, p.userId));
  }

  /**
   * Uploads a release (manifest plus files) to the module store. It does not activate it: register
   * the returned entry and version with PUT, per tenant, which is also how a rollback works.
   */
  @Post('web-modules/:name/releases')
  async release(@CurrentPrincipal() p: Principal, @Param('name') name: string, @ValidBody(ReleaseBody) b: z.output<typeof ReleaseBody>) {
    parse(ModuleName, name);
    return this.releases.publish(p.tenantId, name, b);
  }

  @Delete('web-modules/:name')
  @HttpCode(204)
  async remove(@CurrentPrincipal() p: Principal, @Param('name') name: string) {
    if (!(await this.store.remove(p.tenantId, name))) throw new NotFoundException(`Module '${name}' not found`);
  }
}
