import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
// @ts-ignore - plain .mjs data module, no types (dependency-free by design)
import { featureDefine } from './vite.featureFlags.mjs';
// @ts-ignore - plain .mjs data module, no types (dependency-free by design)
import { versionDefine } from './vite.version.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Vite config for Desktop (Tauri) build
 * Sets __BUILD_MODE__ to 'desktop'
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
  root: 'src/desktop',
  envDir: resolve(__dirname, 'src/desktop'), // Load .env from src/desktop
  define: {
    __BUILD_MODE__: JSON.stringify('desktop'),
    ...versionDefine(),
    // Track 22 — desktop matrix (heavier subsystems default ON here).
    ...featureDefine('desktop', process.env),
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
    outDir: resolve(__dirname, 'dist/desktop'),
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
