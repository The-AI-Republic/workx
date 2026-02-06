import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for Chrome Extension build
 * Sets __BUILD_MODE__ to 'extension'
 */
export default defineConfig({
  plugins: [svelte()],
  envDir: resolve(__dirname, 'src/extension'), // Load .env from src/extension
  define: {
    __BUILD_MODE__: JSON.stringify('extension'),
  },
  build: {
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/extension/background/service-worker.ts'),
        sidepanel: resolve(__dirname, 'src/extension/sidepanel/sidepanel.html'),
        welcome: resolve(__dirname, 'src/welcome/welcome.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es',
      },
    },
    outDir: 'dist/extension',
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/extension': resolve(__dirname, 'src/extension'),
    },
  },
});
