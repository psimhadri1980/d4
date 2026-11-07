import type { MatrixKind } from '@d4/core';
import { d4, type Schemas, type ViewParams } from '@d4/web-platform';

/** A Graph Studio search without the view, which comes from the page's view picker. */
type StudioSearch = Omit<Schemas['StudioSearch'], 'asOf' | 'scenario'>;
type StudioCountSearch = Schemas['StudioCounts']['searches'][number];
type StudioOpen = Omit<Schemas['StudioOpen'], 'asOf' | 'scenario'>;
export type LensInput = Schemas['StudioLensInput'];

const text = (v: string | undefined) => v || undefined;
const view = (v: ViewParams) => ({ asOf: text(v.asOf), scenario: text(v.scenario) });

export const exploreApi = {
  neighbourhood: (ws: string, id: string, depth: number, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/elements/{id}/neighbourhood', {
      path: { ws, id },
      query: { depth, limit: 800, ...view(v) },
    }),
  /** Graph Studio: every element the search matches is a root, loaded with its neighbourhood. */
  studioSearch: (ws: string, search: StudioSearch, v: ViewParams = {}) =>
    d4().post('/v1/workspaces/{ws}/studio/search', { path: { ws }, body: { ...search, ...view(v) } }),
  /** How many roots each search finds, for the lens list while no lens is chosen. */
  studioOpen: (ws: string, body: StudioOpen, v: ViewParams = {}) =>
    d4().post('/v1/workspaces/{ws}/studio/open', { path: { ws }, body: { ...body, ...view(v) } }),
  studioCounts: (ws: string, searches: StudioCountSearch[], v: ViewParams = {}, sample = 0) =>
    d4().post('/v1/workspaces/{ws}/studio/counts', { path: { ws }, body: { searches, cap: 1000, sample, ...view(v) } }),
  /** For the lens editor: a contour type's count, links and attribute values. */
  studioProfile: (ws: string, type: string, attributes: string[], v: ViewParams = {}) =>
    d4().post('/v1/workspaces/{ws}/studio/profile', { path: { ws }, body: { type, attributes, ...view(v) } }),
  lenses: (ws: string) => d4().get('/v1/workspaces/{ws}/studio/lenses', { path: { ws } }),
  createLens: (ws: string, body: LensInput) => d4().post('/v1/workspaces/{ws}/studio/lenses', { path: { ws }, body }),
  updateLens: (ws: string, id: string, body: LensInput) => d4().put('/v1/workspaces/{ws}/studio/lenses/{id}', { path: { ws, id }, body }),
  deleteLens: (ws: string, id: string) => d4().delete('/v1/workspaces/{ws}/studio/lenses/{id}', { path: { ws, id } }),
  // The catalog, for query lenses (D84): authors' new queries go in as drafts and are submitted for review.
  catalog: () => d4().get('/v1/catalog', { query: {} }),
  catalogQuery: (id: string) => d4().get('/v1/catalog/{id}', { path: { id } }),
  createQuery: (body: { slug: string; title: string; tags?: string[] }) => d4().post('/v1/catalog', { body }),
  saveQueryDraft: (id: string, body: { cypher: string; params: unknown[]; resultShape: 'table' | 'graph' }) =>
    d4().put('/v1/catalog/{id}/draft', { path: { id }, body: body as never }),
  submitQuery: (id: string) => d4().post('/v1/catalog/{id}/submit', { path: { id } }),
  matrix: (ws: string, kind: MatrixKind, v: ViewParams = {}) =>
    d4().get('/v1/workspaces/{ws}/matrix/{kind}', { path: { ws, kind }, query: view(v) }),
  diff: (ws: string, from: ViewParams, to: ViewParams) =>
    d4().get('/v1/workspaces/{ws}/diff', {
      path: { ws },
      query: {
        fromAsOf: text(from.asOf),
        fromScenario: text(from.scenario),
        toAsOf: text(to.asOf),
        toScenario: text(to.scenario),
      },
    }),
};
