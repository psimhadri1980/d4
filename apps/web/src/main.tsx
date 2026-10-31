import '@fontsource/source-sans-3/300.css';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@d4/ui-kit/styles.css';
// Same order as the old single stylesheet: tokens and element defaults, shell, then controls.
import '@d4/ui-kit/base.css';
import './shell.css';
import '@d4/ui-kit/app.css';
// Screen styles, in the order they had in the single stylesheet.
import './modules/explore/explore.css';
import './modules/queries/queries.css';
import './modules/plan/plan.css';
import './modules/data/data.css';
import './modules/reporting/reporting.css';
import './modules/admin/admin.css';
import { applyTheme, storedTheme, watchSystemTheme } from './theme';
import { loadRuntimeConfig } from '@d4/web-platform';

applyTheme(storedTheme());
watchSystemTheme();

const root = document.getElementById('root')!;
// The app (and its sign-in client) is imported only once the runtime settings are known.
loadRuntimeConfig()
  .then(() => import('./root'))
  .then(({ renderApp }) => renderApp(root))
  .catch((e: unknown) => {
    console.error('D4 could not start', e);
    root.innerHTML = '<div class="splash" role="alert"></div>';
    root.firstElementChild!.textContent = `D4 could not start: ${e instanceof Error ? e.message : String(e)}`;
  });
