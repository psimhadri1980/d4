import { defineConfig } from 'vitest/config';

// Every file creates and migrates its own Postgres database. Run the files one at a time, with
// room for a busy machine, so they do not time out while other packages' suites run alongside.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 30_000, hookTimeout: 120_000 } });
