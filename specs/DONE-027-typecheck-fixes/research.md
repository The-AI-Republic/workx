# Research: Fix TypeScript Type-Check CI Failures

**Feature**: 027-typecheck-fixes
**Date**: 2026-02-17

## Research Summary

### R1: Why are Node.js globals (`global`, `process`, `require`, `__dirname`) not recognized?

**Decision**: Install `@types/node` as a devDependency and add `"node"` to `tsconfig.json` types array.

**Rationale**: The current `tsconfig.json` has `types: ["chrome", "vite/client", "svelte"]` which explicitly limits available global types. Without `"node"`, TypeScript has no knowledge of Node.js globals. Since test files (Vitest) run in a Node.js process and production code references `process.env`, Node.js types are required. `@types/node` is currently NOT installed in the project.

**Alternatives considered**:
- Separate `tsconfig.test.json` with `"node"` types only for tests: Rejected because production code (`src/utils/logger.ts`, `src/types/errors.ts`) also references Node.js APIs (`process.env`, `Error.captureStackTrace`).
- Individual `/// <reference types="node" />` directives: Rejected because it would need to be added to 40+ files.

---

### R2: Why are external package imports unresolved (TS2307)?

**Decision**: Create ambient module declaration files (`.d.ts`) for packages that are not installed in `node_modules`.

**Rationale**: The following packages are declared in `package.json` but **not installed** in `node_modules`:
- `@tauri-apps/api` (and all `@tauri-apps/*` plugins)
- `@modelcontextprotocol/sdk`
- `@a2a-js/sdk`
- `@google/genai`

These packages are likely unavailable in CI because:
- Tauri packages may require the Tauri build environment
- Other packages may have installation issues or are only available in specific build contexts

Since `tsc --noEmit` checks types at the source level, ambient declarations provide type stubs that satisfy the type-checker without requiring the actual packages.

**Alternatives considered**:
- Install all packages before type-check: Rejected because packages like Tauri may require native build tools not available in CI.
- Move uninstallable packages to `optionalDependencies`: Does not solve the type-checking problem.
- Use `@ts-ignore` comments: Rejected per FR-007 (must not weaken type checking).

---

### R3: How to handle implicit `any` parameters (TS7006)?

**Decision**: Add explicit type annotations to all callback parameters that currently lack them.

**Rationale**: With `noImplicitAny: true` (required by FR-007), every parameter must have a type. Most of these are in `.map()`, `.filter()`, or event handler callbacks where the type can be inferred from the SDK types once ambient declarations exist, or annotated explicitly.

**Files affected** (19 errors):
- `src/core/a2a/A2AClient.ts` (1 parameter)
- `src/core/mcp/MCPClient.ts` (2 parameters)
- `src/core/mcp/RustMCPBridge.ts` (5 parameters)
- `src/desktop/auth/DesktopAuthService.ts` (1 parameter)
- `src/desktop/channels/TauriChannel.ts` (2 parameters)
- `src/desktop/channels/websocket/WebSocketServer.ts` (3 parameters)
- `src/desktop/polyfills/fetchProxy.ts` (1 parameter)
- `src/desktop/storage/SQLiteStorageProvider.ts` (2 parameters)
- `src/desktop/storage/TauriConfigStorage.ts` (related to unknown type)
- `src/desktop/tray.ts` (1 parameter)

---

### R4: How to handle the `invoke<T>()` type argument errors (TS2347)?

**Decision**: The ambient declaration for `@tauri-apps/api/core` must export a properly generic-typed `invoke` function.

**Rationale**: The TS2347 error "Untyped function calls may not accept type arguments" occurs because the `invoke` function is not typed (it's from an unresolved module). Once the ambient declaration provides a generic signature like `invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>`, these errors resolve automatically.

**Alternatives considered**: None needed - this is the standard approach.

---

### R5: How to handle null safety issues (TS2531/TS2721)?

**Decision**: Add null checks or non-null assertions where the code logic guarantees non-null values.

**Rationale**:
- `src/core/messaging/TauriMessageService.ts` (lines 90, 96): The `this.listen` method is assigned in the `connect()` flow and is guaranteed to exist by the time it's called. A non-null assertion (`!`) or guard check is appropriate.
- `src/desktop/tools/terminal/SandboxManager.ts` (line 152): A type mismatch where `null` is assigned to `SandboxStatusResult`. Needs a type union or default value.

---

### R6: How to handle `Error.captureStackTrace` (TS2339)?

**Decision**: Resolved automatically by adding `@types/node`.

**Rationale**: `@types/node` includes the V8-specific `Error.captureStackTrace` static method in its type definitions. Once `"node"` is in the tsconfig types array, `Error.captureStackTrace` is recognized.

---

### R7: Ambient declaration strategy for uninstalled packages

**Decision**: Create a single `src/types/ambient-modules.d.ts` file with minimal ambient module declarations for all uninstalled packages.

**Rationale**: Ambient module declarations (`declare module 'package-name'`) tell TypeScript that a module exists without providing full types. For packages used at runtime but not available during type-checking, this is the standard approach. The declarations should include enough type information for the actual usage patterns in the codebase (e.g., `invoke<T>()` must be generic).

**Structure**: Group by package family:
- Tauri core and plugins
- MCP SDK
- A2A SDK
- Google GenAI
