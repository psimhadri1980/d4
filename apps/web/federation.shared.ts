/**
 * Packages the shell and every remote share at run time: one copy each, so hooks, the router,
 * the query cache and the sign-in token store are the same object everywhere.
 */
export const shared = {
  react: { singleton: true, requiredVersion: '^18.3.1' },
  'react-dom': { singleton: true, requiredVersion: '^18.3.1' },
  'react-router-dom': { singleton: true },
  '@tanstack/react-query': { singleton: true },
  '@d4/web-platform': { singleton: true },
  '@d4/ui-kit': { singleton: true },
  '@d4/core': { singleton: true },
  '@d4/metamodel': { singleton: true },
};
