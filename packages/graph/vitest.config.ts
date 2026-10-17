import { defineConfig } from 'vitest/config';

// Integration tests run against a shared Neo4j while other suites run in parallel.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 120_000 } });
