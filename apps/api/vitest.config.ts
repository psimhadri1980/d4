import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so Nest's decorator metadata is emitted under Vitest. End-to-end tests hit real
// Postgres and Neo4j while other suites run in parallel, so they get generous timeouts.
export default defineConfig({
  plugins: [swc.vite()],
  // Request logs only for problems; LOG_LEVEL=info shows every request.
  test: { testTimeout: 30_000, hookTimeout: 120_000, env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' } },
});
