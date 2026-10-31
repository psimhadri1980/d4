import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { bindParams, checkCatalogQuery, checkReadOnly, contentHash, paramDefIssues } from '@d4/cypher';
import { DomainError } from '@d4/core';
import { QueryCatalogStore } from '@d4/db';
import { assertQueryRunQuota } from '@d4/infra';
import { DEFAULT_LIMITS, neo4jExplainer, runCatalogQuery, type QueryResultSet, type RunLimits } from '@d4/graph';
import type { Principal } from '../auth/identity';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import { WorkspaceAccess } from '../workspaces/workspace-access.service';
import { CatalogService, isAuthor, isSteward } from './catalog.service';
import { PackInstaller } from './pack-installer.service';

/** @public Named in the controller's emitted declarations. */
export interface RunResponse extends QueryResultSet {
  queryId: string;
  version: number;
  status: string;
}

/** Draft test runs are for checking shape and correctness, so they get tighter limits. */
const TEST_LIMITS: RunLimits = { timeoutMs: 10_000, maxRows: 100 };

/** Neo4j reports transaction timeouts with these status codes. */
const TIMEOUT_CODES = [
  'Neo.ClientError.Transaction.TransactionTimedOut',
  'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration',
];

/**
 * Executes published catalog versions for users. Every guard runs before the database is touched:
 * workspace access, grant, published status, fingerprint and parameter binding.
 */
@Injectable()
export class QueryRunService {
  constructor(
    @Inject(QueryCatalogStore) private readonly queryCatalogStore: QueryCatalogStore,
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PackInstaller) private readonly packs: PackInstaller,
  ) {}

  /**
   * Test-runs the open draft (authors) or the version in review (authors and stewards) against a
   * workspace. Same safety gates as publishing: static checks and Neo4j's read-only
   * classification must pass first. Not logged as a production run.
   */
  async testDraft(
    p: Principal,
    workspaceId: string,
    queryId: string,
    input: { params?: Record<string, unknown> },
  ): Promise<RunResponse> {
    if (!isAuthor(p) && !isSteward(p)) throw new ForbiddenException('Requires query-author or query-steward');
    const scope = await this.access.resolve(p, workspaceId, 'read');
    await this.catalog.entry(p, queryId);
    const store = this.queryCatalogStore;
    const open = await store.openVersion(queryId);
    if (!open) throw new NotFoundException('There is no draft or version in review to test');
    if (open.status === 'draft' && !isAuthor(p)) throw new ForbiddenException('Drafts can be tested by authors');

    const { defs, issues: defIssues } = paramDefIssues(open.params);
    const stat = checkCatalogQuery(open.cypher, defs);
    const blocking = [...defIssues, ...stat.errors];
    if (!blocking.length) {
      const nulls = Object.fromEntries(defs.map((d) => [d.name, null]));
      const ro = await checkReadOnly(neo4jExplainer(this.graph.sessions(p.tenantId)), open.cypher, {
        ...nulls,
        workspace: scope.workspaceId,
      });
      blocking.push(...ro.errors);
    }
    if (blocking.length) throw new DomainError('VALIDATION', 'Fix the check errors before test-running', blocking);

    const { values, issues } = bindParams(defs, input.params ?? {});
    if (issues.length) throw new DomainError('VALIDATION', 'Invalid parameters', issues);
    try {
      const result = await runCatalogQuery(
        this.graph.sessions(p.tenantId),
        open.cypher,
        { ...values, workspace: scope.workspaceId },
        TEST_LIMITS,
      );
      return { ...result, queryId, version: open.version, status: open.status };
    } catch (e) {
      if (TIMEOUT_CODES.includes((e as { code?: string }).code ?? '')) {
        throw new DomainError('VALIDATION', `The test run exceeded ${TEST_LIMITS.timeoutMs / 1000} s and was stopped`);
      }
      throw e;
    }
  }

  async run(
    p: Principal,
    workspaceId: string,
    queryId: string,
    input: { params?: Record<string, unknown>; version?: number },
  ): Promise<RunResponse> {
    const scope = await this.access.resolve(p, workspaceId, 'read');
    await this.packs.ensureInstalled(p.tenantId);
    const store = this.queryCatalogStore;
    await this.catalog.entry(p, queryId);

    // Grant check (stewards may run anything published, e.g. to review usage).
    if (!isSteward(p) && !(await store.canRun(queryId, p.roles, await this.catalog.groups(p)))) {
      throw new NotFoundException(`Query '${queryId}' not found`);
    }

    const version = input.version
      ? await store.version(queryId, input.version)
      : await store.latestPublished(queryId);
    if (!version) throw new NotFoundException('No published version');
    if (version.status !== 'published' && version.status !== 'deprecated') {
      throw new ConflictException(`Version ${version.version} is ${version.status} and cannot be run`);
    }
    if (version.kind !== 'read') throw new ConflictException('Write queries are not supported yet');
    if (contentHash(version) !== version.contentHash) {
      throw new ConflictException('Stored query does not match its fingerprint; refusing to run');
    }

    const { defs } = paramDefIssues(version.params);
    const { values, issues } = bindParams(defs, input.params ?? {});
    if (issues.length) throw new DomainError('VALIDATION', 'Invalid parameters', issues);

    const base = {
      tenantId: p.tenantId,
      queryId,
      version: version.version,
      workspaceId: scope.workspaceId,
      userId: p.userId,
      params: values,
    };
    await assertQueryRunQuota(this.database.db, p.tenantId);
    const started = Date.now();
    try {
      const result = await runCatalogQuery(
        this.graph.sessions(p.tenantId),
        version.cypher,
        { ...values, workspace: scope.workspaceId },
        DEFAULT_LIMITS,
      );
      await store.logExecution({ ...base, status: 'ok', rowCount: result.rows.length, durationMs: result.durationMs });
      return { ...result, queryId, version: version.version, status: version.status };
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      const timedOut = TIMEOUT_CODES.includes(code);
      await store.logExecution({
        ...base,
        status: timedOut ? 'timeout' : 'error',
        durationMs: Date.now() - started,
        error: (e as Error).message.slice(0, 500),
      });
      if (timedOut) throw new DomainError('VALIDATION', 'The query took too long and was stopped');
      throw e;
    }
  }
}
