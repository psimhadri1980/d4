import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so Nest's decorator metadata is emitted under Vitest.
export default defineConfig({ plugins: [swc.vite()] });
