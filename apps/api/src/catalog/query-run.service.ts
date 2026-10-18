import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { bindParams, contentHash, paramDefIssues } from '@d4/cypher';
import { DomainError } from '@d4/core';
import { QueryCatalogStore } from '@d4/db';
import { DEFAULT_LIMITS, runCatalogQuery, type QueryResultSet } from '@d4/graph';
import type { Principal } from '../auth/identity';
import { Database } from '../infra/database.service';
import { TenantGraphService } from '../infra/tenant-graph.service';
import { WorkspaceAccess } from '../model/workspace-access.service';
import { CatalogService, isSteward } from './catalog.service';
import { PackInstaller } from './pack-installer.service';

export interface RunResponse extends QueryResultSet {
  queryId: string;
  version: number;
  status: string;
}

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
    @Inject(Database) private readonly database: Database,
    @Inject(TenantGraphService) private readonly graph: TenantGraphService,
    @Inject(WorkspaceAccess) private readonly access: WorkspaceAccess,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(PackInstaller) private readonly packs: PackInstaller,
  ) {}

  async run(
    p: Principal,
    workspaceId: string,
    queryId: string,
    input: { params?: Record<string, unknown>; version?: number },
  ): Promise<RunResponse> {
    const scope = await this.access.resolve(p, workspaceId, 'read');
    await this.packs.ensureInstalled(p.tenantId);
    const store = new QueryCatalogStore(this.database.db);
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
