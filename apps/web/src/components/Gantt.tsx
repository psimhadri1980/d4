import type { RoadmapView } from '@d4/core';
import { AXIS, ganttGeometry, LABEL_W, LANE_HEAD, ROW, type GanttZoom } from '@d4/render';

export { ganttGeometry, type GanttZoom };

/**
 * Gantt chart as SVG: lanes, bars at the earliest feasible dates, a dashed outline where the plan
 * says otherwise, milestones as diamonds, dependency arrows and the critical path highlighted.
 * Colours come from theme tokens via CSS classes.
 */
export function Gantt({
  roadmap,
  zoom,
  selected,
  highlight,
  onSelect,
  today,
}: {
  roadmap: RoadmapView;
  zoom: GanttZoom;
  selected: string | null;
  highlight: string[];
  onSelect(id: string): void;
  today: string;
}) {
  const g = ganttGeometry(roadmap, zoom);
  const byId = new Map(roadmap.items.map((i) => [i.id, i]));
  const conflicted = new Set(roadmap.conflicts.flatMap((c) => c.itemIds.slice(0, 1)));
  const critical = new Set(roadmap.criticalPath);
  const lit = new Set(highlight);
  const todayX = g.x(today);

  const arrow = (from: string, to: string, type: string) => {
    const a = byId.get(to);
    const b = byId.get(from);
    if (!a || !b) return null;
    const ba = g.bar(a);
    const bb = g.bar(b);
    const startOfA = type === 'START_START' || type === 'START_FINISH';
    const endOfB = type === 'FINISH_FINISH' || type === 'START_FINISH';
    const x1 = startOfA ? ba.x : ba.x + ba.w;
    const y1 = ba.y + ROW / 2;
    const x2 = endOfB ? bb.x + bb.w : bb.x;
    const y2 = bb.y + ROW / 2;
    const elbow = x1 + 8;
    return `M${x1},${y1} H${elbow} V${y2} H${x2}`;
  };

  return (
    <div className="gantt-scroll">
      <svg className="gantt" width={g.width} height={g.height} role="img" aria-label={`Gantt chart with ${roadmap.items.length} items`}>
        <defs>
          <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" className="gantt-arrowhead" />
          </marker>
        </defs>

        {/* time axis */}
        <rect x={0} y={0} width={g.width} height={AXIS} className="gantt-axis-bg" />
        {g.months.map((m) => (
          <g key={m.x}>
            <line x1={m.x} x2={m.x} y1={AXIS - 10} y2={g.height} className={m.quarterStart ? 'gantt-grid strong' : 'gantt-grid'} />
            {m.label && (
              <text x={m.x + 4} y={AXIS - 14} className="gantt-axis-label">
                {m.label}
              </text>
            )}
          </g>
        ))}

        {/* lanes and rows */}
        {g.rows.map((row) =>
          row.kind === 'lane' ? (
            <g key={`lane:${row.lane}`}>
              <rect x={0} y={row.y} width={g.width} height={LANE_HEAD} className="gantt-lane" />
              <text x={12} y={row.y + 18} className="gantt-lane-label">
                {row.lane}
              </text>
            </g>
          ) : (
            <rect key={`row:${row.item!.id}`} x={0} y={row.y} width={g.width} height={ROW} className={`gantt-row ${row.item!.id === selected ? 'selected' : ''}`} />
          ),
        )}

        {todayX > LABEL_W && todayX < g.width && (
          <g>
            <line x1={todayX} x2={todayX} y1={AXIS} y2={g.height} className="gantt-today" />
            <text x={todayX + 4} y={AXIS + 12} className="gantt-today-label">
              Today
            </text>
          </g>
        )}

        {/* dependencies */}
        {roadmap.dependencies.map((d) => {
          const path = arrow(d.from, d.to, d.type ?? 'FINISH_START');
          if (!path) return null;
          const crit = critical.has(d.from) && critical.has(d.to);
          return <path key={`${d.from}>${d.to}`} d={path} className={`gantt-dep ${crit ? 'critical' : ''}`} markerEnd="url(#gantt-arrow)" />;
        })}

        {/* items */}
        {g.rows
          .filter((r) => r.item)
          .map(({ item: i }) => {
            const b = g.bar(i!);
            const cls = [
              'gantt-item',
              i!.critical && critical.has(i!.id) ? 'critical' : '',
              conflicted.has(i!.id) ? 'conflict' : '',
              i!.id === selected ? 'selected' : '',
              lit.has(i!.id) ? 'lit' : '',
              `st-${(i!.status ?? 'NOT_STARTED').toLowerCase()}`,
            ]
              .filter(Boolean)
              .join(' ');
            const dates = i!.kind === 'milestone' ? i!.earliestStart : `${i!.earliestStart} to ${i!.earliestEnd}`;
            return (
              <g
                key={i!.id}
                className={cls}
                role="button"
                tabIndex={0}
                aria-pressed={i!.id === selected}
                aria-label={`${i!.name}, ${dates}${i!.critical ? ', critical' : ''}${conflicted.has(i!.id) ? ', has conflicts' : ''}`}
                onClick={() => onSelect(i!.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(i!.id);
                  }
                }}
              >
                <rect x={0} y={b.y} width={LABEL_W} height={ROW} className="gantt-hit" />
                <text x={24} y={b.y + 20} className="gantt-label">
                  {truncate(i!.name, 34)}
                </text>
                {conflicted.has(i!.id) && (
                  <text x={8} y={b.y + 20} className="gantt-warn" aria-hidden>
                    !
                  </text>
                )}
                {b.px !== undefined && <rect x={b.px} y={b.y + 7} width={b.pw} height={ROW - 14} rx={2} className="gantt-planned" />}
                {i!.kind === 'milestone' ? (
                  <path d={`M${b.x},${b.y + 6} l10,10 l-10,10 l-10,-10 z`} className="gantt-milestone" />
                ) : (
                  <rect x={b.x} y={b.y + 8} width={b.w} height={ROW - 16} rx={2} className="gantt-bar" />
                )}
                <title>
                  {`${i!.name}\n${dates}${i!.start && i!.start !== i!.earliestStart ? `\nplanned ${i!.start}${i!.end ? ` to ${i!.end}` : ''}` : ''}\nslack ${i!.slackDays} days`}
                </title>
              </g>
            );
          })}
      </svg>
    </div>
  );
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
