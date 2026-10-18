import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import type { Principal } from '../auth/identity';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { parse } from '../http/errors';
import { z } from '../http/schemas';
import { CatalogService } from './catalog.service';
import { QueryRunService } from './query-run.service';

const SearchQuery = z.object({ q: z.string().optional(), tag: z.string().optional() });
const CreateBody = z
  .object({
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be kebab-case'),
    title: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
const MetaBody = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    certified: z.boolean().optional(),
  })
  .strict();
const DraftBody = z
  .object({
    cypher: z.string().min(1),
    params: z.array(z.unknown()).default([]),
    resultShape: z.enum(['table', 'graph']).default('table'),
  })
  .strict();
const ReviewBody = z.object({ decision: z.enum(['publish', 'reject']), note: z.string().optional() }).strict();
const StatusBody = z.object({ status: z.enum(['deprecated', 'retired', 'published']) }).strict();
const GrantsBody = z
  .array(z.object({ principalType: z.enum(['role', 'group']), principal: z.string().min(1) }).strict())
  .max(100);
const TestBody = z.object({ params: z.record(z.unknown()).optional() }).strict();
const RunBody = z
  .object({ params: z.record(z.unknown()).optional(), version: z.number().int().positive().optional() })
  .strict();

/** Tenant-wide catalog: discovery, authoring and stewardship. */
@Controller('v1/catalog')
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly catalog: CatalogService) {}

  @Get()
  search(@CurrentPrincipal() p: Principal, @Query() query: unknown) {
    return this.catalog.search(p, parse(SearchQuery, query));
  }

  @Post()
  create(@CurrentPrincipal() p: Principal, @Body() body: unknown) {
    return this.catalog.create(p, parse(CreateBody, body));
  }

  @Get(':id')
  detail(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.catalog.detail(p, id);
  }

  @Patch(':id')
  update(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.updateMeta(p, id, parse(MetaBody, body));
  }

  /** Deletes a never-published entry, or archives one with published history. */
  @Delete(':id')
  remove(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.catalog.remove(p, id);
  }

  @Put(':id/draft')
  saveDraft(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.saveDraft(p, id, parse(DraftBody, body));
  }

  @Post(':id/submit')
  @HttpCode(200)
  submit(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.catalog.submit(p, id);
  }

  @Post(':id/review')
  @HttpCode(200)
  review(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    const { decision, note } = parse(ReviewBody, body);
    return this.catalog.review(p, id, decision, note);
  }

  @Post(':id/versions/:version/status')
  @HttpCode(200)
  setStatus(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    return this.catalog.setVersionStatus(p, id, Number(version), parse(StatusBody, body).status);
  }

  @Put(':id/grants')
  setGrants(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.catalog.setGrants(p, id, parse(GrantsBody, body));
  }

  @Get(':id/executions')
  executions(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.catalog.executions(p, id);
  }
}

/** Running a catalog query is scoped to a workspace. */
@Controller('v1/workspaces/:ws/catalog')
export class CatalogRunController {
  constructor(@Inject(QueryRunService) private readonly runner: QueryRunService) {}

  /** Test-runs the open draft or version in review (tighter limits, not logged). */
  @Post(':id/test')
  @HttpCode(200)
  test(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    return this.runner.testDraft(p, ws, id, parse(TestBody, body ?? {}));
  }

  @Post(':id/run')
  @HttpCode(200)
  run(@CurrentPrincipal() p: Principal, @Param('ws') ws: string, @Param('id') id: string, @Body() body: unknown) {
    return this.runner.run(p, ws, id, parse(RunBody, body ?? {}));
  }
}
