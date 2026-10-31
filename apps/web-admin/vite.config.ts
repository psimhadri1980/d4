import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { SHARED } from '../web/shared';

// The admin module as a lifecycle module (P6 spike): one ES module, /mfe/admin/admin.js, plus its
// lazy pages and stylesheet. Shared packages stay external; the shell's import map provides them.
export default defineConfig({
  base: '/mfe/admin/',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: { entry: 'src/admin.tsx', formats: ['es'], fileName: () => 'admin.js' },
    rollupOptions: { external: SHARED, output: { assetFileNames: (a) => (a.name?.endsWith('.css') ? 'admin.css' : 'assets/[name]-[hash][extname]'), chunkFileNames: 'assets/[name]-[hash].js' } },
  },
});
