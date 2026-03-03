import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  define: {
    __BUILD_MODE__: JSON.stringify('extension'),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/__test-utils__/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/__test-utils__/**',
        'src/**/contracts/**',
        'src/**/__tests__/**',
        'src/**/welcome/**',
        'src/desktop/**',
        'src/extension/**',
        'src/tests/**',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ]
    },
    include: [
      'src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'packages/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      'tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    mockReset: true,
    restoreMocks: true
  },
  resolve: {
    alias: {
      // better-sqlite3 is a native addon not in node_modules (server-only dep).
      // Map to a stub so Vite's import analysis doesn't fail during tests.
      'better-sqlite3': resolve(__dirname, 'src/__test-utils__/better-sqlite3-stub.ts'),
      '@': resolve(__dirname, 'src'),
      '@config': resolve(__dirname, 'src/config'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@models': resolve(__dirname, 'src/models'),
      '@core': resolve(__dirname, 'src/core'),
      '@tools': resolve(__dirname, 'src/tools'),
      '@protocol': resolve(__dirname, 'src/protocol'),
      '@types': resolve(__dirname, 'src/types'),
      '@pi/ws-server': resolve(__dirname, 'packages/ws-server/src')
    }
  }
});
