import type { RoadmapView } from '@d4/core';
import { AXIS, ganttGeometry, LABEL_W, LANE_HEAD, ROW, type GanttZoom } from './gantt-geometry';
import { COLORS, esc, frame, num, truncate, type Svg } from './svg';

const HEADER = 56;
const LEGEND = 28;

/**
 * A roadmap as a self-contained SVG: title, lanes, bars at the earliest feasible dates, dashed
 * outlines where the plan differs, milestones, dependency arrows, critical path, today, legend.
 */
export function roadmapSvg(r: RoadmapView, opts: { title: string; subtitle?: string; zoom?: GanttZoom; today?: string }): Svg {
  const g = ganttGeometry(r, opts.zoom ?? 'month');
  const byId = new Map(r.items.map((i) => [i.id, i]));
  const critical = new Set(r.criticalPath);
  const conflicted = new Set(r.conflicts.flatMap((c) => c.itemIds.slice(0, 1)));
  const top = HEADER;
  const b: string[] = [];
  const y = (v: number) => v + top;

  b.push(`<text x="16" y="26" font-size="18" font-weight="600" fill="${COLORS.text}">${esc(opts.title)}</text>`);
  const sub = [opts.subtitle, r.start && r.end ? `${r.start} → ${r.end}` : '', `${r.items.length} items`, `${r.conflicts.length} conflicts`].filter(Boolean).join(' · ');
  b.push(`<text x="16" y="44" fill="${COLORS.textSecondary}">${esc(sub)}</text>`);
  b.push(`<defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${COLORS.edge}"/></marker></defs>`);

  b.push(`<rect x="0" y="${top}" width="${num(g.width)}" height="${AXIS}" fill="${COLORS.layer02}"/>`);
  for (const m of g.months) {
    b.push(`<line x1="${num(m.x)}" x2="${num(m.x)}" y1="${y(AXIS - 10)}" y2="${y(g.height)}" stroke="${m.quarterStart ? COLORS.borderStrong : COLORS.border}" stroke-opacity="${m.quarterStart ? 0.6 : 1}"/>`);
    if (m.label) b.push(`<text x="${num(m.x + 4)}" y="${y(AXIS - 14)}" fill="${COLORS.textSecondary}">${esc(m.label)}</text>`);
  }
  for (const row of g.rows) {
    if (row.kind === 'lane') {
      b.push(`<rect x="0" y="${y(row.y)}" width="${num(g.width)}" height="${LANE_HEAD}" fill="${COLORS.layer02}"/>`);
      b.push(`<text x="12" y="${y(row.y + 18)}" font-weight="600" fill="${COLORS.textSecondary}">${esc(row.lane)}</text>`);
    }
  }
  if (opts.today) {
    const tx = g.x(opts.today);
    if (tx > LABEL_W && tx < g.width) {
      b.push(`<line x1="${num(tx)}" x2="${num(tx)}" y1="${y(AXIS)}" y2="${y(g.height)}" stroke="${COLORS.interactive}" stroke-dasharray="3 3"/>`);
      b.push(`<text x="${num(tx + 4)}" y="${y(AXIS + 12)}" font-size="11" fill="${COLORS.interactive}">Today</text>`);
    }
  }
  for (const d of r.dependencies) {
    const a = byId.get(d.to);
    const z = byId.get(d.from);
    if (!a || !z) continue;
    const ba = g.bar(a);
    const bz = g.bar(z);
    const startOfA = d.type === 'START_START' || d.type === 'START_FINISH';
    const endOfZ = d.type === 'FINISH_FINISH' || d.type === 'START_FINISH';
    const x1 = startOfA ? ba.x : ba.x + ba.w;
    const x2 = endOfZ ? bz.x + bz.w : bz.x;
    const crit = critical.has(d.from) && critical.has(d.to);
    b.push(
      `<path d="M${num(x1)},${y(ba.y + ROW / 2)} H${num(x1 + 8)} V${y(bz.y + ROW / 2)} H${num(x2)}" fill="none" stroke="${crit ? COLORS.error : COLORS.edge}" stroke-width="1.2" marker-end="url(#arrow)"/>`,
    );
  }
  for (const row of g.rows) {
    const i = row.item;
    if (!i) continue;
    const bx = g.bar(i);
    const isCrit = critical.has(i.id);
    if (conflicted.has(i.id)) b.push(`<text x="8" y="${y(bx.y + 20)}" font-weight="700" fill="${COLORS.error}">!</text>`);
    b.push(`<text x="24" y="${y(bx.y + 20)}" fill="${COLORS.text}">${esc(truncate(i.name, 36))}</text>`);
    if (bx.px !== undefined) {
      b.push(`<rect x="${num(bx.px)}" y="${y(bx.y + 7)}" width="${num(bx.pw!)}" height="${ROW - 14}" rx="2" fill="none" stroke="${COLORS.borderStrong}" stroke-dasharray="4 3"/>`);
    }
    if (i.kind === 'milestone') {
      b.push(`<path d="M${num(bx.x)},${y(bx.y + 6)} l10,10 l-10,10 l-10,-10 z" fill="${isCrit ? COLORS.error : COLORS.text}"/>`);
    } else {
      const done = i.status === 'DONE' ? ' fill-opacity="0.45"' : '';
      b.push(`<rect x="${num(bx.x)}" y="${y(bx.y + 8)}" width="${num(bx.w)}" height="${ROW - 16}" rx="2" fill="${isCrit ? COLORS.error : COLORS.planning}"${done}/>`);
    }
  }
  const ly = top + g.height + 18;
  const legend: [string, string][] = [
    [`<rect x="0" y="-9" width="20" height="10" rx="2" fill="${COLORS.planning}"/>`, 'Scheduled'],
    [`<rect x="0" y="-9" width="20" height="10" rx="2" fill="none" stroke="${COLORS.borderStrong}" stroke-dasharray="4 3"/>`, 'Planned (differs)'],
    [`<rect x="0" y="-9" width="20" height="10" rx="2" fill="${COLORS.error}"/>`, 'Critical path'],
    [`<path d="M10,-10 l6,6 l-6,6 l-6,-6 z" fill="${COLORS.text}"/>`, 'Milestone'],
  ];
  legend.forEach(([shape, label], n) => {
    b.push(`<g transform="translate(${16 + n * 150},${ly})">${shape}<text x="28" y="0" fill="${COLORS.textSecondary}">${label}</text></g>`);
  });
  return frame(Math.max(g.width, 640), top + g.height + LEGEND, b, opts.title);
}
