# Feature Specification: Storage Polyfill Removal

**Feature Branch**: `041-storage-polyfill-removal`
**Created**: 2026-03-07
**Status**: Draft
**Input**: User description: "Migrate away from chrome.storage polyfill in Tauri desktop mode. Replace all direct chrome.storage.* calls in shared code with platform-agnostic ConfigStorageProvider."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Settings Persist Across Desktop Restarts (Priority: P1)

A desktop (Tauri) user changes approval mode, MCP server config, or A2A agent settings. After restarting the app, all settings are preserved. Currently, code paths that bypass `ConfigStorageProvider` and call `chrome.storage.local` directly go through the polyfill, which falls back to in-memory storage (the Rust command signatures don't match `db_storage.rs`), causing **silent data loss on restart**.

**Why this priority**: This is a data-loss bug. Users lose settings on every desktop restart for any feature whose code calls `chrome.storage.local` directly instead of going through `ConfigStorageProvider`.

**Independent Test**: Change approval mode via the ApprovalModeIndicator, restart the desktop app, verify the mode is preserved.

**Acceptance Scenarios**:

1. **Given** a desktop user has set approval mode to "balanced", **When** they restart the app, **Then** approval mode is still "balanced" (loaded via `ConfigStorageProvider`).
2. **Given** a desktop user has configured MCP servers, **When** they restart the app, **Then** MCP server configs are preserved.
3. **Given** an extension user uses the same features, **When** they perform the same actions, **Then** behavior is unchanged (ChromeConfigStorage still works via chrome.storage.local).

---

### User Story 2 - Shared Code Uses Platform-Agnostic Storage (Priority: P1)

All shared code modules (`src/core/`, `src/tools/`, `src/config/`, `src/webfront/`) use `ConfigStorageProvider` instead of calling `chrome.storage.local` directly. The `chrome.storage` polyfill in `chromePolyfill.ts` no longer contains storage functionality.

**Why this priority**: This is the root cause fix for P1 data loss and eliminates the maintenance burden of duplicate storage paths.

**Independent Test**: Search codebase for `chrome.storage.local` — only extension-specific code (`src/extension/`) and `ChromeConfigStorage` should reference it.

**Acceptance Scenarios**:

1. **Given** `SettingTool.ts` reads/writes agent config, **When** running in desktop mode, **Then** it uses `getConfigStorage()` instead of `chrome.storage.local`.
2. **Given** `MCPConfig.ts` has a `getStorage()` fallback, **When** `ConfigStorageProvider` is initialized, **Then** no chrome.storage.local fallback is needed.
3. **Given** `ApprovalSettings.svelte` loads approval config, **When** running in desktop mode, **Then** it reads via `ConfigStorageProvider`.

---

### User Story 3 - Remove Storage Polyfill from chromePolyfill.ts (Priority: P2)

The `storagePolyfill` object is removed from `chromePolyfill.ts`. The polyfill still provides `chrome.runtime`, `chrome.tabs`, `chrome.tabGroups`, and `chrome.windows` stubs (which are needed for non-storage compatibility), but storage is no longer polyfilled.

**Why this priority**: Cleanup step that follows P1. Once all callers use `ConfigStorageProvider`, the polyfill storage code is dead code.

**Independent Test**: Remove `storagePolyfill` from `chromePolyfill.ts`, run all tests, verify no failures.

**Acceptance Scenarios**:

1. **Given** `chromePolyfill.ts` has storage removed, **When** the desktop app starts, **Then** `chrome.storage` is undefined but no code crashes (all callers migrated).
2. **Given** the `UPDATE_APPROVAL_CONFIG` handler in the polyfill uses `storagePolyfill.local`, **When** storage is removed, **Then** the handler uses `getConfigStorage()` instead.

---

### User Story 4 - Remove Duplicate Fallback Patterns (Priority: P2)

`MCPConfig.ts`, `A2AConfig.ts`, and `RequestQueue.ts` each contain ~30 lines of identical `getStorage()` fallback code that creates an inline `ConfigStorageProvider` wrapping `chrome.storage.local`. These duplicated fallbacks are removed; the modules rely on `ConfigStorageProvider` being initialized before they are called.

**Why this priority**: Code quality. Three files have identical 30-line blocks that create the same adapter pattern.

**Independent Test**: Delete the fallback blocks, run tests, verify modules work via `getConfigStorage()`.

**Acceptance Scenarios**:

1. **Given** `MCPConfig.ts` `getStorage()` is simplified, **When** it's called after initialization, **Then** it returns `getConfigStorage()` directly.
2. **Given** `ConfigStorageProvider` is not initialized, **When** `getStorage()` is called, **Then** it throws a clear error (fail-fast, not silent null).

---

### Edge Cases

- What happens if `ConfigStorageProvider` is not yet initialized when a module tries to read storage? Fail with a clear error rather than silently returning null.
- What happens to the one-time migration code in `AgentConfig.ts` that reads `approval_config`? It should use `ConfigStorageProvider` for the migration.
- What happens on Windows WebView2 where `chrome` may be partially defined? The remaining polyfill stubs (runtime, tabs) still install correctly; `chrome.storage` is left undefined.
- What happens to `VaultManager.ts` which uses `chrome.storage.local` directly? It stays as-is — it's extension-only code that runs in the service worker.
- What happens to `ChromeCredentialStore.ts`? It stays as-is — extension-only, behind the `CredentialStore` interface.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All modules in `src/core/`, `src/tools/`, `src/config/`, and `src/webfront/` MUST use `ConfigStorageProvider` (via `getConfigStorage()`) for key-value storage instead of `chrome.storage.local`.
- **FR-002**: `SettingTool.ts` MUST replace `chrome.storage.local.get/set` calls with `getConfigStorage().get/set`.
- **FR-003**: `ApprovalSettings.svelte` and `ApprovalModeIndicator.svelte` MUST read approval config via `ConfigStorageProvider` instead of `chrome.storage.local.get('agent_config')`.
- **FR-004**: `MCPConfig.ts`, `A2AConfig.ts`, and `RequestQueue.ts` MUST remove inline `chrome.storage.local` fallback adapters and use `getConfigStorage()` directly.
- **FR-005**: `AgentConfig.ts` migration code MUST use `ConfigStorageProvider` instead of `chrome.storage.local`.
- **FR-006**: `AgentRegistry.ts` MUST pass a `ConfigStorageProvider`-based storage getter to `ApprovalConfigStorage` instead of `() => chrome.storage.local`.
- **FR-007**: The `UPDATE_APPROVAL_CONFIG` handler in `chromePolyfill.ts` MUST use `getConfigStorage()` instead of `storagePolyfill.local`.
- **FR-008**: The `storagePolyfill` object and related code MUST be removed from `chromePolyfill.ts` after all callers are migrated.
- **FR-009**: Extension-only code (`src/extension/`, `VaultManager.ts`) MAY continue using `chrome.storage.local` directly — these are not in scope.
- **FR-010**: All existing tests MUST pass after migration. Test mocks for `chrome.storage.local` in shared code tests MUST be updated to use `ConfigStorageProvider` mocks.
- **FR-011**: The unused Rust `storage_get`/`storage_set` polyfill commands (which have mismatched signatures vs `db_storage.rs`) MUST be removed along with the polyfill storage.

### Key Entities

- **ConfigStorageProvider**: Platform-agnostic interface for key-value config storage. Extension uses `ChromeConfigStorage`, Desktop uses `TauriConfigStorage`.
- **ApprovalConfigStorage**: Cross-platform approval config persistence using a storage getter function. Currently accepts `() => chrome.storage.local`, needs to accept `ConfigStorageProvider`-compatible getter.
- **chromePolyfill**: Desktop compatibility layer. Storage portion to be removed; runtime/tabs/windows stubs remain.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero direct `chrome.storage.local` calls exist in `src/core/`, `src/tools/`, `src/config/`, or `src/webfront/` (verified by grep).
- **SC-002**: Desktop app preserves all settings (approval mode, MCP servers, A2A agents, tool settings) across restart.
- **SC-003**: Extension mode continues to work identically (no regressions in Chrome extension functionality).
- **SC-004**: `chromePolyfill.ts` no longer exports or defines `storagePolyfill`.
- **SC-005**: The three duplicate ~30-line `getStorage()` fallback patterns are eliminated.
- **SC-006**: All existing tests pass with updated mocks.
