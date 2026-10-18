import { DomainError, LANE_KINDS, roadmapFromGraph } from '@d4/core';
import { resolveView, type GraphQueries } from '@d4/graph';
import type { MetamodelRegistry } from '@d4/metamodel';
import { graphSvg, PAPER, pageHtml, roadmapSvg, type Svg } from '@d4/render';
import { z } from 'zod';
import type { WorkspaceMeta } from './export';

export const RENDER_FORMATS = ['svg', 'png', 'pdf'] as const;
export type RenderFormat = (typeof RENDER_FORMATS)[number];

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const RenderParams = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('roadmap'),
    format: z.enum(RENDER_FORMATS),
    scope: z.array(z.string()).min(1).max(50),
    lanes: z.enum(LANE_KINDS).optional(),
    zoom: z.enum(['week', 'month', 'quarter']).optional(),
    paper: z.enum(['A4', 'A3', 'fit']).optional(),
    today: date.optional(),
  }),
  z.object({
    target: z.literal('graph'),
    format: z.enum(RENDER_FORMATS),
    root: z.string(),
    depth: z.number().int().min(1).max(3).optional(),
    paper: z.enum(['A4', 'A3', 'fit']).optional(),
    asOf: date.optional(),
    scenario: z.string().optional(),
  }),
]);
export type RenderParams = z.infer<typeof RenderParams>;

/** Turns a page into PNG or PDF bytes (headless Chromium in the renderer service). */
export type Rasterize = (html: string, opts: { format: 'png' | 'pdf'; width: number; height: number }) => Promise<Uint8Array>;

export interface RenderOutput {
  body: Uint8Array | string;
  contentType: string;
  filename: string;
  title: string;
}

type Queries = Pick<GraphQueries, 'getElement' | 'planningGraph' | 'neighbourhood'>;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'view';

/** The picture as SVG, from the same data the Roadmap page and the Explorer show. */
export async function renderSvg(queries: Queries, reg: MetamodelRegistry, ws: WorkspaceMeta & { id: string }, p: RenderParams): Promise<{ svg: Svg; title: string }> {
  if (p.target === 'roadmap') {
    const names = await Promise.all(p.scope.map(async (id) => String((await queries.getElement(ws.id, id))?.attrs['name'] ?? id)));
    const roadmap = roadmapFromGraph(await queries.planningGraph(ws.id, p.scope), { lanes: p.lanes, ...(p.today && { today: p.today }) });
    const title = `Roadmap: ${names.join(', ')}`;
    return { title, svg: roadmapSvg(roadmap, { title, subtitle: ws.name, zoom: p.zoom ?? 'quarter', ...(p.today && { today: p.today }) }) };
  }
  const view = await resolveView(queries, reg, ws.id, p);
  const sub = await queries.neighbourhood(ws.id, p.root, { depth: p.depth ?? 1, limit: 400, view });
  if (!sub) throw new DomainError('NOT_FOUND', `Element '${p.root}' not found`);
  const title = String(sub.root.attrs['name'] ?? sub.root.id);
  return { title, svg: graphSvg(sub, reg, { title, subtitle: ws.name, ...(p.asOf && { asOf: p.asOf }) }) };
}

/** SVG as is; PNG and PDF through `rasterize`. */
export async function renderPicture(svg: Svg, title: string, p: RenderParams, rasterize?: Rasterize): Promise<RenderOutput> {
  const base = `${slug(title)}${p.target === 'graph' && p.asOf ? `-${p.asOf}` : ''}`;
  if (p.format === 'svg') {
    return { body: `<?xml version="1.0" encoding="UTF-8"?>\n${svg.svg}\n`, contentType: 'image/svg+xml', filename: `${base}.svg`, title };
  }
  // Misrouted job (no Chromium here): retrying would not help.
  if (!rasterize) throw new DomainError('VALIDATION', 'PNG and PDF renders need the renderer service');
  const paper = p.paper ?? (p.format === 'pdf' ? 'A4' : 'fit');
  const fit = paper === 'fit' ? undefined : PAPER[paper];
  const size = fit ?? { width: Math.ceil(svg.width + 48), height: Math.ceil(svg.height + 48) };
  const body = await rasterize(pageHtml(svg, { title, ...(fit && { fit }) }), { format: p.format, ...size });
  return { body, contentType: p.format === 'pdf' ? 'application/pdf' : 'image/png', filename: `${base}.${p.format}`, title };
}
