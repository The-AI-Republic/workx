import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  envDir: resolve(__dirname, 'src/desktop'),
  define: {
    __BUILD_MODE__: JSON.stringify('server'),
  },
  build: {
    ssr: resolve(__dirname, 'src/desktop-runtime/index.ts'),
    outDir: resolve(__dirname, 'dist/desktop-runtime'),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: 'index.mjs',
        format: 'esm',
      },
    },
    target: 'node22',
  },
  ssr: {
    // Track 43 packaging: bundle EVERY pure-JS dep into the runtime so the
    // packaged sidecar can run from an isolated resource directory without
    // a full node_modules tree alongside it. Native addons (.node files)
    // and packages that ship platform-specific binaries stay external —
    // they're bundled separately by `scripts/build-desktop-runtime-sidecar.mjs`
    // alongside their minimal runtime closure (bindings, file-uri-to-path,
    // …). The default Vite SSR behavior — externalize everything in
    // package.json `dependencies` — would leave zod/MCP SDK/OpenAI SDK/etc.
    // as bare imports that the packaged sidecar cannot resolve.
    external: ['better-sqlite3', 'fsevents', 'sqlite-vec'],
    noExternal: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@/core': resolve(__dirname, 'src/core'),
      '@/server': resolve(__dirname, 'src/server'),
      '@/desktop': resolve(__dirname, 'src/desktop'),
      '@/desktop-runtime': resolve(__dirname, 'src/desktop-runtime'),
      '@applepi/ws-server': resolve(__dirname, 'packages/ws-server/src/index.ts'),
    },
  },
});
