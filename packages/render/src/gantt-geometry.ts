import type { RoadmapView, ScheduledItem } from '@d4/core';

/**
 * Gantt layout shared by the interactive chart (web) and static renders: rows per lane, an x scale
 * padded to whole months, and bar boxes. Pure, so it runs in the browser and in Node.
 */
export type GanttZoom = 'week' | 'month' | 'quarter';
const PX_PER_DAY: Record<GanttZoom, number> = { week: 12, month: 4, quarter: 1.6 };
export const ROW = 32;
export const LANE_HEAD = 28;
export const AXIS = 40;
export const LABEL_W = 280;
const DAY = 86_400_000;

const toDay = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
const fromDay = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const monthStart = (n: number) => toDay(`${fromDay(n).slice(0, 7)}-01`);
const nextMonth = (n: number) => {
  const d = new Date(n * DAY);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY);
};

export interface GanttRow {
  kind: 'lane' | 'item';
  y: number;
  lane: string;
  item?: ScheduledItem;
}

export interface GanttGeometry {
  rows: GanttRow[];
  height: number;
  width: number;
  /** Day number of the left edge (first of a month). */
  origin: number;
  pxPerDay: number;
  x: (date: string) => number;
  months: { x: number; label: string; quarterStart: boolean }[];
  /** Bar box for an item: earliest dates, plus planned dates when they differ. */
  bar: (i: ScheduledItem) => { x: number; w: number; px?: number; pw?: number; y: number };
}

/** Pure layout: rows per lane, x scale padded to whole months. */
export function ganttGeometry(r: RoadmapView, zoom: GanttZoom): GanttGeometry {
  const pxPerDay = PX_PER_DAY[zoom];
  const days = r.items.flatMap((i) => [i.earliestStart, i.earliestEnd, i.start, i.end]).filter((d): d is string => !!d).map(toDay);
  const lo = days.length ? monthStart(Math.min(...days)) : monthStart(toDay(new Date().toISOString().slice(0, 10)));
  const hi = days.length ? nextMonth(Math.max(...days)) : nextMonth(lo);
  const x = (date: string) => LABEL_W + (toDay(date) - lo) * pxPerDay;

  const byId = new Map(r.items.map((i) => [i.id, i]));
  const rows: GanttRow[] = [];
  let y = AXIS;
  for (const lane of r.lanes) {
    rows.push({ kind: 'lane', y, lane: lane.name });
    y += LANE_HEAD;
    for (const id of lane.itemIds) {
      const item = byId.get(id);
      if (!item) continue;
      rows.push({ kind: 'item', y, lane: lane.name, item });
      y += ROW;
    }
  }
  const rowY = new Map(rows.filter((r) => r.item).map((r) => [r.item!.id, r.y]));

  const months: GanttGeometry['months'] = [];
  for (let m = lo; m < hi; m = nextMonth(m)) {
    const d = fromDay(m);
    const month = Number(d.slice(5, 7));
    months.push({
      x: LABEL_W + (m - lo) * pxPerDay,
      label: zoom === 'quarter' ? (month % 3 === 1 ? `Q${(month + 2) / 3} ${d.slice(0, 4)}` : '') : new Date(m * DAY).toLocaleString('en', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      quarterStart: month % 3 === 1,
    });
  }

  const bar = (i: ScheduledItem) => {
    const xs = x(i.earliestStart);
    const w = i.kind === 'milestone' ? 0 : Math.max(2, i.durationDays * pxPerDay);
    const shifted = i.kind === 'deliverable' && !!i.start && !!i.end && i.start !== i.earliestStart;
    return {
      x: xs,
      w,
      y: rowY.get(i.id) ?? 0,
      ...(shifted && { px: x(i.start!), pw: Math.max(2, (toDay(i.end!) - toDay(i.start!) + 1) * pxPerDay) }),
    };
  };

  return { rows, height: y + 8, width: LABEL_W + (hi - lo) * pxPerDay + 16, origin: lo, pxPerDay, x, months, bar };
}

