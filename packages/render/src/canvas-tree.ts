/**
 * The GraphCanvas table view as an indented tree (TV-1, TV-6): each root is a top-level row and a
 * node's children are its neighbours one hop further from that root, in either direction. A node
 * reached by two paths appears under each parent; every appearance after the first is a repeat.
 * Hops only grow down the tree, so cycles end by themselves. Rows are built only under expanded
 * paths, so a dense graph never turns into millions of rows.
 */

export interface TreeRow {
  /** Ids from the root down, joined by `/` (r1/iv/kyc): the row's identity in `expandedIds`. */
  path: string;
  id: string;
  /** 1 for roots. */
  level: number;
  /** Number of dependents: rows one level in. */
  childCount: number;
  expanded: boolean;
  /** The node already appeared on an earlier row. */
  repeat: boolean;
  root: boolean;
  parentPath: string | null;
}

export interface TreeInput {
  /** In display order (the host sorts, e.g. by name). */
  nodeIds: readonly string[];
  edges: readonly { from: string; to: string }[];
  rootIds: readonly string[];
}

/** Paths Expand all opens at most; beyond that, deeper rows stay closed. */
export const MAX_EXPANDED_PATHS = 5000;

export class CanvasTree {
  private readonly next = new Map<string, string[]>();
  private readonly order = new Map<string, number>();
  private readonly hopsFrom = new Map<string, Map<string, number>>();
  private readonly roots: string[];

  constructor({ nodeIds, edges, rootIds }: TreeInput) {
    nodeIds.forEach((id, i) => this.order.set(id, i));
    for (const e of edges) {
      if (!this.order.has(e.from) || !this.order.has(e.to) || e.from === e.to) continue;
      this.link(e.from, e.to);
      this.link(e.to, e.from);
    }
    this.roots = rootIds.filter((r) => this.order.has(r));
  }

  /** The visible rows: roots, and below every expanded path its children. */
  rows(expanded: ReadonlySet<string>): TreeRow[] {
    const out: TreeRow[] = [];
    const seen = new Set<string>();
    const rootSet = new Set(this.roots);
    const walk = (root: string, id: string, path: string, level: number, parentPath: string | null) => {
      const kids = this.children(root, id, level);
      const open = expanded.has(path) && kids.length > 0;
      out.push({ path, id, level, childCount: kids.length, expanded: open, repeat: level > 1 && seen.has(id), root: rootSet.has(id), parentPath });
      seen.add(id);
      if (open) for (const k of kids) walk(root, k, `${path}/${k}`, level + 1, path);
    };
    for (const r of this.roots) walk(r, r, r, 1, null);
    return out;
  }

  /** Every path that has children, breadth first, up to MAX_EXPANDED_PATHS (Expand all). */
  allExpandable(): string[] {
    const out: string[] = [];
    const queue: { root: string; id: string; path: string; level: number }[] = this.roots.map((r) => ({ root: r, id: r, path: r, level: 1 }));
    for (let cur = queue.shift(); cur && out.length < MAX_EXPANDED_PATHS; cur = queue.shift()) {
      const kids = this.children(cur.root, cur.id, cur.level);
      if (!kids.length) continue;
      out.push(cur.path);
      for (const k of kids) queue.push({ root: cur.root, id: k, path: `${cur.path}/${k}`, level: cur.level + 1 });
    }
    return out;
  }

  private children(root: string, id: string, level: number): string[] {
    const hops = this.hops(root);
    return (this.next.get(id) ?? []).filter((n) => hops.get(n) === level).sort((a, b) => this.order.get(a)! - this.order.get(b)!);
  }

  /** Hops from one root (memoised); the root is at 0, so a node at hop h sits on level h + 1. */
  private hops(root: string): Map<string, number> {
    let dist = this.hopsFrom.get(root);
    if (dist) return dist;
    dist = new Map([[root, 0]]);
    const queue = [root];
    for (let cur = queue.shift(); cur !== undefined; cur = queue.shift()) {
      for (const n of this.next.get(cur) ?? []) {
        if (!dist.has(n)) {
          dist.set(n, dist.get(cur)! + 1);
          queue.push(n);
        }
      }
    }
    this.hopsFrom.set(root, dist);
    return dist;
  }

  private link(a: string, b: string) {
    const list = this.next.get(a);
    if (!list) this.next.set(a, [b]);
    else if (!list.includes(b)) list.push(b);
  }
}
