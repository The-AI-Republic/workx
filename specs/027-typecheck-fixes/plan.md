# Implementation Plan: Fix TypeScript Type-Check CI Failures

**Branch**: `027-typecheck-fixes` | **Date**: 2026-02-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/027-typecheck-fixes/spec.md`

## Summary

Fix 223 TypeScript type-check errors so that `npm run type-check` (`tsc --noEmit`) passes with zero errors in CI. The approach is three-pronged: (1) install `@types/node` and update tsconfig to resolve 142+ Node.js-related errors, (2) create ambient module declarations for 7 package families that are not installed in node_modules (resolving 56 import/type-argument errors), and (3) add explicit type annotations and null safety fixes for the remaining 25 errors. No runtime behavior changes.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Vitest 3.2.4, Svelte 4.2.20, Vite 5.4.20, Chrome types, Tauri APIs (optional), MCP SDK (optional), A2A SDK (optional), Google GenAI (optional)
**Storage**: N/A
**Testing**: Vitest (jsdom environment, globals enabled)
**Target Platform**: Chrome Extension + Tauri Desktop (multi-target)
**Project Type**: Single project with extension/desktop variants
**Performance Goals**: N/A (type-check is a build-time operation)
**Constraints**: Must not weaken strict mode (`strict: true`, `noImplicitAny: true`); must not change runtime behavior
**Scale/Scope**: 223 errors across ~60 files in 10 distinct error categories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is default template (not customized). No project-specific gates defined. Proceeding with standard engineering best practices:
- No strict mode weakening
- No `@ts-ignore` or `@ts-expect-error` workarounds
- All changes are type-level only (no runtime impact)
- Existing tests must continue passing

**Post-Phase 1 re-check**: Plan adds `@types/node` devDependency, creates one new `.d.ts` file, and modifies tsconfig + ~20 source files with type annotations. All changes are type-level. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/027-typecheck-fixes/
├── plan.md              # This file
├── research.md          # Phase 0: research findings
├── quickstart.md        # Phase 1: quick validation guide
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── types/
│   ├── errors.ts              # MODIFY: captureStackTrace resolved by @types/node
│   ├── globals.d.ts           # EXISTING: __BUILD_MODE__ declaration
│   └── ambient-modules.d.ts   # NEW: ambient declarations for uninstalled packages
├── core/
│   ├── a2a/A2AClient.ts       # MODIFY: add type annotation (1 param)
│   ├── mcp/
│   │   ├── MCPClient.ts       # MODIFY: add type annotations (2 params)
│   │   ├── MCPManager.ts      # NO CHANGE: resolved by ambient declarations
│   │   ├── RustMCPBridge.ts   # MODIFY: add type annotations (5 params)
│   │   └── transports/SSEClientTransport.ts  # NO CHANGE: resolved by ambient declarations
│   └── messaging/
│       └── TauriMessageService.ts  # MODIFY: fix null safety (2 locations)
├── desktop/
│   ├── auth/DesktopAuthService.ts           # MODIFY: add type annotation (1 param)
│   ├── channels/TauriChannel.ts             # MODIFY: add type annotations (2 params)
│   ├── channels/websocket/WebSocketServer.ts # MODIFY: add type annotations (3 params)
│   ├── polyfills/fetchProxy.ts              # MODIFY: add type annotation (1 param)
│   ├── storage/SQLiteStorageProvider.ts     # MODIFY: add type annotations (2 params)
│   ├── storage/TauriConfigStorage.ts        # MODIFY: fix unknown-to-string cast (1 location)
│   ├── tools/terminal/SandboxManager.ts     # MODIFY: fix null type union (1 location)
│   └── tray.ts                              # MODIFY: add type annotation (1 param)
├── utils/logger.ts            # NO CHANGE: resolved by @types/node
└── **/__tests__/**            # NO CHANGE: resolved by @types/node

tsconfig.json                  # MODIFY: add "node" to types array
package.json                   # MODIFY: add @types/node devDependency
```

**Structure Decision**: Existing single-project structure. Changes are scattered across existing files. One new file (`src/types/ambient-modules.d.ts`) is created for ambient module declarations.

## Error Resolution Matrix

| Error Code | Count | Root Cause | Resolution | Phase |
|------------|-------|------------|------------|-------|
| TS2304 | 98 | `global` not recognized | Add `@types/node` + `"node"` to tsconfig types | Phase 1 |
| TS2591 | 40 | `process`/`require` not recognized | Add `@types/node` + `"node"` to tsconfig types | Phase 1 |
| TS2339 | 4 | `Error.captureStackTrace` missing | Add `@types/node` (includes V8 Error types) | Phase 1 |
| TS2307 | 47 | Unresolved module imports | Create `ambient-modules.d.ts` with module stubs | Phase 2 |
| TS2347 | 9 | `invoke<T>()` type args on untyped fn | Ambient declaration with generic `invoke<T>()` | Phase 2 |
| TS7006 | 19 | Implicit `any` on callback params | Add explicit type annotations | Phase 3 |
| TS2531/TS2721 | 4 | Object possibly null | Add null guards or non-null assertions | Phase 3 |
| TS2345 | 1 | `unknown` not assignable to `string` | Add type assertion | Phase 3 |
| TS2322 | 1 | Type `null` not assignable | Add type union or default value | Phase 3 |

## Implementation Phases

### Phase 1: Install @types/node and update tsconfig (resolves ~142 errors)

1. Install `@types/node` as devDependency
2. Add `"node"` to the `types` array in `tsconfig.json`
3. Run `npm run type-check` to verify ~142 errors are resolved

### Phase 2: Create ambient module declarations (resolves ~56 errors)

1. Create `src/types/ambient-modules.d.ts` with declarations for:
   - `@tauri-apps/api/core` — export `invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>`
   - `@tauri-apps/api/event` — export `listen`, `emit`, `UnlistenFn` types
   - `@tauri-apps/api/window` — export window management types
   - `@tauri-apps/api/path` — export path utility functions
   - `@tauri-apps/plugin-shell` — export `Command`, `open` types
   - `@tauri-apps/plugin-global-shortcut` — export shortcut registration types
   - `@tauri-apps/plugin-notification` — export notification types
   - `@modelcontextprotocol/sdk/client/index.js` — export `Client`, `StdioClientTransport`
   - `@modelcontextprotocol/sdk/shared/transport.js` — export `Transport` interface
   - `@modelcontextprotocol/sdk/types.js` — export SDK types
   - `@a2a-js/sdk` and `@a2a-js/sdk/client` — export A2A client types
   - `@google/genai` — export `GoogleGenAI`, model types
2. Run `npm run type-check` to verify ~56 errors are resolved

### Phase 3: Fix explicit type annotations and null safety (resolves ~25 errors)

1. Add explicit type annotations to 19 callback parameters across 10 files
2. Fix 4 null safety issues in `TauriMessageService.ts` and `SandboxManager.ts`
3. Fix 1 `unknown`-to-`string` type assertion in `TauriConfigStorage.ts`
4. Fix 1 null type union in `SandboxManager.ts`
5. Run `npm run type-check` — must show 0 errors
6. Run `npm test` — must pass with no regressions

## Complexity Tracking

No constitution violations. No complexity justifications needed.
