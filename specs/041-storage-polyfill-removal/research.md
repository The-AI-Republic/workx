# Research: Storage Polyfill Removal

## Current Architecture

### Two Parallel Storage Paths

The codebase has two separate storage paths for the Tauri desktop app:

1. **`TauriConfigStorage`** (the correct path):
   - Implements `ConfigStorageProvider` interface
   - Calls `config_storage_*` Rust commands in `storage_commands.rs`
   - Persists to `~/.config/ai-republic/pi/config.json` (file-based JSON)
   - Used by modules that go through `getConfigStorage()`

2. **`chromePolyfill.storagePolyfill`** (the broken path):
   - Polyfills `chrome.storage.local` API for desktop mode
   - Attempts to call `storage_get`/`storage_set` Rust commands
   - **BUG**: The polyfill calls `storage_get({ keys: keyArray })` but `db_storage::storage_get` expects `(collection: String, key: String)` — **mismatched signatures**
   - Falls back to in-memory `memoryStorage` object → **data lost on restart**
   - Used by any module that calls `chrome.storage.local.*` directly

### Files Using `chrome.storage.local` Directly (Shared Code — Must Migrate)

| File | Usage | Keys |
|------|-------|------|
| `src/tools/SettingTool.ts` | `readStorageValue()`, `writeStorageValue()`, `checkYoloMode()` | `agent_config` |
| `src/config/AgentConfig.ts` | `migrateApprovalConfig()` | `approval_config`, `agent_config` |
| `src/core/mcp/MCPConfig.ts` | `getStorage()` fallback (30-line inline adapter) | `mcpServers`, `mcpDebugLogging` |
| `src/core/a2a/A2AConfig.ts` | `getStorage()` fallback (30-line inline adapter) | `a2aAgents`, `a2aDebugLogging` |
| `src/core/models/RequestQueue.ts` | `getStorage()` fallback (30-line inline adapter) | queue state |
| `src/core/registry/AgentRegistry.ts` | `() => chrome.storage.local` passed to `ApprovalConfigStorage` | `agent_config` |
| `src/webfront/settings/ApprovalSettings.svelte` | `loadFromStorage()` | `agent_config` |
| `src/webfront/components/common/ApprovalModeIndicator.svelte` | `loadMode()` | `agent_config` |
| `src/desktop/polyfills/chromePolyfill.ts` | `UPDATE_APPROVAL_CONFIG` handler uses `storagePolyfill.local` | `agent_config` |

### Files Using `chrome.storage.local` Directly (Extension-Only — Keep As-Is)

| File | Reason to Keep |
|------|----------------|
| `src/extension/storage/ChromeConfigStorage.ts` | This IS the extension ConfigStorageProvider implementation |
| `src/extension/storage/ChromeCredentialStore.ts` | Extension-only credential storage |
| `src/extension/auth/ChatGPTOAuthExtensionStorage.ts` | Extension-only OAuth |
| `src/extension/background/service-worker.ts` | Extension background script |
| `src/extension/background/rollout-cleanup.ts` | Extension-only cleanup |
| `src/core/crypto/VaultManager.ts` | Service worker crypto (extension-only context) |

### The Duplicate Fallback Pattern

`MCPConfig.ts`, `A2AConfig.ts`, and `RequestQueue.ts` each contain this identical pattern:

```typescript
async function getStorage(): Promise<ConfigStorageProvider | null> {
  if (isConfigStorageInitialized()) {
    return getConfigStorage();
  }
  // Fallback to chrome.storage.local if provider not initialized
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return {
      async get<T>(key: string): Promise<T | null> { /* ... */ },
      async set<T>(key: string, value: T): Promise<void> { /* ... */ },
      // ... 8 more methods, ~30 lines each
    };
  }
  return null;
}
```

This fallback was added as a safety net during initial `ConfigStorageProvider` migration but:
- Creates ~90 lines of duplicated code across 3 files
- On desktop, the fallback goes through the broken polyfill anyway
- `ConfigStorageProvider` is always initialized before these modules are used in practice

### ApprovalConfigStorage Storage Getter Pattern

`ApprovalConfigStorage` takes a `StorageGetter` function with this shape:
```typescript
type StorageGetter = () => {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
};
```

This mirrors `chrome.storage.local`'s API shape. In `AgentRegistry.ts`:
```typescript
const configStorage = new ApprovalConfigStorage(() => chrome.storage.local);
```

This needs to be changed to use `ConfigStorageProvider`, but `ConfigStorageProvider` has a different API shape (`get(key)` vs `get(keys[])`). The `StorageGetter` type needs to be updated or an adapter created.

### Rust Backend Commands

**`storage_commands.rs`** (config_storage_* — used by TauriConfigStorage):
- `config_storage_get(key: String) -> Option<String>`
- `config_storage_set(key: String, value: String)`
- `config_storage_remove(key: String)`
- etc.
- Persists to `config.json` file

**`db_storage.rs`** (storage_* — used by SQLiteStorageProvider):
- `storage_get(collection: String, key: String) -> Option<String>`
- `storage_set(collection: String, key: String, value: String)`
- These are SQLite-backed, collection-scoped
- The polyfill tries to call these WITHOUT a collection parameter → fails

### Test Files Needing Mock Updates

| Test File | What to Update |
|-----------|---------------|
| `src/tools/__tests__/SettingTool.test.ts` | Replace `chrome.storage.local.get/set` mocks with `ConfigStorageProvider` |
| `src/config/__tests__/AgentConfig.test.ts` | Update migration test mocks |
| `src/core/a2a/__tests__/A2AToolAdapter.test.ts` | Replace `chrome.storage.local` assertions |
| `src/core/mcp/__tests__/MCPManager.test.ts` | Update storage mocks |
| `src/core/mcp/__tests__/MCPManager.multi.test.ts` | Update storage mocks |
| `src/core/mcp/__tests__/MCPManager.platform.test.ts` | Update storage mocks |
| `src/core/storage/__tests__/CredentialStore.test.ts` | Keep as-is (extension-specific) |
| `src/core/models/__tests__/ModelClientFactory.config.test.ts` | Review mock setup |
