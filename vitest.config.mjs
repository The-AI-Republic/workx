import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: [],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.config.ts',
        '**/*.d.ts',
        'tests/**'
      ]
    },
    include: [
      'open_source/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'open_source/src/tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'open_source/src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    mockReset: true,
    restoreMocks: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'open_source/src'),
      '@config': resolve(__dirname, 'open_source/src/config'),
      '@storage': resolve(__dirname, 'open_source/src/storage'),
      '@models': resolve(__dirname, 'open_source/src/models'),
      '@core': resolve(__dirname, 'open_source/src/core'),
      '@tools': resolve(__dirname, 'open_source/src/tools'),
      '@protocol': resolve(__dirname, 'open_source/src/protocol'),
      '@types': resolve(__dirname, 'open_source/src/types')
    }
  }
});