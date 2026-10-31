import tseslint from 'typescript-eslint';

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
    files: ['apps/web/src/modules/*/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['../*', '../**'], message: 'A web module may not import another module or the shell; move shared code to @d4/web-platform or @d4/ui-kit.' }] },
      ],
    },
  },
  {
    // The platform sits below the UI kit and the modules.
    files: ['packages/web-platform/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['@d4/ui-kit', '@d4/ui-kit/*'], message: '@d4/web-platform may not depend on @d4/ui-kit.' }] }] },
  },
);
