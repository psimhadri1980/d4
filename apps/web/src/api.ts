import type { DecisionRecord, Element, LaneKind, Matrix, MatrixKind, ModelDiff, Relationship, RoadmapView } from '@d4/core';
import type { Metamodel } from '@d4/metamodel';
import { userManager } from './auth';
import { config } from './config';

export type { Element, Relationship, RoadmapView };

/** Error body shared by REST and GraphQL (`extensions.code`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: string[] = [],
    readonly ruleId?: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const user = await userManager.getUser();
  return user ? { authorization: `Bearer ${user.access_token}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: { ...(await authHeader()), ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      String(json['error'] ?? res.status),
      String(json['message'] ?? res.statusText),
      (json['issues'] as string[] | undefined) ?? [],
      json['ruleId'] as string | undefined,
    );
  }
  return json as T;
}

/** Downloads a file response (exports): the body and the server's file name. */
async function requestFile(path: string): Promise<{ blob: Blob; filename: string }> {
  const res = await fetch(`${config.apiUrl}${path}`, { headers: await authHeader() });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(res.status, String(json['error'] ?? res.status), String(json['message'] ?? res.statusText), (json['issues'] as string[] | undefined) ?? []);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export';
  return { blob: await res.blob(), filename: name };
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export interface ElementPage {
  items: Element[];
  endCursor: string | null;
  hasMore: boolean;
}

export interface Connection {
  relationship: Relationship;
  other: Element;
}

export interface Subgraph {
  root: Element;
  elements: Element[];
  relationships: Relationship[];
  truncated: boolean;
}

export interface DomainEvent {
  seq: number;
  id: string;
  type: string;
  actor: string;
  occurredAt: string;
  version: number;
  data: Record<string, unknown>;
}

/** `asOf` (YYYY-MM-DD) and `scenario` (Scenario element id); omitted = ignore validity / baseline. */
export interface ViewParams {
  asOf?: string;
  scenario?: string;
}

export type ModelDiffView = ModelDiff & { names: Record<string, string> };

export interface Upload {
  name: string;
  /** base64 */
  content: string;
}

export type TableMapping =
  | { kind: 'elements' | 'relationships'; type?: string; columns: Record<string, string> }
  | { kind: 'ignore' };

export interface AnalyzedTable {
  name: string;
  headers: string[];
  rowCount: number;
  preview: string[][];
  mapping: TableMapping;
}

export interface TabularImportResult {
  ok: boolean;
  applied: boolean;
  issues: { subjectId: string; ruleId?: string; message: string }[];
  rowIssues: { table: string; row: number; column?: string; message: string }[];
  rowsUsed: Record<string, number>;
  elements: { created: number; updated: number; unchanged: number };
  relationships: { created: number; updated: number; unchanged: number };
}

export interface Job {
  id: string;
  kind: 'export' | 'import-tabular' | 'render';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  artifact: { name: string; type: string; bytes: number } | null;
  attempts: number;
  scheduleId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type Cadence =
  | { frequency: 'daily'; hour: number }
  | { frequency: 'weekly'; hour: number; weekday: number }
  | { frequency: 'monthly'; hour: number; day: number };

export interface Schedule {
  id: string;
  name: string;
  kind: 'export' | 'render';
  params: Record<string, unknown>;
  useRunDate: boolean;
  cadence: Cadence;
  cadenceText: string;
  enabled: boolean;
  /** Set when the system paused the schedule, e.g. because the owner lost access. */
  pausedReason: string | null;
  recipients: string[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJob: Job | null;
  createdBy: string;
}

export interface ListFilter {
  type?: string[];
  layer?: string;
  lifecycle?: string[];
  q?: string;
  first?: number;
  after?: string;
}

const qs = (params: Record<string, string | number | string[] | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

export interface AttrChanges {
  set?: Record<string, unknown>;
  unset?: string[];
  validFrom?: string | null;
  validTo?: string | null;
}

/** REST commands and reads (see /v1/openapi.json). */
export const api = {
  workspaces: () => request<Workspace[]>('GET', '/v1/workspaces'),
  metamodel: (ws: string) => request<Metamodel>('GET', `/v1/workspaces/${ws}/metamodel`),
  me: () => request<{ userId: string; roles: string[]; tenantId: string }>('GET', '/v1/me'),
  roadmap: (ws: string, scope: string[], lanes: LaneKind) =>
    request<RoadmapView>('GET', `/v1/workspaces/${ws}/roadmap${qs({ scope, lanes })}`),

  listElements: (ws: string, f: ListFilter, view: ViewParams = {}) =>
    request<ElementPage>('GET', `/v1/workspaces/${ws}/elements${qs({ ...f, ...view })}`),
  element: (ws: string, id: string) => request<Element>('GET', `/v1/workspaces/${ws}/elements/${id}`),
  connections: (ws: string, id: string, view: ViewParams = {}) =>
    request<Connection[]>('GET', `/v1/workspaces/${ws}/elements/${id}/relationships${qs({ ...view })}`),
  neighbourhood: (ws: string, id: string, depth: number, view: ViewParams = {}) =>
    request<Subgraph>('GET', `/v1/workspaces/${ws}/elements/${id}/neighbourhood${qs({ depth, limit: 800, ...view })}`),
  matrix: (ws: string, kind: MatrixKind, view: ViewParams = {}) =>
    request<Matrix & { truncated: boolean }>('GET', `/v1/workspaces/${ws}/matrix/${kind}${qs({ ...view })}`),
  decisions: (ws: string, view: ViewParams = {}) => request<DecisionRecord[]>('GET', `/v1/workspaces/${ws}/decisions${qs({ ...view })}`),
  exportFile: (ws: string, format: string, opts: ViewParams & { scope?: string[]; depth?: number } = {}) =>
    requestFile(`/v1/workspaces/${ws}/export${qs({ format, ...opts, depth: opts.depth })}`),
  analyzeTabular: (ws: string, files: Upload[]) =>
    request<{ tables: AnalyzedTable[] }>('POST', `/v1/workspaces/${ws}/import/tabular/analyze`, { files }),
  importTabular: (ws: string, files: Upload[], mappings: { table: string; mapping: TableMapping }[], dryRun: boolean) =>
    request<TabularImportResult>('POST', `/v1/workspaces/${ws}/import/tabular${dryRun ? '?dryRun=true' : ''}`, { files, mappings }),
  createExportJob: (ws: string, body: ViewParams & { format: string; scope?: string[]; depth?: number }) =>
    request<Job>('POST', `/v1/workspaces/${ws}/jobs/export`, body),
  createImportJob: (ws: string, files: Upload[], mappings: { table: string; mapping: TableMapping }[], dryRun: boolean) =>
    request<Job>('POST', `/v1/workspaces/${ws}/jobs/import-tabular${dryRun ? '?dryRun=true' : ''}`, { files, mappings }),
  createRenderJob: (ws: string, body: Record<string, unknown>) => request<Job>('POST', `/v1/workspaces/${ws}/jobs/render`, body),
  schedules: (ws: string) => request<Schedule[]>('GET', `/v1/workspaces/${ws}/schedules`),
  createSchedule: (ws: string, body: { name: string; kind: 'export' | 'render'; params: Record<string, unknown>; useRunDate: boolean; cadence: Cadence; recipients: string[] }) =>
    request<Schedule>('POST', `/v1/workspaces/${ws}/schedules`, body),
  updateSchedule: (ws: string, id: string, body: Partial<{ name: string; cadence: Cadence; enabled: boolean; useRunDate: boolean; recipients: string[] }>) =>
    request<Schedule>('PATCH', `/v1/workspaces/${ws}/schedules/${id}`, body),
  deleteSchedule: (ws: string, id: string) => request<void>('DELETE', `/v1/workspaces/${ws}/schedules/${id}`),
  runSchedule: (ws: string, id: string) => request<Job>('POST', `/v1/workspaces/${ws}/schedules/${id}/run`),
  jobs: (ws: string) => request<Job[]>('GET', `/v1/workspaces/${ws}/jobs`),
  jobFile: (ws: string, id: string) => requestFile(`/v1/workspaces/${ws}/jobs/${id}/artifact`),
  diff: (ws: string, from: ViewParams, to: ViewParams) =>
    request<ModelDiffView>(
      'GET',
      `/v1/workspaces/${ws}/diff${qs({ fromAsOf: from.asOf, fromScenario: from.scenario, toAsOf: to.asOf, toScenario: to.scenario })}`,
    ),
  history: (ws: string, id: string) => request<DomainEvent[]>('GET', `/v1/workspaces/${ws}/elements/${id}/history`),

  createElement: (ws: string, body: { type: string; attrs: Record<string, unknown>; validFrom?: string | null; validTo?: string | null }) =>
    request<Element>('POST', `/v1/workspaces/${ws}/elements`, body),
  updateElement: (ws: string, id: string, expectedVersion: number, changes: AttrChanges) =>
    request<Element>('PATCH', `/v1/workspaces/${ws}/elements/${id}`, { expectedVersion, ...changes }),
  deleteElement: (ws: string, id: string, expectedVersion: number) =>
    request<void>('DELETE', `/v1/workspaces/${ws}/elements/${id}${qs({ expectedVersion })}`),

  createRelationship: (
    ws: string,
    body: {
      type: string;
      fromId: string;
      toId: string;
      attrs?: Record<string, unknown>;
      validFrom?: string | null;
      validTo?: string | null;
      scenarioId?: string | null;
    },
  ) => request<Relationship>('POST', `/v1/workspaces/${ws}/relationships`, body),
  deleteRelationship: (ws: string, id: string, expectedVersion: number) =>
    request<void>('DELETE', `/v1/workspaces/${ws}/relationships/${id}${qs({ expectedVersion })}`),
};

// ── Query Catalog ───────────────────────────────────────────────────────

export interface CatalogEntry {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  tags: string[];
  system: boolean;
  certified: boolean;
  ownerId: string;
  publishedVersion: number | null;
  openStatus: 'draft' | 'in_review' | null;
}

export interface QueryParamDef {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date' | 'enum' | 'element' | 'string[]';
  label?: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  values?: string[];
  elementTypes?: string[];
}

export type QueryStatus = 'draft' | 'in_review' | 'published' | 'deprecated' | 'retired';

export interface QueryVersion {
  id: string;
  version: number;
  status: QueryStatus;
  cypher: string;
  params: QueryParamDef[];
  resultShape: 'table' | 'graph';
  contentHash: string;
  checks: { errors: string[]; warnings: string[] } | null;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  publishedAt: string | null;
}

export interface QueryGrant {
  principalType: 'role' | 'group';
  principal: string;
}

export interface CatalogDetail extends CatalogEntry {
  versions: QueryVersion[];
  grants?: QueryGrant[];
}

export interface RunResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  durationMs: number;
  queryId: string;
  version: number;
  status: string;
}

export interface Execution {
  seq: number;
  version: number;
  workspaceId: string;
  userId: string;
  params: Record<string, unknown>;
  status: 'ok' | 'error' | 'timeout';
  rowCount: number | null;
  durationMs: number;
  error: string | null;
  executedAt: string;
}

export interface Checks {
  errors: string[];
  warnings: string[];
}

export const catalogApi = {
  search: (f: { q?: string; tag?: string } = {}) => request<CatalogEntry[]>('GET', `/v1/catalog${qs(f)}`),
  detail: (id: string) => request<CatalogDetail>('GET', `/v1/catalog/${id}`),
  run: (ws: string, id: string, params: Record<string, unknown>, version?: number) =>
    request<RunResult>('POST', `/v1/workspaces/${ws}/catalog/${id}/run`, { params, ...(version && { version }) }),

  /** Test-runs the open draft (author) or version in review (author/steward); not logged. */
  test: (ws: string, id: string, params: Record<string, unknown>) =>
    request<RunResult>('POST', `/v1/workspaces/${ws}/catalog/${id}/test`, { params }),

  create: (body: { slug: string; title: string; description?: string; tags?: string[] }) =>
    request<CatalogEntry>('POST', '/v1/catalog', body),
  updateMeta: (id: string, body: { title?: string; description?: string; tags?: string[]; certified?: boolean }) =>
    request<CatalogEntry>('PATCH', `/v1/catalog/${id}`, body),
  saveDraft: (id: string, body: { cypher: string; params: unknown[]; resultShape: 'table' | 'graph' }) =>
    request<{ version: QueryVersion; checks: Checks }>('PUT', `/v1/catalog/${id}/draft`, body),
  submit: (id: string) => request<QueryVersion>('POST', `/v1/catalog/${id}/submit`),

  review: (id: string, decision: 'publish' | 'reject', note?: string) =>
    request<QueryVersion>('POST', `/v1/catalog/${id}/review`, { decision, note }),
  setVersionStatus: (id: string, version: number, status: 'deprecated' | 'retired' | 'published') =>
    request<QueryVersion>('POST', `/v1/catalog/${id}/versions/${version}/status`, { status }),
  setGrants: (id: string, grants: QueryGrant[]) => request<QueryGrant[]>('PUT', `/v1/catalog/${id}/grants`, grants),
  executions: (id: string) => request<Execution[]>('GET', `/v1/catalog/${id}/executions`),
  /** Deletes a never-published entry, or archives one with published history. */
  remove: (id: string) => request<{ removed: 'deleted' | 'archived' }>('DELETE', `/v1/catalog/${id}`),
};

/** The current user's roles decide which catalog screens they get. */
export const can = (roles: string[] | undefined) => ({
  author: !!roles && (roles.includes('query-author') || roles.includes('admin')),
  steward: !!roles && (roles.includes('query-steward') || roles.includes('admin')),
  admin: !!roles && roles.includes('admin'),
});

/** Roles a binding can grant (same list as the API's). */
export const ROLES = ['viewer', 'contributor', 'planner', 'architect', 'query-author', 'query-steward', 'admin'] as const;

export interface AdminWorkspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  archived: boolean;
}

export interface Member {
  principalType: 'user' | 'group';
  principalId: string;
  label: string;
  role: string;
  createdBy: string;
  createdAt: string;
}

export interface TenantUser {
  id: string;
  email: string | null;
  displayName: string | null;
  realmRoles: string[];
  lastSeenAt: string;
}

export const adminApi = {
  workspaces: () => request<AdminWorkspace[]>('GET', '/v1/admin/workspaces?archived=true'),
  createWorkspace: (body: { slug: string; name: string; description?: string }) => request<AdminWorkspace>('POST', '/v1/admin/workspaces', body),
  updateWorkspace: (id: string, body: { name?: string; description?: string | null }) => request<AdminWorkspace>('PATCH', `/v1/admin/workspaces/${id}`, body),
  setArchived: (id: string, archived: boolean) => request<void>('POST', `/v1/admin/workspaces/${id}/${archived ? 'archive' : 'restore'}`),
  users: () => request<TenantUser[]>('GET', '/v1/admin/users'),
  members: (scope: string) => request<Member[]>('GET', `/v1/admin/members/${scope}`),
  grant: (scope: string, principalId: string, role: string) => request<void>('POST', `/v1/admin/members/${scope}`, { principalId, role }),
  revoke: (scope: string, m: Pick<Member, 'principalType' | 'principalId' | 'role'>) =>
    request<void>('DELETE', `/v1/admin/members/${scope}`, { principalType: m.principalType, principalId: m.principalId, role: m.role }),
};
