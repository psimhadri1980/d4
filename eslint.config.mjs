import tseslint from 'typescript-eslint';

// Repository boundaries (D69, docs/REPO_SPLIT_PLAN.md): web and backend meet only through the SDK
// and the shared domain packages, which in turn depend on nothing else.
const DOMAIN = ['core', 'metamodel', 'codecs', 'render'];
const WEB = ['web-platform', 'ui-kit'];
const BACKEND = ['config', 'connectors', 'cypher', 'db', 'graph', 'infra', 'jobs', 'runtime', 'cli'];
const banned = (names, message) => ({ group: names.flatMap((n) => [`@d4/${n}`, `@d4/${n}/*`]), message });
const webSide = banned(BACKEND, 'Web code may use only @d4/sdk, the domain packages, @d4/web-platform and @d4/ui-kit (D69).');
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    // Tests poke at loosely-typed JSON responses.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    // Web module boundaries: a module imports @d4/web-platform, @d4/ui-kit, domain packages and
    // its own files, never another module or the shell. Shared code moves into those packages.
    // Web code never imports backend packages.
    files: ['apps/web/**', 'apps/web-*/**', 'packages/ui-kit/**'],
    rules: restrict(webSide),
  },
  {
    // The platform sits below the UI kit and the modules.
    files: ['packages/web-platform/**'],
    rules: restrict(webSide, banned(['ui-kit'], '@d4/web-platform may not depend on @d4/ui-kit.')),
  },
  {
    // Backend code never imports web packages.
    files: ['apps/api/**', 'apps/worker/**', 'apps/renderer/**', 'apps/ops/**', ...BACKEND.map((n) => `packages/${n}/**`)],
    rules: restrict(banned(WEB, 'Backend code may not import web packages (D69).')),
  },
  {
    // The shared domain packages and the SDK are published to both sides, so they import only each other.
    files: [...DOMAIN, 'sdk'].map((n) => `packages/${n}/**`),
    rules: restrict(banned([...WEB, ...BACKEND], 'Domain packages and the SDK may import only each other (D69).')),
  },
);
