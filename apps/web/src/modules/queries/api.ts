import { d4, type Schemas } from '@d4/web-platform';

export type { QueryParamDef } from '@d4/web-platform';

export type CatalogEntry = Schemas['CatalogEntry'];
export type QueryVersion = Schemas['QueryVersion'];
export type QueryGrant = Schemas['QueryGrant'];
export type RunResult = Schemas['RunResult'];

export interface Checks {
  errors: string[];
  warnings: string[];
}

export const catalogApi = {
  detail: (id: string) => d4().get('/v1/catalog/{id}', { path: { id } }),
  /** Test-runs the open draft (author) or version in review (author/steward); not logged. */
  test: (ws: string, id: string, params: Record<string, unknown>) =>
    d4().post('/v1/workspaces/{ws}/catalog/{id}/test', { path: { ws, id }, body: { params } }),
  create: (body: { slug: string; title: string; description?: string; tags?: string[] }) =>
    d4().post('/v1/catalog', { body }),
  updateMeta: (
    id: string,
    body: { title?: string; description?: string; tags?: string[]; certified?: boolean },
  ) => d4().patch('/v1/catalog/{id}', { path: { id }, body }),
  saveDraft: (
    id: string,
    body: { cypher: string; params: unknown[]; resultShape: 'table' | 'graph' },
  ) => d4().put('/v1/catalog/{id}/draft', { path: { id }, body: body as never }),
  submit: (id: string) => d4().post('/v1/catalog/{id}/submit', { path: { id } }),
  review: (id: string, decision: 'publish' | 'reject', note?: string) =>
    d4().post('/v1/catalog/{id}/review', { path: { id }, body: { decision, note } }),
  setVersionStatus: (id: string, version: number, status: 'deprecated' | 'retired' | 'published') =>
    d4().post('/v1/catalog/{id}/versions/{version}/status', {
      path: { id, version: String(version) },
      body: { status },
    }),
  setGrants: (id: string, grants: QueryGrant[]) =>
    d4().put('/v1/catalog/{id}/grants', { path: { id }, body: grants }),
  executions: (id: string) => d4().get('/v1/catalog/{id}/executions', { path: { id } }),
  /** Deletes a never-published entry, or archives one with published history. */
  remove: (id: string) => d4().delete('/v1/catalog/{id}', { path: { id } }),
};
