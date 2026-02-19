import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Custom plugin to strip Vite's modulepreload polyfill from service worker builds.
 * The polyfill uses `document` which doesn't exist in service workers.
 * See: https://github.com/vitejs/vite/issues/15305
 */
function stripModulePreloadPolyfill() {
  return {
    name: 'strip-modulepreload-polyfill',
    generateBundle(_, bundle) {
      for (const fileName in bundle) {
        const chunk = bundle[fileName];
        if (chunk.type !== 'chunk') continue;

        let code = chunk.code;

        // Check if this chunk contains the modulepreload polyfill
        if (!code.includes('modulepreload') || !code.includes('document.head.appendChild')) {
          continue;
        }

        // Replace the feature detection IIFE that accesses document
        // Pattern: const xx=function(){const e=typeof document<"u"&&document.createElement("link")...}()
        code = code.replace(
          /const (\w+)=function\(\)\{const \w+=typeof document<"u"&&document\.createElement\("link"\)\.relList;return \w+&&\w+\.supports&&\w+\.supports\("modulepreload"\)\?"modulepreload":"preload"\}\(\)/g,
          'const $1="modulepreload"'
        );

        // Find and replace the preload function that uses document
        // We need to find the function that starts with document.getElementsByTagName("link")
        // and replace it with a simple passthrough
        const preloadFnMatch = code.match(/,(\w+)=function\((\w+),(\w+),(\w+)\)\{let \w+=Promise\.resolve\(\);if\(\w+&&\w+\.length>0\)\{document\.getElementsByTagName/);
        if (preloadFnMatch) {
          const fnName = preloadFnMatch[1];
          const arg1 = preloadFnMatch[2];
          const arg2 = preloadFnMatch[3];
          const arg3 = preloadFnMatch[4];

          // Find the end of this function (it ends with returning the promise chain)
          // and replace the entire function
          const fnStart = code.indexOf(preloadFnMatch[0]);
          let braceCount = 0;
          let fnEnd = fnStart;
          let inFunction = false;

          for (let i = fnStart; i < code.length; i++) {
            if (code[i] === '{') {
              braceCount++;
              inFunction = true;
            } else if (code[i] === '}') {
              braceCount--;
              if (inFunction && braceCount === 0) {
                fnEnd = i + 1;
                break;
              }
            }
          }

          const replacement = `,${fnName}=async(${arg1},${arg2},${arg3})=>${arg1}()`;
          code = code.slice(0, fnStart) + replacement + code.slice(fnEnd);
        }

        chunk.code = code;
      }
    }
  };
}

// Main build config - excludes content script (built separately with vite.config.content.mjs)
export default defineConfig({
  plugins: [svelte(), stripModulePreloadPolyfill()],
  envDir: resolve(__dirname, 'src/extension'), // Load .env from src/extension
  define: {
    __BUILD_MODE__: JSON.stringify('extension'),
  },
  build: {
    // Disable modulePreload completely - the polyfill uses `document` which doesn't exist in service workers
    // Setting to false doesn't always work, so we use resolveDependencies: () => [] as a workaround
    // See: https://github.com/vitejs/vite/issues/15305, https://github.com/vitejs/vite/issues/11889
    modulePreload: false,
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
