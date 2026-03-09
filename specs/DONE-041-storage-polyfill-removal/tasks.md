# Tasks: Storage Polyfill Removal

**Input**: Design documents from `/specs/041-storage-polyfill-removal/`
**Prerequisites**: plan.md (required), spec.md (required), research.md

**Tests**: Existing tests must be updated to pass with new storage patterns. No new test files are created.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No project initialization needed — this is a refactoring of existing code. No new files, dependencies, or structure changes.

_(No setup tasks required)_

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Update the `ApprovalConfigStorage` type contract that multiple callers depend on. This MUST complete before user story tasks can proceed since both US1 and US3 depend on the updated interface.

- [x] T001 Update `StorageGetter` type in `src/core/approval/ApprovalConfigStorage.ts` to accept `ConfigStorageProvider` instead of `chrome.storage.local`-shaped getter. Change the type from `() => { get(keys: string[]): Promise<Record<string, any>>; set(items: Record<string, any>): Promise<void> }` to `() => ConfigStorageProvider`. Update all internal method calls: `loadConfig()` should use `storage.get<Record<string, any>>(STORAGE_KEYS.CONFIG)` instead of `storage.get([STORAGE_KEYS.CONFIG])`, and `saveConfig()` / `loadHistory()` / `flushHistory()` should use `storage.get<T>(key)` / `storage.set(key, value)` instead of the array-based API. Import `ConfigStorageProvider` from `@/core/storage/ConfigStorageProvider`.

- [x] T002 Update `ApprovalConfigStorage` caller in `src/core/registry/AgentRegistry.ts` — change `new ApprovalConfigStorage(() => chrome.storage.local)` to `new ApprovalConfigStorage(() => getConfigStorage())`. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

- [x] T003 Update `ApprovalConfigStorage` caller in `src/desktop/agent/DesktopAgentBootstrap.ts` — simplify the adapter at line ~201 from `new ApprovalConfigStorage(() => ({ get: ..., set: ... }))` wrapping `TauriConfigStorage` to `new ApprovalConfigStorage(() => getConfigStorage())`, since `ConfigStorageProvider` is already initialized by this point in the desktop bootstrap. Remove the local `TauriConfigStorage` import if no longer used elsewhere in the method.

**Checkpoint**: `ApprovalConfigStorage` interface updated and both callers compile. Run `npm run typecheck` to verify.

---

## Phase 3: User Story 1 & 2 — Migrate Shared Code to ConfigStorageProvider (Priority: P1) 🎯 MVP

**Goal**: All shared code modules use `getConfigStorage()` instead of `chrome.storage.local`, fixing the desktop data-loss bug.

**Independent Test**: `grep -r "chrome\.storage\.local" src/core/ src/tools/ src/config/ src/webfront/` returns zero results. Desktop app preserves settings across restart.

### Implementation for User Story 1 & 2

- [x] T004 [P] [US1] Migrate `src/tools/SettingTool.ts` — replace `readStorageValue()` helper: change `chrome.storage.local.get(storageKey)` to `getConfigStorage().get<Record<string, unknown>>(storageKey)` and adjust the return pattern (no more `result[storageKey]` unwrapping). Replace `writeStorageValue()` helper: change `chrome.storage.local.get(storageKey)` and `chrome.storage.local.set(...)` to `getConfigStorage().get(storageKey)` and `getConfigStorage().set(storageKey, config)`. Replace `checkYoloMode()`: change `chrome.storage.local.get(STORAGE_KEYS.CONFIG)` to `getConfigStorage().get<Record<string, any>>(STORAGE_KEYS.CONFIG)`. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

- [x] T005 [P] [US1] Migrate `src/config/AgentConfig.ts` — update `migrateApprovalConfig()` method: replace `chrome.storage.local.get(['approval_config', 'agent_config'])` with `getConfigStorage().getMany<any>(['approval_config', 'agent_config'])`. Replace `chrome.storage.local.set({ agent_config: agentConfig })` with `getConfigStorage().set('agent_config', agentConfig)`. Replace `chrome.storage.local.remove('approval_config')` with `getConfigStorage().remove('approval_config')`. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

- [x] T006 [P] [US1] Migrate `src/webfront/settings/ApprovalSettings.svelte` — update `loadFromStorage()` function: replace `chrome.storage.local.get('agent_config')` with `getConfigStorage().get<Record<string, any>>('agent_config')`. Remove `result['agent_config']` unwrapping since `getConfigStorage().get()` returns the value directly. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

- [x] T007 [P] [US1] Migrate `src/webfront/components/common/ApprovalModeIndicator.svelte` — update `loadMode()` function: replace `chrome.storage.local.get(STORAGE_KEYS.CONFIG)` with `getConfigStorage().get<Record<string, any>>(STORAGE_KEYS.CONFIG)`. Remove `result[STORAGE_KEYS.CONFIG]` unwrapping. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

