import type { RoadmapView } from '@d4/core';

const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per item in schedule order, with planned and earliest dates, slack and conflicts. */
export function roadmapToCsv(r: RoadmapView): string {
  const names = new Map(r.items.map((i) => [i.id, i.name]));
  const conflicts = (id: string) => r.conflicts.filter((c) => c.itemIds[0] === id).map((c) => c.message).join('; ');
  const deps = (id: string) =>
    r.dependencies
      .filter((d) => d.from === id)
      .map((d) => names.get(d.to) ?? d.to)
      .join('; ');
  const header = ['id', 'name', 'kind', 'lane', 'status', 'plannedStart', 'plannedEnd', 'earliestStart', 'earliestEnd', 'durationDays', 'slackDays', 'critical', 'dependsOn', 'conflicts'];
  const rows = r.items.map((i) =>
    [i.id, i.name, i.kind, i.lane ?? '', i.status ?? '', i.start ?? '', i.end ?? '', i.earliestStart, i.earliestEnd, String(i.durationDays), String(i.slackDays), String(i.critical), deps(i.id), conflicts(i.id)].map(esc).join(','),
  );
  return [header.join(','), ...rows].join('\n');
}

/** Mermaid `gantt` source: sections per lane, `crit` on the critical path, milestones as points. */
export function roadmapToMermaid(r: RoadmapView, title = 'Roadmap'): string {
  const byId = new Map(r.items.map((i) => [i.id, i]));
  const tag = new Map(r.items.map((i, n) => [i.id, `t${n + 1}`]));
  // Mermaid treats ':' and '#' specially in task names.
  const label = (s: string) => s.replace(/[:#;]/g, ' ').replace(/\s+/g, ' ').trim();
  const lines = ['gantt', `  title ${label(title)}`, '  dateFormat YYYY-MM-DD', '  axisFormat %b %Y'];
  for (const lane of r.lanes) {
    lines.push(`  section ${label(lane.name)}`);
    for (const id of lane.itemIds) {
      const i = byId.get(id);
      if (!i) continue;
      const flags = [i.critical ? 'crit' : '', i.kind === 'milestone' ? 'milestone' : '', i.status === 'DONE' ? 'done' : i.status === 'IN_PROGRESS' ? 'active' : '']
        .filter(Boolean)
        .join(', ');
      const length = i.kind === 'milestone' ? '0d' : `${i.durationDays}d`;
      lines.push(`    ${label(i.name)} :${flags ? `${flags}, ` : ''}${tag.get(id)}, ${i.earliestStart}, ${length}`);
    }
  }
  return lines.join('\n');
}

export function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
