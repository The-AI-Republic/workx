# Quickstart: Fix TypeScript Type-Check CI Failures

**Feature**: 027-typecheck-fixes
**Date**: 2026-02-17

## Overview

This feature resolves 223 TypeScript type-check errors so that `npm run type-check` passes in CI. Changes are limited to TypeScript configuration, type declarations, and type annotations — no runtime behavior changes.

## Quick Validation

```bash
# Before (223 errors):
npm run type-check    # exits with error code

# After (0 errors):
npm run type-check    # exits with code 0

# Verify tests still pass:
npm test
```

## Changes Summary

### 1. Install @types/node
```bash
npm install --save-dev @types/node
```

### 2. Update tsconfig.json
Add `"node"` to the `types` array:
```json
{
  "compilerOptions": {
    "types": ["chrome", "vite/client", "svelte", "node"]
  }
}
```

### 3. Create ambient module declarations
Create `src/types/ambient-modules.d.ts` with type stubs for packages not installed in node_modules:
- `@tauri-apps/api/core` (with generic `invoke<T>()`)
- `@tauri-apps/api/event`, `@tauri-apps/api/window`, `@tauri-apps/api/path`
- `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-global-shortcut`, `@tauri-apps/plugin-notification`
- `@modelcontextprotocol/sdk/*`
- `@a2a-js/sdk` and `@a2a-js/sdk/client`
- `@google/genai`

### 4. Add explicit type annotations
Add type annotations to ~19 callback parameters in:
- `src/core/mcp/MCPClient.ts`
- `src/core/mcp/RustMCPBridge.ts`
- `src/core/a2a/A2AClient.ts`
- `src/desktop/**/*.ts` (various files)

### 5. Fix null safety issues
- `src/core/messaging/TauriMessageService.ts` — null guard on `this.listen`
- `src/desktop/tools/terminal/SandboxManager.ts` — type union for nullable status
- `src/desktop/storage/TauriConfigStorage.ts` — type assertion for `unknown` to `string`

## Verification Checklist

- [ ] `npm run type-check` exits with code 0
- [ ] `npm test` passes with no regressions
- [ ] `strict: true` and `noImplicitAny: true` remain in tsconfig
- [ ] No `@ts-ignore` or `@ts-expect-error` comments added
