import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore - plain .mjs data module, no types (dependency-free by design)
import { versionDefine } from './vite.version.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for Web UI build (server mode).
 * Builds the webfront SPA to be served by the server's HTTP handler.
 */
export default defineConfig({
  plugins: [
    svelte({
      preprocess: sveltePreprocess({
        typescript: {
          tsconfigFile: resolve(__dirname, 'tsconfig.json'),
        },
      }),
      configFile: resolve(__dirname, 'svelte.config.mjs'),
    }),
  ],
  base: './',
  root: 'src/webfront',
  define: {
    __BUILD_MODE__: JSON.stringify('web'),
    ...versionDefine(),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/webfront/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        format: 'es',
      },
    },
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
    minify: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
    },
  },
});
