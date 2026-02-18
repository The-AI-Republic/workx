# Tasks: Fix TypeScript Type-Check CI Failures

**Input**: Design documents from `/specs/027-typecheck-fixes/`
**Prerequisites**: plan.md (required), spec.md (required), research.md

**Tests**: No test tasks included (feature is type-level only; validation is `npm run type-check` and `npm test`).

**Organization**: Tasks grouped by implementation phase. US2 (test files) is resolved by setup. US3 (production files) requires ambient declarations + annotations. US1 (CI passes) is the final validation gate.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install missing type definitions and update TypeScript configuration. Resolves 142 errors (TS2304, TS2591, TS2339).

- [ ] T001 Install `@types/node` as devDependency via `npm install --save-dev @types/node` in package.json
- [ ] T002 Add `"node"` to the `types` array in tsconfig.json (change `["chrome", "vite/client", "svelte"]` to `["chrome", "vite/client", "svelte", "node"]`)
- [ ] T003 Run `npm run type-check` and verify error count drops from 223 to ~81 (TS2304, TS2591, TS2339 errors eliminated)

**Checkpoint**: All test file errors (US2) and `Error.captureStackTrace` / `process.env` errors resolved. ~81 errors remaining.

---

## Phase 2: Foundational (Ambient Module Declarations)

**Purpose**: Create type stubs for packages not installed in node_modules. Resolves 56 errors (TS2307, TS2347). MUST complete before Phase 3 (type annotations depend on ambient declarations being present).

- [ ] T004 [US3] Create `src/types/ambient-modules.d.ts` with Tauri core declarations: `@tauri-apps/api/core` (export generic `invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>`), `@tauri-apps/api/event` (export `listen`, `emit`, `once`, `UnlistenFn`), `@tauri-apps/api/window` (export `getCurrentWindow`, `Window`), `@tauri-apps/api/path` (export `appDataDir`, `join`, `resolve`)
- [ ] T005 [US3] Add Tauri plugin declarations to `src/types/ambient-modules.d.ts`: `@tauri-apps/plugin-shell` (export `Command`, `open`), `@tauri-apps/plugin-global-shortcut` (export `register`, `unregister`), `@tauri-apps/plugin-notification` (export `sendNotification`, `isPermissionGranted`, `requestPermission`)
- [ ] T006 [US3] Add MCP SDK declarations to `src/types/ambient-modules.d.ts`: `@modelcontextprotocol/sdk/client/index.js` (export `Client` class, `StdioClientTransport`), `@modelcontextprotocol/sdk/shared/transport.js` (export `Transport` interface), `@modelcontextprotocol/sdk/types.js` (export type definitions)
- [ ] T007 [US3] Add A2A SDK declarations to `src/types/ambient-modules.d.ts`: `@a2a-js/sdk` (export core types), `@a2a-js/sdk/client` (export `A2AClient` class)
- [ ] T008 [US3] Add Google GenAI declaration to `src/types/ambient-modules.d.ts`: `@google/genai` (export `GoogleGenAI` class, model types)
- [ ] T009 Run `npm run type-check` and verify error count drops from ~81 to ~25 (TS2307, TS2347 errors eliminated)

**Checkpoint**: All module import errors resolved. ~25 errors remaining (TS7006 implicit any + null safety).

---

## Phase 3: User Story 3 - Production Source Files Type-Check Correctly (Priority: P1)

**Goal**: Fix all remaining type annotation and null safety errors in production source files.

**Independent Test**: Run `npm run type-check` and verify zero errors from non-test source files.

### MCP & A2A Type Annotations (8 errors)

- [ ] T010 [P] [US3] Add explicit type annotations to 2 callback parameters in src/core/mcp/MCPClient.ts (line 206 `tool` param, line 263 `c` param)
- [ ] T011 [P] [US3] Add explicit type annotations to 5 callback parameters in src/core/mcp/RustMCPBridge.ts (lines 213, 240, 280, 377, 397 — `tool`, `c`, `r` params)
- [ ] T012 [P] [US3] Add explicit type annotation to 1 callback parameter in src/core/a2a/A2AClient.ts (line 117 `s` param)
- [ ] T013 [P] [US3] Add explicit type annotation to 1 callback parameter in src/core/mcp/MCPClient.ts (line 317 `resource` param)

### Desktop Module Type Annotations (11 errors)

