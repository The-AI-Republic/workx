import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Main build config - excludes content script (built separately with vite.config.content.mjs)
export default defineConfig({
  plugins: [svelte()],
  define: {
    __BUILD_MODE__: JSON.stringify('extension'),
  },
  build: {
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/extension/background/service-worker.ts'),
        sidepanel: resolve(__dirname, 'src/extension/sidepanel/sidepanel.html'),
        welcome: resolve(__dirname, 'src/welcome/welcome.html')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es'
      }
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
});
