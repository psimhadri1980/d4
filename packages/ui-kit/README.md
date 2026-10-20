# @d4/ui-kit

React components for D4 views, used by the D4 web app and embeddable in other apps:

- `Gantt`: roadmap Gantt (lanes, earliest dates, planned dates where they differ, milestones,
  dependencies, critical path, conflicts), keyboard accessible. Feed it a `RoadmapView` from
  `GET /v1/workspaces/{ws}/roadmap` (see `@d4/sdk`).
- `GraphCanvas`: relationship graph (Cytoscape) with radial, force and hierarchy layouts, nodes
  coloured by metamodel layer, future relationships dashed.
- `ResultTable`: a catalog query result with CSV download; `renderElementLink` turns element
  ids into your app's links.

```tsx
import '@d4/ui-kit/styles.css';
import { Gantt } from '@d4/ui-kit';

<Gantt roadmap={roadmap} zoom="month" selected={null} highlight={[]} onSelect={open} today="2027-01-15" />;
```

Peer dependencies: `react` 18 and `cytoscape` 3 (for `GraphCanvas`). The package is CommonJS;
bundlers such as Vite need it listed in `optimizeDeps.include`.

## Theming

Colours are CSS custom properties (`--layer-planning`, `--border-subtle`, `--text-primary`,
`--layer-<layer>` for graph nodes, …) with light-theme fallbacks. Define them to theme the
components; after changing them at runtime, dispatch `new Event(THEME_EVENT)` on `window` so open
graphs restyle.
