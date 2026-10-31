import type { Metamodel } from '@d4/metamodel';
import { d4, downloadFile, type Schemas } from './client';

export type Element = Schemas['Element'];
export type Relationship = Schemas['Relationship'];
export type Connection = Schemas['Connection'];
export type Job = Schemas['Job'];
export type Cadence = Schemas['Cadence'];
export type Schedule = Schemas['Schedule'];

/** What a sync job reports (`Job.result` for kind `sync`). */
export interface SyncResult {
  dryRun: boolean;
  applied: boolean;
  ok: boolean;
  records: number;
  /** Git connectors: the commit read, and the model files in it. */
  revision?: string;
  files?: string[];
  pages: number;
  elements: { created: number; updated: number; unchanged: number };
  relationships: { created: number; updated: number; unchanged: number };
  unchanged: number;
  conflicts: {
    count: number;
    items: { externalKey: string; elementId: string; name: string; applied: boolean }[];
  };
  deletedInD4: { count: number; items: string[] };
  missingInSource: { count: number; items: { externalKey: string; elementId: string }[] };
  unresolved: { count: number; items: { from: string; to: string; type: string }[] };
  mappingProblems: { count: number; items: { record: number; message: string }[] };
  issues: { message: string; ruleId?: string }[];
}

/** `asOf` (YYYY-MM-DD) and `scenario` (Scenario element id); omitted = ignore validity / baseline. */
export interface ViewParams {
  asOf?: string;
  scenario?: string;
}

interface ListFilter {
  type?: string[];
  layer?: string;
  lifecycle?: string[];
  q?: string;
  first?: number;
  after?: string;
}

/** List query values travel comma-separated (`?type=Application,Platform`); empty ones are left out. */
const list = (v: string[] | undefined) => (v?.length ? v.join(',') : undefined);
const text = (v: string | undefined) => v || undefined;
const view = (v: ViewParams) => ({ asOf: text(v.asOf), scenario: text(v.scenario) });

interface AttrChanges {
  set?: Record<string, unknown>;
  unset?: string[];
  validFrom?: string | null;
  validTo?: string | null;
}

/** The calls more than one module makes: workspaces, the model, exports, jobs and schedules. */
export const api = {
  workspaces: () => d4().get('/v1/workspaces'),
  metamodel: async (ws: string) =>
    (await d4().get('/v1/workspaces/{ws}/metamodel', { path: { ws } })) as unknown as Metamodel,
  me: () => d4().get('/v1/me'),

  listElements: (ws: string, f: ListFilter, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/elements', {
      path: { ws },
      query: {
        type: list(f.type),
        layer: text(f.layer),
        lifecycle: list(f.lifecycle),
        q: text(f.q),
        first: f.first,
        after: text(f.after),
        ...view(v),
      },
    }),
  element: (ws: string, id: string) =>
    d4().get('/v1/workspaces/{ws}/elements/{id}', { path: { ws, id } }),
  connections: (ws: string, id: string, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/elements/{id}/relationships', {
      path: { ws, id },
      query: view(v),
    }),
  history: (ws: string, id: string) =>
    d4().get('/v1/workspaces/{ws}/elements/{id}/history', { path: { ws, id } }),

  createElement: (
    ws: string,
    body: {
      type: string;
      attrs: Record<string, unknown>;
      validFrom?: string | null;
      validTo?: string | null;
    },
  ) => d4().post('/v1/workspaces/{ws}/elements', { path: { ws }, body }),
  updateElement: (ws: string, id: string, expectedVersion: number, changes: AttrChanges) =>
    d4().patch('/v1/workspaces/{ws}/elements/{id}', {
      path: { ws, id },
      body: { expectedVersion, ...changes },
    }),
  deleteElement: (ws: string, id: string, expectedVersion: number) =>
    d4().delete('/v1/workspaces/{ws}/elements/{id}', {
      path: { ws, id },
      query: { expectedVersion },
    }),
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
  ) => d4().post('/v1/workspaces/{ws}/relationships', { path: { ws }, body }),
  deleteRelationship: (ws: string, id: string, expectedVersion: number) =>
    d4().delete('/v1/workspaces/{ws}/relationships/{id}', {
      path: { ws, id },
      query: { expectedVersion },
    }),

  exportFile: (
    ws: string,
    format: string,
    opts: ViewParams & { scope?: string[]; depth?: number } = {},
  ) =>
    downloadFile(`/v1/workspaces/${encodeURIComponent(ws)}/export`, {
      format,
      scope: list(opts.scope),
      depth: opts.depth,
      ...view(opts),
    }),
  createExportJob: (
    ws: string,
    body: ViewParams & { format: string; scope?: string[]; depth?: number },
  ) => d4().post('/v1/workspaces/{ws}/jobs/export', { path: { ws }, body: body as never }),
  createRenderJob: (ws: string, body: Record<string, unknown>) =>
    d4().post('/v1/workspaces/{ws}/jobs/render', { path: { ws }, body: body as never }),
  jobs: (ws: string) => d4().get('/v1/workspaces/{ws}/jobs', { path: { ws } }),
  job: (ws: string, id: string) => d4().get('/v1/workspaces/{ws}/jobs/{id}', { path: { ws, id } }),
  jobFile: (ws: string, id: string) =>
    downloadFile(
      `/v1/workspaces/${encodeURIComponent(ws)}/jobs/${encodeURIComponent(id)}/artifact`,
    ),

  schedules: (ws: string) => d4().get('/v1/workspaces/{ws}/schedules', { path: { ws } }),
  createSchedule: (
    ws: string,
    body: {
      name: string;
      kind: 'export' | 'render';
      params: Record<string, unknown>;
      useRunDate: boolean;
      cadence: Cadence;
      recipients: string[];
    },
  ) => d4().post('/v1/workspaces/{ws}/schedules', { path: { ws }, body }),
  updateSchedule: (
    ws: string,
    id: string,
    body: Partial<{
      name: string;
      cadence: Cadence;
      enabled: boolean;
      useRunDate: boolean;
      recipients: string[];
    }>,
  ) => d4().patch('/v1/workspaces/{ws}/schedules/{id}', { path: { ws, id }, body }),
  deleteSchedule: (ws: string, id: string) =>
    d4().delete('/v1/workspaces/{ws}/schedules/{id}', { path: { ws, id } }),
  runSchedule: (ws: string, id: string) =>
    d4().post('/v1/workspaces/{ws}/schedules/{id}/run', { path: { ws, id } }),

  /** Runs a published catalog query (the query result view, the Explorer and Catalog). */
  runQuery: (ws: string, id: string, params: Record<string, unknown>, version?: number) =>
    d4().post('/v1/workspaces/{ws}/catalog/{id}/run', {
      path: { ws, id },
      body: { params, ...(version && { version }) },
    }),
  searchCatalog: (f: { q?: string; tag?: string } = {}) =>
    d4().get('/v1/catalog', { query: { q: text(f.q), tag: text(f.tag) } }),
};

export type Workspace = Awaited<ReturnType<typeof api.workspaces>>[number];
