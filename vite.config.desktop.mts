import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import sveltePreprocess from 'svelte-preprocess';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

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
  root: 'src/desktop',
  envDir: resolve(__dirname, 'src/desktop'), // Load .env from src/desktop
  define: {
    __BUILD_MODE__: JSON.stringify('desktop'),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/desktop/index.html'),
      },
      external: [
        // Tauri v2 API packages
        '@tauri-apps/api/core',
        '@tauri-apps/api/window',
        '@tauri-apps/api/event',
        '@tauri-apps/api/path',
        '@tauri-apps/plugin-global-shortcut',
        '@tauri-apps/plugin-notification',
        '@tauri-apps/plugin-shell',
      ],
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
