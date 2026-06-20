import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { featureDefine } from './vite.featureFlags.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Separate build config for content script
// Must be IIFE format with all dependencies bundled inline
export default defineConfig({
  define: {
    __BUILD_MODE__: JSON.stringify('extension'),
    // Track 22 — same extension matrix as vite.config.mjs. Note this build
    // uses inlineDynamicImports:true, so OFF flags strip via DCE only.
    ...featureDefine('extension', process.env),
  },
  plugins: [
    svelte({
      compilerOptions: {
        // Dev mode for better debugging
        dev: false,
        // Generate smaller runtime code
        hydratable: false,
      },
      // Emit CSS separately
      emitCss: false,
      // Hot module replacement disabled for production
      hot: false,
    }),
  ],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/extension/content/content-script.ts'),
      name: 'WorkXContentScript',
      formats: ['iife'],
      fileName: () => 'content.js'
    },
    rollupOptions: {
      output: {
        extend: true,
        // Ensure no external dependencies - bundle everything
        inlineDynamicImports: true,
        sourcemap: true,  // NEW: Ensure Rollup generates source map
        sourcemapExcludeSources: false  // NEW: Include sources in map
      }
    },
    outDir: 'dist',
    emptyOutDir: false,  // Don't clear dist (main build runs first)
    sourcemap: true,  //
    minify: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
});