**Checkpoint**: All shared code migrated. Run `npm run typecheck` and verify grep for `chrome.storage.local` in `src/core/ src/tools/ src/config/ src/webfront/` returns zero hits (excluding comments/docs).

---

## Phase 4: User Story 4 — Remove Duplicate Fallback Patterns (Priority: P2)

**Goal**: Eliminate the three identical ~30-line `getStorage()` fallback blocks that create inline `chrome.storage.local` adapters.

**Independent Test**: All three files use `getConfigStorage()` directly. No `chrome.storage?.local` conditional exists.

### Implementation for User Story 4

- [x] T008 [P] [US4] Simplify `getStorage()` in `src/core/mcp/MCPConfig.ts` — replace the ~40-line async function (lines ~164-199) that checks `isConfigStorageInitialized()` and falls back to an inline `chrome.storage.local` adapter with a simple synchronous function: `function getStorage(): ConfigStorageProvider { return getConfigStorage(); }`. Remove the `isConfigStorageInitialized` import. Update callers within the file that check for `null` return (the function no longer returns null).

- [x] T009 [P] [US4] Simplify `getStorage()` in `src/core/a2a/A2AConfig.ts` — same change as T008: replace the ~40-line async fallback function (lines ~138-176) with `function getStorage(): ConfigStorageProvider { return getConfigStorage(); }`. Remove `isConfigStorageInitialized` import. Update callers within the file that check for `null` return.

- [x] T010 [P] [US4] Simplify `getStorage()` in `src/core/models/RequestQueue.ts` — same change as T008: replace the private ~40-line async `getStorage()` method (lines ~495-533) with a simple method: `private getStorage(): ConfigStorageProvider { return getConfigStorage(); }`. Remove `isConfigStorageInitialized` import. Update callers within the class that check for `null` return.

**Checkpoint**: Three files simplified. Run `npm run typecheck` to verify.

---

## Phase 5: User Story 3 — Remove Storage Polyfill from chromePolyfill.ts (Priority: P2)

**Goal**: Remove the `storagePolyfill` object and all storage-related code from the desktop polyfill. Update the `UPDATE_APPROVAL_CONFIG` handler to use `getConfigStorage()`.

**Independent Test**: `storagePolyfill` is no longer defined or exported. `chrome.storage` is not set on the window object in desktop mode.

**Depends on**: Phase 3 and Phase 4 (all callers must be migrated first).

### Implementation for User Story 3

- [x] T011 [US3] Update `UPDATE_APPROVAL_CONFIG` handler in `src/desktop/polyfills/chromePolyfill.ts` — replace the handler's use of `storagePolyfill.local.get('agent_config')` and `storagePolyfill.local.set(...)` with `getConfigStorage().get<Record<string, any>>('agent_config')` and `getConfigStorage().set('agent_config', agentConfig)`. Add import for `getConfigStorage` from `@/core/storage/ConfigStorageProvider`.

- [x] T012 [US3] Remove `storagePolyfill` from `src/desktop/polyfills/chromePolyfill.ts` — delete the `memoryStorage` variable (~line 263), the entire `storagePolyfill` object (~lines 268-370), and remove `storage: storagePolyfill` from the `chromePolyfill` export object (~line 491). Keep the `runtime`, `tabs`, `tabGroups`, and `windows` polyfills intact.

**Checkpoint**: Polyfill storage removed. Run `npm run typecheck` to verify no references to removed code. Grep for `storagePolyfill` should return zero hits.

---

## Phase 6: Update Tests

**Purpose**: Update test mocks to use `ConfigStorageProvider` instead of `chrome.storage.local` for shared code tests.

- [x] T013 [P] Update `src/tools/__tests__/SettingTool.test.ts` — replace `chrome.storage.local.get/set` mock setup with `setConfigStorage()` using a Map-based in-memory `ConfigStorageProvider` mock. Update test assertions that reference `chrome.storage.local` calls.

- [x] T014 [P] Update `src/config/__tests__/AgentConfig.test.ts` — update migration test mocks: replace `chrome.storage.local.get/set/remove` mocks with `ConfigStorageProvider` mock via `setConfigStorage()`. Ensure the `approval_config` migration test still validates the merge-and-delete behavior.

- [x] T015 [P] Update `src/core/a2a/__tests__/A2AToolAdapter.test.ts` — replace `chrome.storage.local.get` assertions (lines ~411, 444, 451) with assertions against `getConfigStorage().get()`. Update mock setup to use `setConfigStorage()`.

