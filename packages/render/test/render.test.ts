import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseModelDocument, toImportInput } from '@d4/codecs';
import { InMemoryModelRepository } from '@d4/core/testing';
import { planImport, roadmapFromGraph, type Element, type ModelSnapshot, type PlanningGraph } from '@d4/core';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { graphSvg, NODE_SPACING, PAPER, pageHtml, radialLayout, roadmapSvg } from '../src';

const reg = new MetamodelRegistry(loadStarterMetamodel());
const SAMPLE = join(__dirname, '..', '..', '..', 'samples', 'ubs-banking.yaml');
let snapshot: ModelSnapshot;
let byKey: (k: string) => Element;

beforeAll(async () => {
  const repo = new InMemoryModelRepository();
  const plan = planImport(reg, { workspaceId: 'ws1', actor: 't' }, toImportInput(parseModelDocument(readFileSync(SAMPLE, 'utf8'))), { elements: [], relationships: [] });
  await repo.apply('ws1', plan.change!);
  snapshot = { elements: [...repo.elements.values()], relationships: [...repo.relationships.values()] };
  byKey = (k) => repo.elements.get(plan.keyToId[k]!)!;
});

/** Minimal XML well-formedness: balanced tags, quoted attributes, no raw "<" or "&" in text. */
function wellFormed(xml: string): boolean {
  const stack: string[] = [];
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>|([<&])/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[5] === '<') return false;
    if (m[5] === '&' && !/^&(amp|lt|gt|quot|apos|#\d+);/.test(body.slice(m.index, m.index + 7))) return false;
    if (m[5]) continue;
    if (m[4]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) return false;
    } else stack.push(m[2]!);
  }
  return stack.length === 0;
}

describe('roadmapSvg', () => {
  it('draws the sample plan with critical path, conflicts and planned outlines', () => {
    const initiative = byKey('init-client-data');
    const ids = new Set<string>();
    // The planning subgraph as GraphQueries.planningGraph would return it, built from the snapshot.
    for (const r of snapshot.relationships) if (r.type === 'CONTAINS' && r.fromId === initiative.id) ids.add(r.toId);
    for (const r of snapshot.relationships) if (r.type === 'PART_OF_MILESTONE' && ids.has(r.fromId)) ids.add(r.toId);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of snapshot.relationships) {
        if (r.type === 'DEPENDS_ON' && ids.has(r.fromId) && !ids.has(r.toId)) {
          ids.add(r.toId);
          grew = true;
        }
      }
    }
    const items = snapshot.elements.filter((e) => ids.has(e.id));
    const g: PlanningGraph = {
      items: items.map((element) => ({ element, kind: element.type === 'Milestone' ? 'milestone' : 'deliverable' })),
      relationships: snapshot.relationships.filter((r) => ids.has(r.fromId) || ids.has(r.toId)),
      related: snapshot.elements,
    };
    const svg = roadmapSvg(roadmapFromGraph(g), { title: 'Client Data & <MDM>', zoom: 'quarter', today: '2026-10-19' });
    expect(wellFormed(svg.svg)).toBe(true);
    expect(svg.svg).toContain('<title>Client Data &amp; &lt;MDM&gt;</title>');
    expect(svg.svg).toContain('Migrate client master to MDM Hub');
    expect(svg.svg.match(/stroke-dasharray="4 3"/g)?.length).toBeGreaterThanOrEqual(2); // planned outline + legend
    expect(svg.svg).toContain('fill="#da1e28"'); // critical path
    expect(svg.svg).toContain('>Today</text>');
    expect(svg.width).toBeGreaterThan(640);
  });
});

describe('radialLayout', () => {
  it('puts the root in the middle, rings by hop, and keeps nodes apart', () => {
    const root = byKey('dp-client');
    const near = snapshot.relationships.filter((r) => r.fromId === root.id || r.toId === root.id);
    const ids = [...new Set(near.flatMap((r) => [r.fromId, r.toId]))];
    const pos = radialLayout(root.id, ids, near);
    expect(pos.get(root.id)).toEqual({ x: 0, y: 0 });
    const radii = new Set(ids.filter((i) => i !== root.id).map((i) => Math.round(Math.hypot(pos.get(i)!.x, pos.get(i)!.y))));
    expect(radii.size).toBe(1);
    const pts = [...pos.values()];
    let min = Infinity;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) min = Math.min(min, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y));
    expect(min).toBeGreaterThanOrEqual(NODE_SPACING * 0.99);
    // Deterministic.
    expect(radialLayout(root.id, [...ids].reverse(), near)).toEqual(pos);
  });
});

describe('graphSvg', () => {
  it('renders a neighbourhood with layers, labels and dashed future edges', () => {
    const root = byKey('dp-client');
    const rels = snapshot.relationships.filter((r) => r.fromId === root.id || r.toId === root.id);
    const ids = new Set(rels.flatMap((r) => [r.fromId, r.toId]));
    const svg = graphSvg({ root, elements: snapshot.elements.filter((e) => ids.has(e.id) && e.id !== root.id), relationships: rels }, reg, {
      title: 'Client Master',
      asOf: '2027-01-01',
    });
    expect(wellFormed(svg.svg)).toBe(true);
    expect(svg.svg).toContain('HOLDS (MASTER)');
    // Legacy holds Client Master as MASTER, then REPLICA: one line, one combined label.
    expect(svg.svg).toContain('HOLDS (MASTER) · HOLDS (REPLICA)');
    expect(svg.svg).toContain('HOLDS (GOLDEN_COPY) · HOLDS (MASTER)');
    // A line is dashed only when every relationship on it starts after the view date.
    expect(svg.svg).not.toContain('stroke-dasharray="5 4"');
    const onlyFuture = rels.filter((r) => r.attrs['role'] !== 'GOLDEN_COPY');
    const future = graphSvg({ root, elements: snapshot.elements.filter((e) => ids.has(e.id) && e.id !== root.id), relationships: onlyFuture }, reg, {
      title: 'Client Master',
      asOf: '2027-01-01',
    });
    expect(future.svg.match(/stroke-dasharray="5 4"/g)).toHaveLength(1); // MDM becomes master on 2027-07-01
    expect(svg.svg).toContain('>Data</text>');
    expect(svg.svg).toContain(`${ids.size} elements · ${rels.length} relationships · as of 2027-01-01`);
  });
});

describe('pageHtml', () => {
  it('scales a large picture down to the paper, never up', () => {
    const big = { svg: '<svg width="3000" height="1000"></svg>', width: 3000, height: 1000 };
    expect(pageHtml(big, { title: 't', fit: PAPER.A4 })).toMatch(/width: 1075px; height: 358px/);
    const small = { svg: '<svg width="200" height="100"></svg>', width: 200, height: 100 };
    expect(pageHtml(small, { title: 't', fit: PAPER.A4 })).toMatch(/width: 200px; height: 100px/);
  });
});
