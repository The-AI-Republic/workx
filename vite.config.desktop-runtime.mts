import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  define: {
    __BUILD_MODE__: JSON.stringify('server'),
  },
  build: {
    ssr: resolve(__dirname, 'src/desktop-runtime/index.ts'),
    outDir: resolve(__dirname, 'dist/desktop-runtime'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.mjs',
        format: 'esm',
      },
    },
    target: 'node22',
  },
  ssr: {
    external: ['better-sqlite3', 'fsevents', 'sqlite-vec'],
    noExternal: [/^@\//],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/server': resolve(__dirname, 'src/server'),
      '@/desktop': resolve(__dirname, 'src/desktop'),
      '@/desktop-runtime': resolve(__dirname, 'src/desktop-runtime'),
      '@applepi/ws-server': resolve(__dirname, 'packages/ws-server/src/index.ts'),
    },
  },
});
