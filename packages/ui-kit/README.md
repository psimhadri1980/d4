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

The D4 web app's shared building blocks live here too: `ElementList`, `ElementDetails`,
`AttributeField`, `ParamForm`, `ViewBar`, `ExportMenu`, `ScheduleForm`, `ErrorBanner`, the model
helpers and the job texts. They call the API through `@d4/web-platform`. `base.css` holds the D4
design tokens and element defaults, `app.css` the controls and these components' styles; load
them (in that order) before any screen's styles.

Peer dependencies: `react` 18, `cytoscape` 3 (for `GraphCanvas`), and for the app components
`react-router-dom` and `@tanstack/react-query`. Bundlers get an ESM build (`browser` condition);
Node gets CommonJS.

## Theming

Colours are CSS custom properties (`--layer-planning`, `--border-subtle`, `--text-primary`,
`--layer-<layer>` for graph nodes, …) with light-theme fallbacks. Define them to theme the
components; after changing them at runtime, dispatch `new Event(THEME_EVENT)` on `window` so open
graphs restyle.
