import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/http/openapi';

/** Every route the API serves, as `METHOD /path/{param}`, read from the controllers' metadata. */
function servedRoutes(): string[] {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? []) as (new (...args: never[]) => unknown)[];
  const out: string[] = [];
  for (const c of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, c) ?? '');
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const handler = (c.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (method === undefined || path === undefined) continue;
      const full = `/${[base, path].filter((p) => p && p !== '/').join('/')}`.replace(/\/+/g, '/').replace(/:(\w+)\??/g, '{$1}');
      out.push(`${RequestMethod[method]} ${full}`);
    }
  }
  return [...new Set(out)].sort();
}

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument();
  const documented = new Set(Object.entries(doc.paths).flatMap(([path, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${path}`)));

  it('describes every route the API serves (the SDK is generated from it)', () => {
    const missing = servedRoutes().filter((r) => !documented.has(r) && !r.endsWith(' /v1/openapi.json') && !r.startsWith('GET /healthz') && !r.startsWith('GET /readyz'));
    expect(missing).toEqual([]);
  });

  it('matches the copy the SDK was generated from (run `pnpm --filter @d4/sdk generate` after API changes)', () => {
    const shipped = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'packages', 'sdk', 'openapi.json'), 'utf8'));
    expect(shipped).toEqual(JSON.parse(JSON.stringify(doc)));
  });
});
