import { defineConfig, mergeConfig } from 'vitest/config';
import vite from './vite.config';

// The module's build settings (its `define`s) plus a browser-like test environment.
export default mergeConfig(vite, defineConfig({ test: { environment: 'jsdom' } }));
