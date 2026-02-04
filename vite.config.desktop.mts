import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for Desktop (Tauri) build
 * Sets __BUILD_MODE__ to 'desktop'
 */
export default defineConfig({
  plugins: [svelte()],
  define: {
    __BUILD_MODE__: JSON.stringify('desktop'),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/desktop/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es',
      },
    },
    outDir: 'dist/desktop',
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/desktop': resolve(__dirname, 'src/desktop'),
    },
  },
  // Tauri expects a fixed port during dev
  server: {
    port: 5174,
    strictPort: true,
  },
});
