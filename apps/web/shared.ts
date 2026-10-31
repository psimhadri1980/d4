/**
 * Packages the shell shares with lifecycle modules (P6 spike). The shell builds each as an entry
 * of its own and lists it in the page's import map; modules leave them external, so a bare
 * `import 'react'` in a module gets the shell's copy.
 */
export const SHARED = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom', '@tanstack/react-query', '@d4/web-platform', '@d4/ui-kit'];

/** CommonJS packages: their named exports are listed for the ES module entry. */
export const COMMONJS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']);
