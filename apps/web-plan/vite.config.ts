import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { SHARED, sharedMajors } from '@d4/web-platform/shared';

// The plan module as a lifecycle module: one ES module, plan.js, plus its
// lazy pages and stylesheet. Shared packages stay external; the shell's import map provides them.
export default defineConfig({
  base: './',
  plugins: [react()],
  // __D4_SHARED__: the shared majors this module is built against (its manifest's `shared`).
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __D4_SHARED__: JSON.stringify(sharedMajors(__dirname)) },
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: { entry: 'src/index.tsx', formats: ['es'], fileName: () => 'plan.js' },
    rollupOptions: { external: SHARED, output: { assetFileNames: (a) => (a.name?.endsWith('.css') ? 'plan.css' : 'assets/[name]-[hash][extname]'), chunkFileNames: 'assets/[name]-[hash].js' } },
  },
});
