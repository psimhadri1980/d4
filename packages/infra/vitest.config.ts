import { defineConfig } from 'vitest/config';

// Most suites here hit real Postgres and Neo4j. Run the files one after another, so heavy suites
// (sample import, backup and restore) never compete for the same Neo4j, and give them time:
// other packages' suites still run alongside.
export default defineConfig({
  test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 120_000 },
});
