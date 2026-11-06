import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CanvasTree, type TreeRow } from '@d4/render';
import type { GraphCanvasEdge, GraphCanvasNode } from './GraphCanvas';

const ROW_H = 36;
/** Rows drawn above and below the visible window, so fast scrolling shows no gaps. */
const OVERSCAN = 10;

interface Props {
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  rootIds: string[];
  selectedId: string | null;
  expandedIds: string[];
  onSelect?(id: string | null): void;
  onExpandedChange?(paths: string[]): void;
}

/**
 * The table view: the result as an indented tree (TV-1…TV-7). Only the rows in view are drawn
 * (TV-4); Expand all and Collapse all are in GraphCanvas's option bar. Keys follow the tree
 * pattern: Up/Down move, Right expands, Left collapses, Enter selects. The host owns the
 * selection and the open rows.
 */
export function GraphCanvasTable({ nodes, edges, rootIds, selectedId, expandedIds, onSelect, onExpandedChange }: Props) {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const tree = useMemo(() => new CanvasTree({ nodeIds: nodes.map((n) => n.id), edges, rootIds }), [nodes, edges, rootIds]);
  const expanded = useMemo(() => new Set(expandedIds), [expandedIds]);
  const rows = useMemo(() => tree.rows(expanded), [tree, expanded]);

  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(720);
  const [focused, setFocused] = useState<string | null>(null);
  // Move DOM focus only after a key press, never on first render.
  const moved = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 720));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const current = rows.find((r) => r.path === focused) ?? rows[0];
  const index = current ? rows.indexOf(current) : -1;

  useEffect(() => {
    if (!moved.current || !current) return;
    moved.current = false;
    const el = scroller.current;
    if (el) {
      const top = index * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
    el?.querySelector<HTMLElement>(`[data-path="${CSS.escape(current.path)}"]`)?.focus();
  });

  const toggle = (row: TreeRow) => {
    if (!row.childCount) return;
    onExpandedChange?.(row.expanded ? expandedIds.filter((p) => p !== row.path) : [...expandedIds, row.path]);
  };
  const focusRow = (row: TreeRow | undefined) => {
    if (!row) return;
    moved.current = true;
    setFocused(row.path);
  };
  const onKeyDown = (e: KeyboardEvent, row: TreeRow, i: number) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow(rows[i + 1]),
      ArrowUp: () => focusRow(rows[i - 1]),
      Home: () => focusRow(rows[0]),
      End: () => focusRow(rows.at(-1)),
      ArrowRight: () => (row.expanded ? focusRow(rows[i + 1]) : toggle(row)),
      ArrowLeft: () => (row.expanded ? toggle(row) : focusRow(rows.find((r) => r.path === row.parentPath))),
      Enter: () => onSelect?.(row.id),
      ' ': () => onSelect?.(row.id),
    };
    const run = keys[e.key];
    if (!run) return;
    e.preventDefault();
    run();
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const siblings = (row: TreeRow) => rows.filter((r) => r.parentPath === row.parentPath);

  return (
    <div className="graph-canvas-table">
      <div className="graph-canvas-table-scroll" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div role="tree" aria-label="Result as a tree" style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {rows.slice(first, last).map((row, k) => {
            const i = first + k;
            const n = byId.get(row.id)!;
            const sibs = siblings(row);
            return (
              <div
                key={row.path}
                role="treeitem"
                className={`graph-canvas-row${row.id === selectedId ? ' selected' : ''}`}
                style={{ top: i * ROW_H, height: ROW_H, paddingLeft: 8 + (row.level - 1) * 20 }}
                data-path={row.path}
                tabIndex={row === current ? 0 : -1}
                aria-level={row.level}
                aria-setsize={sibs.length}
                aria-posinset={sibs.indexOf(row) + 1}
                aria-expanded={row.childCount ? row.expanded : undefined}
                aria-selected={row.id === selectedId}
                onClick={() => {
                  setFocused(row.path);
                  onSelect?.(row.id);
                }}
                onKeyDown={(e) => onKeyDown(e, row, i)}
              >
                <span
                  className={`graph-canvas-chevron${row.childCount ? '' : ' none'}${row.expanded ? ' open' : ''}`}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(row);
                  }}
                >
                  <svg viewBox="0 0 16 16" width="16" height="16">
                    <path d="M6 4l4 4-4 4" />
                  </svg>
                </span>
                <span className="graph-canvas-row-name">{n.name}</span>
                {row.root && <span className="graph-canvas-tag">Root</span>}
                {row.repeat && <span className="graph-canvas-tag" title="Also shown on an earlier row">Repeat</span>}
                <span className="graph-canvas-row-meta">
                  {n.type} · {n.layer}
                </span>
                <span className="graph-canvas-row-count">
                  {row.childCount} {row.childCount === 1 ? 'dependent' : 'dependents'}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
