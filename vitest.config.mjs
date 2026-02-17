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
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.config.ts',
        '**/*.config.mjs',
        '**/*.d.ts',
        'src/__test-utils__/**'
      ]
    },
    include: [
      'src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    mockReset: true,
    restoreMocks: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@config': resolve(__dirname, 'src/config'),
      '@storage': resolve(__dirname, 'src/storage'),
      '@models': resolve(__dirname, 'src/models'),
      '@core': resolve(__dirname, 'src/core'),
      '@tools': resolve(__dirname, 'src/tools'),
      '@protocol': resolve(__dirname, 'src/protocol'),
      '@types': resolve(__dirname, 'src/types')
    }
  }
});