- [x] T016 [P] Update MCP test files: `src/core/mcp/__tests__/MCPManager.test.ts`, `src/core/mcp/__tests__/MCPManager.multi.test.ts`, `src/core/mcp/__tests__/MCPManager.platform.test.ts` — replace `chrome.storage.local` mock setup with `setConfigStorage()`. These tests mock `chrome.storage.local` at the module level; update to mock `ConfigStorageProvider` instead.

- [x] T017 [P] Review and update `src/core/models/__tests__/RequestQueue.test.ts` if it tests the `getStorage()` fallback pattern. Update any `chrome.storage.local` mocks to use `ConfigStorageProvider`.

- [x] T018 Run full test suite with `npm test` and fix any remaining failures from the migration. Verify all tests pass.

**Checkpoint**: All tests pass. Run `npm test && npm run lint` for final validation.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final cleanup and validation.

- [x] T019 Verify SC-001: run `grep -r "chrome\.storage\.local" src/core/ src/tools/ src/config/ src/webfront/ --include="*.ts" --include="*.svelte"` — must return zero results (excluding comments if any).

- [x] T020 Update comments and JSDoc in migrated files that reference `chrome.storage.local` to reference `ConfigStorageProvider` instead. Files: `src/core/mcp/MCPConfig.ts` (line 4), `src/core/mcp/types.ts` (lines 31, 36), `src/core/a2a/A2AConfig.ts` (line 4, 117), `src/core/approval/ApprovalConfigStorage.ts` (line 6), `src/core/storage/CredentialStore.ts` (line 5).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: N/A — no setup needed
- **Phase 2 (Foundational)**: No dependencies — start immediately. Updates `ApprovalConfigStorage` interface that Phase 3 and 5 depend on.
- **Phase 3 (US1&2 — Migrate callers)**: Depends on Phase 2 (T001-T003 must complete). All tasks within are parallelizable.
- **Phase 4 (US4 — Remove fallbacks)**: Independent of Phase 3. Can run in parallel with Phase 3. All tasks within are parallelizable.
- **Phase 5 (US3 — Remove polyfill storage)**: Depends on Phase 3 AND Phase 4 (all callers migrated before removing polyfill). T011 before T012 (update handler before deleting storage).
- **Phase 6 (Tests)**: Can start after Phase 3 for individual test files. T018 (full suite) must run after Phase 5.
- **Phase 7 (Polish)**: Depends on all phases complete.

### User Story Dependencies

- **US1 & US2 (P1)**: Can start after Phase 2 (Foundational). No cross-story dependencies.
- **US4 (P2)**: Independent of US1/US2. Can run in parallel with Phase 3.
- **US3 (P2)**: Depends on US1, US2, and US4 completion (all chrome.storage.local callers migrated before removing polyfill).

### Parallel Opportunities

- T004, T005, T006, T007 can all run in parallel (different files, no dependencies)
- T008, T009, T010 can all run in parallel (different files, same pattern)
- T013, T014, T015, T016, T017 can all run in parallel (different test files)
- Phase 3 and Phase 4 can run in parallel

---

## Parallel Example: Phase 3 (US1&2)

```
# All four migrations can run simultaneously:
T004: Migrate SettingTool.ts
T005: Migrate AgentConfig.ts
T006: Migrate ApprovalSettings.svelte
T007: Migrate ApprovalModeIndicator.svelte
```

## Parallel Example: Phase 4 (US4)

```
# All three fallback removals can run simultaneously:
T008: Simplify MCPConfig.ts getStorage()
T009: Simplify A2AConfig.ts getStorage()
T010: Simplify RequestQueue.ts getStorage()
```

---

## Implementation Strategy

### MVP First (Phase 2 + Phase 3)

1. Complete Phase 2: Update ApprovalConfigStorage interface (T001-T003)
2. Complete Phase 3: Migrate all shared code callers (T004-T007)
3. **STOP and VALIDATE**: Desktop settings now persist across restart. Data-loss bug fixed.

### Incremental Delivery

1. Phase 2 → ApprovalConfigStorage updated → Foundation ready
2. Phase 3 → All callers migrated → **Data-loss bug FIXED** (MVP!)
3. Phase 4 → Fallback patterns removed → Code quality improved
4. Phase 5 → Polyfill storage removed → Dead code eliminated
5. Phase 6 → Tests updated → Full CI green
6. Phase 7 → Polish → Feature complete

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Extension-only code (`src/extension/`, `VaultManager.ts`, `ChromeCredentialStore.ts`) is intentionally NOT migrated
- The `chrome.storage.local` mock in `src/__test-utils__/chrome-storage-mock.ts` should be kept — it's still needed for extension-specific tests
- After Phase 5, `chrome.storage` will be `undefined` in desktop mode — this is intentional and correct