- [ ] T014 [P] [US3] Add explicit type annotation to `event` parameter in src/desktop/auth/DesktopAuthService.ts (line 100)
- [ ] T015 [P] [US3] Add explicit type annotations to 2 `event` parameters in src/desktop/channels/TauriChannel.ts (lines 86, 95)
- [ ] T016 [P] [US3] Add explicit type annotations to 3 `event` parameters in src/desktop/channels/websocket/WebSocketServer.ts (lines 141, 147, 153)
- [ ] T017 [P] [US3] Add explicit type annotation to `err` parameter in src/desktop/polyfills/fetchProxy.ts (line 192)
- [ ] T018 [P] [US3] Add explicit type annotations to 2 `row` parameters in src/desktop/storage/SQLiteStorageProvider.ts (lines 195, 215)
- [ ] T019 [P] [US3] Add explicit type annotation to `event` parameter in src/desktop/tray.ts (line 35)

### Null Safety & Type Assignment Fixes (6 errors)

- [ ] T020 [P] [US3] Fix null safety in src/core/messaging/TauriMessageService.ts: add null guards or non-null assertions for `this.listen` calls at lines 90 and 96 (TS2531/TS2721)
- [ ] T021 [P] [US3] Fix type assertion in src/desktop/storage/TauriConfigStorage.ts: cast `unknown` to `string` at line 123 (TS2345)
- [ ] T022 [P] [US3] Fix null type union in src/desktop/tools/terminal/SandboxManager.ts: update `_status` field type to allow `null` or provide non-null default at line 152 (TS2322)

**Checkpoint**: All production source file errors resolved. 0 errors expected from `npm run type-check`.

---

## Phase 4: Polish & Final Validation

**Purpose**: Verify all success criteria are met.

- [ ] T023 Run `npm run type-check` and verify exit code 0 with zero errors (SC-001)
- [ ] T024 Run `npm test` and verify all existing tests pass with no regressions (SC-003)
- [ ] T025 Verify `tsconfig.json` still has `strict: true` and `noImplicitAny: true` — no strict options weakened (SC-004)
- [ ] T026 Verify no `@ts-ignore` or `@ts-expect-error` comments were added to any files

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T001, T002) — ambient declarations need @types/node first
- **US3 Type Annotations (Phase 3)**: Depends on Phase 2 — annotations may reference types from ambient declarations
- **Validation (Phase 4)**: Depends on all previous phases

### User Story Dependencies

- **US2 (Test Files)**: Fully resolved by Phase 1 (T001 + T002). No dedicated tasks needed.
- **US3 (Production Files)**: Requires Phase 1 + Phase 2 + Phase 3. All Phase 3 tasks are parallelizable.
- **US1 (CI Passes)**: Achieved when Phase 4 validation passes.

### Parallel Opportunities

- **Phase 2**: T004–T008 modify the same file (`ambient-modules.d.ts`) so they CANNOT run in parallel. Execute sequentially.
- **Phase 3**: ALL tasks (T010–T022) modify different files and CAN run in parallel. Maximum parallelism: 13 concurrent tasks.
- **Phase 4**: T023–T026 are sequential validation checks.

---

## Parallel Example: Phase 3 (US3 Type Annotations)

```bash
# Launch ALL Phase 3 tasks in parallel (all different files):
Task: "T010 Add type annotations in src/core/mcp/MCPClient.ts"
Task: "T011 Add type annotations in src/core/mcp/RustMCPBridge.ts"
Task: "T012 Add type annotation in src/core/a2a/A2AClient.ts"
Task: "T013 Add type annotation in src/core/mcp/MCPClient.ts (resource)"
Task: "T014 Add type annotation in src/desktop/auth/DesktopAuthService.ts"
Task: "T015 Add type annotations in src/desktop/channels/TauriChannel.ts"
Task: "T016 Add type annotations in src/desktop/channels/websocket/WebSocketServer.ts"
Task: "T017 Add type annotation in src/desktop/polyfills/fetchProxy.ts"
Task: "T018 Add type annotations in src/desktop/storage/SQLiteStorageProvider.ts"
Task: "T019 Add type annotation in src/desktop/tray.ts"
Task: "T020 Fix null safety in src/core/messaging/TauriMessageService.ts"
Task: "T021 Fix type assertion in src/desktop/storage/TauriConfigStorage.ts"
Task: "T022 Fix null type union in src/desktop/tools/terminal/SandboxManager.ts"
```

---

## Implementation Strategy

### MVP First (Phase 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. **VALIDATE**: Error count drops from 223 → ~81
3. This alone unblocks US2 (test files pass type-check)

### Full Delivery

1. Phase 1 → 223 → ~81 errors
2. Phase 2 → ~81 → ~25 errors
3. Phase 3 → ~25 → 0 errors (all tasks parallelizable)
4. Phase 4 → Final validation ✓

---

## Notes

- All Phase 3 tasks are [P] — maximum parallelism available
- Phase 2 tasks are sequential (single file modifications)
- No test tasks included — validation is via `npm run type-check` and `npm test`
- No runtime behavior changes in any task
- Commit after each phase completion for incremental progress
