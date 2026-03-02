import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for Server (headless) build.
 * Bundles src/server/index.ts into a single ESM file for Node.js.
 */
export default defineConfig({
  define: {
    __BUILD_MODE__: JSON.stringify('server'),
  },
  build: {
    ssr: resolve(__dirname, 'src/server/index.ts'),
    outDir: resolve(__dirname, 'dist/server'),
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
    // Keep native/binary modules external — don't bundle them
    external: ['better-sqlite3', 'fsevents'],
    noExternal: [
      // Force these into the bundle so path aliases resolve
      /^@\//,
    ],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/server': resolve(__dirname, 'src/server'),
      '@/desktop': resolve(__dirname, 'src/desktop'),
    },
  },
});
