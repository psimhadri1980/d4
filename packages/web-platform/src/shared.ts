import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Packages the shell shares with lifecycle modules, as data for build configs
 * (`@d4/web-platform/shared`; not part of the browser bundle). The shell builds each as an entry
 * of its own and lists it in the page's import map; modules leave them external, so a bare
 * `import 'react'` in a module gets the shell's copy.
 */
export const SHARED = ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-router-dom', '@tanstack/react-query', '@d4/web-platform', '@d4/ui-kit'];

/** CommonJS packages: their named exports are listed for the ES module entry. */
export const COMMONJS = new Set(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']);

/** The package a shared specifier comes from (`react-dom/client` → `react-dom`). */
const packageOf = (spec: string) => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

/**
 * Major version of each shared package as installed for the project at `dir`, e.g.
 * `{ react: '18', … }`. A module records the majors it was built against in its manifest
 * (`shared`); the shell, built with its own, refuses a module whose majors differ.
 */
export function sharedMajors(dir: string): Record<string, string> {
  const req = createRequire(join(dir, 'package.json'));
  const out: Record<string, string> = {};
  for (const name of new Set(SHARED.map(packageOf))) {
    // Walk up from the entry: a package's `exports` may not expose its package.json.
    let at = dirname(req.resolve(name));
    for (;;) {
      const file = join(at, 'package.json');
      if (existsSync(file)) {
        const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === name && pkg.version) {
          out[name] = pkg.version.split('.')[0]!;
          break;
        }
      }
      if (dirname(at) === at) throw new Error(`No package.json for ${name} above ${dir}`);
      at = dirname(at);
    }
  }
  return out;
}
