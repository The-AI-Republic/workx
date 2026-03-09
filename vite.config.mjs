import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Enforce that VITE_VAULT_SECRET is set in the extension .env file.
 * Without it, credential encryption cannot function and the extension
 * would fail at runtime. Catches misconfigured builds early.
 */
function enforceVaultSecret() {
  return {
    name: 'enforce-vault-secret',
    configResolved(config) {
      const secret = config.env?.VITE_VAULT_SECRET;
      if (!secret || secret.length < 32) {
        const msg = !secret
          ? 'VITE_VAULT_SECRET is missing from src/extension/.env'
          : `VITE_VAULT_SECRET must be at least 32 characters (got ${secret.length})`;
        throw new Error(
          `\n[enforce-vault-secret] ${msg}\n` +
          `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"\n`
        );
      }
    }
  };
}

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

        // Only process chunks that contain the Vite preload polyfill
        if (!code_has_preload_polyfill(chunk.code)) continue;

        let code = chunk.code;

        // Replace the feature detection IIFE that accesses document
        // Matches: const XX=(function(){const e=typeof document<"u"&&document.createElement("link").relList;...}())
        code = code.replace(
          /\(function\(\)\{const \w+=typeof document<"u"&&document\.createElement\("link"\)\.relList;return \w+&&\w+\.supports&&\w+\.supports\("modulepreload"\)\?"modulepreload":"preload"\}\)\(\)/g,
          '"modulepreload"'
        );

        // Replace the preload function that uses document.getElementsByTagName, document.head.appendChild,
        // and the error handler that uses window.dispatchEvent.
        // Strategy: find the function assigned to a variable that contains document.getElementsByTagName("link"),
        // then replace the entire assignment (from the variable assignment through the closing brace)
        // with a simple passthrough that just calls the first argument (the import function).
        const preloadFnMatch = code.match(/[,;](\w+)=function\((\w+),(\w+),(\w+)\)\{let \w+=Promise\.resolve\(\);if\(\w+&&\w+\.length>0\)\{/);
        if (preloadFnMatch && code.includes('document.getElementsByTagName("link")')) {
          const fnName = preloadFnMatch[1];
          const arg1 = preloadFnMatch[2];

          // Find the start of this function assignment
          const fnStart = code.indexOf(preloadFnMatch[0]);
          // Walk through braces to find the function body end
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

          // Replace with a simple passthrough: just call the import function and return the result
          const separator = code[fnStart]; // preserve the original , or ;
          const replacement = `${separator}${fnName}=function(${arg1}){return ${arg1}()}`;
          code = code.slice(0, fnStart) + replacement + code.slice(fnEnd);
        }

        chunk.code = code;
      }
    }
  };
}

/** Check if a chunk contains the Vite modulepreload polyfill */
function code_has_preload_polyfill(code) {
  return code.includes('modulepreload') && (
    code.includes('document.head.appendChild') ||
    code.includes('window.dispatchEvent')
  );
}

// Main build config - excludes content script (built separately with vite.config.content.mjs)
export default defineConfig({
  plugins: [enforceVaultSecret(), svelte(), stripModulePreloadPolyfill()],
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
        sidepanel: resolve(__dirname, 'src/webfront/sidepanel.html'),
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
