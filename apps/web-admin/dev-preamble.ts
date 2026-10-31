// React Refresh preamble for `vite` dev mode. A Vite-served page installs it from index.html,
// but this remote runs inside the shell, which may be a production build. Imported first by the
// exposed module in dev only (vite.config.ts).
// @ts-expect-error -- served by this remote's dev server, not a package
import RefreshRuntime from '/mfe/admin/@react-refresh';

const w = window as unknown as Record<string, unknown>;
if (!w.__vite_plugin_react_preamble_installed__) {
  RefreshRuntime.injectIntoGlobalHook(window);
  w.$RefreshReg$ = () => {};
  w.$RefreshSig$ = () => (type: unknown) => type;
  w.__vite_plugin_react_preamble_installed__ = true;
}
