import { defineConfig } from 'vitest/config';

// Integration tests run against a shared Neo4j while other packages' suites run in parallel. The
// files here each import the sample in one transaction, so they run one at a time to stay well
// inside Neo4j's 30 s transaction timeout.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 120_000 } });
