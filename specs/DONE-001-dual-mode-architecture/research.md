# Research: Dual-Mode Architecture

**Feature**: 001-dual-mode-architecture
**Date**: 2026-02-03

## Technology Decisions

### 1. Native Framework Selection

**Decision**: Tauri v1.x

**Rationale**:
- Smallest bundle size among cross-platform options (~15-25MB vs Electron's 150MB+)
- Rust backend provides native OS integration without bundling Chromium
- Active development with strong community
- Built-in system tray, global hotkey, and auto-update support
- Can reuse existing Svelte frontend code

**Alternatives Considered**:
| Option | Bundle Size | Pros | Cons | Rejected Because |
|--------|-------------|------|------|------------------|
| Electron | 150MB+ | Mature, large ecosystem | Huge bundle, memory hungry | Size constraint (30MB target) |
| Neutralinojs | ~5MB | Tiny, simple | Limited features, less mature | Missing system tray, global hotkey |
| Flutter | ~20MB | Good cross-platform | Different language (Dart) | Can't reuse Svelte code |
| Native (per-platform) | Varies | Best performance | 3x development effort | Maintenance burden |

### 2. Browser Connection Strategy

**Decision**: Chrome DevTools MCP auto-connect (primary) with fallback chain

**Rationale**:
- Chrome DevTools MCP is the modern, user-friendly approach
- No separate Chrome instance needed - controls user's actual browser
- Session freshness guaranteed (no stale cookies)
- Fallback chain ensures compatibility with older Chrome versions

**Fallback Chain**:
1. Chrome DevTools MCP auto-connect (`chrome://inspect/#remote-debugging`)
2. Existing debug port detection (localhost:9222)
3. Profile-copy + launch with `--remote-debugging-port`
4. Graceful degradation (browser tools disabled)

**Alternatives Considered**:
| Option | User Setup | Session Freshness | Complexity |
|--------|------------|-------------------|------------|
| Auto-connect only | One-time toggle | Always fresh | Low |
| Profile-copy only | None | Snapshot | Medium |
| Bundled Chromium | None | None (no sessions) | Low |

### 3. CDP Library Selection

**Decision**: puppeteer-core

**Rationale**:
- Mature, well-documented CDP wrapper
- "core" variant doesn't bundle Chromium (uses user's Chrome)
- Excellent TypeScript support
- Handles CDP protocol complexity (reconnection, events)

**Alternatives Considered**:
| Option | Bundled Browser | TypeScript | Maturity |
|--------|-----------------|------------|----------|
| puppeteer-core | No | Excellent | High |
| playwright | Yes (150MB+) | Excellent | High |
| chrome-remote-interface | No | Partial | Medium |
| Raw WebSocket | No | Manual | N/A |

### 4. Native Storage Solution

**Decision**: better-sqlite3 for data, keytar for credentials

**Rationale**:
- better-sqlite3: Synchronous API, excellent performance, mature
- keytar: Cross-platform OS keychain access (Keychain, Credential Manager, libsecret)
- SQLite is single-file, easy backup, no external database needed

**Alternatives Considered**:
| Option | Performance | Cross-platform | Encrypted |
|--------|-------------|----------------|-----------|
| better-sqlite3 | Excellent | Yes | Optional |
| sql.js (WASM) | Good | Yes | No |
| LevelDB | Good | Yes | No |
| PouchDB | Medium | Yes | No |

### 5. WebSocket Library

**Decision**: ws (Node.js native WebSocket)

**Rationale**:
- Standard Node.js WebSocket library
- Minimal dependencies
- Well-tested, production-ready
- Simple API for server implementation

### 6. Build System Strategy

**Decision**: Vite with conditional builds

**Rationale**:
- Already using Vite for extension
- Supports `define` for compile-time constants (`__BUILD_MODE__`)
- Tree-shaking removes unused platform code
- Multiple config files for different targets

**Build Configurations**:
```
vite.config.extension.ts  → dist/extension/
vite.config.desktop.ts    → dist/desktop/
tauri.conf.json           → Uses dist/desktop/ as frontend
```

## Interface Design Research

### ChannelAdapter Pattern

Based on the existing SQ/EQ (Submission Queue / Event Queue) pattern in the codebase:

```typescript
// Core pattern already exists in protocol/types.ts and protocol/events.ts
// ChannelAdapter wraps platform-specific message transport

interface ChannelAdapter {
  readonly channelId: string;
  readonly channelType: ChannelType;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // SQ: Receive submissions from this channel
  onSubmission(handler: (op: Op, context: SubmissionContext) => void): void;

  // EQ: Send events to this channel
  sendEvent(event: EventMsg): Promise<void>;

  // Capability checks for adaptive behavior
  supportsStreaming(): boolean;
  supportsApprovals(): boolean;
  supportsMedia(): boolean;
}
```

### DebuggerClient Abstraction

Analysis of existing DomService code shows it calls `chrome.debugger.sendCommand()` directly. The abstraction layer needs to:

1. Match the `chrome.debugger` API signature
2. Support both sync (chrome.debugger returns Promise via callback) and async (puppeteer native Promise)
3. Handle event subscriptions

```typescript
interface DebuggerClient {
  attach(target: DebuggerTarget): Promise<void>;
  detach(): Promise<void>;
  sendCommand<T>(method: string, params?: object): Promise<T>;
  onEvent(callback: (method: string, params: unknown) => void): void;
  isAttached(): boolean;
}

type DebuggerTarget =
  | { tabId: number }      // Extension mode
  | { page: Page };        // Native mode (puppeteer Page)
```

### StorageProvider Interface

Analysis of existing storage patterns shows usage of:
- IndexedDB for conversations, messages, memory
- chrome.storage.sync for settings
- chrome.storage.local for credentials

```typescript
interface StorageProvider {
  // Basic CRUD
  get<T>(collection: string, key: string): Promise<T | null>;
  set<T>(collection: string, key: string, value: T): Promise<void>;
  delete(collection: string, key: string): Promise<void>;

  // Bulk operations
  getMany<T>(collection: string, keys: string[]): Promise<Map<string, T>>;
  setMany<T>(collection: string, entries: Map<string, T>): Promise<void>;

  // Query
  list<T>(collection: string, options?: ListOptions): Promise<T[]>;
  query<T>(collection: string, filter: QueryFilter): Promise<T[]>;

  // Transactions
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}
```

## Security Research

### Terminal Security Layers

**Layer 1: Blocklist (Always Denied)**
```typescript
const BLOCKED_PATTERNS = [
  /^rm\s+-rf\s+\/$/,           // rm -rf /
  /^mkfs\./,                    // mkfs.*
  /^dd\s+.*of=\/dev\//,        // dd to devices
  /\|\s*(ba)?sh$/,              // curl | sh patterns
  /^chmod\s+-R\s+777\s+\//,    // chmod 777 /
];
```

**Layer 2: Sudo Detection**
```typescript
const requiresApproval = (cmd: string) =>
  cmd.startsWith('sudo ') || cmd.includes('| sudo');
```

**Layer 3: Optional Allowlist**
```yaml
# ~/.pi/config.yaml
security:
  terminal:
    mode: allowlist  # or 'blocklist'
    allowed_commands:
      - ls
      - cat
      - grep
      - git status
      - npm test
```

### WebSocket Authentication

**Localhost**: No auth required (trusted local environment)
**Non-localhost**: API key in first message or header

```typescript
// Client authentication flow
ws.send(JSON.stringify({
  type: 'auth',
  api_key: 'pi_sk_...'
}));

// Server validates before accepting submissions
if (!isLocalhost(req.socket.remoteAddress) && !validApiKey) {
  ws.close(4001, 'Authentication required');
}
```

## Migration Strategy

### Phase 1: Safe File Movements

Files to move (no modification needed):
```
src/protocol/        → src/core/protocol/
src/models/          → src/core/models/
src/types/           → src/core/types/
src/utils/           → src/core/utils/
src/background/      → src/extension/background/
src/content/         → src/extension/content/
src/sidepanel/       → src/extension/sidepanel/
src/static/          → src/extension/static/
manifest.json        → src/extension/manifest.json
```

### Phase 2: Files Requiring Modification

Files that reference moved dependencies:
- All imports need path updates
- `vite.config.ts` needs new entry points
- `tsconfig.json` needs updated paths

### Phase 3: New Files

Interfaces and factories (new code):
```
src/core/channels/ChannelAdapter.ts
src/core/channels/ChannelManager.ts
src/core/tools/browser/BrowserController.ts
src/core/tools/browser/DebuggerClient.ts
src/core/storage/StorageProvider.ts
```

## Open Questions (Resolved)

1. ~~WebSocket authentication for non-localhost~~ → API key required
2. ~~Browser connection primary method~~ → Chrome DevTools MCP with fallback chain
3. ~~Profile refresh strategy~~ → On-demand via auto-connect (always fresh)

## References

- [Tauri Documentation](https://tauri.app/v1/guides/)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- [puppeteer-core API](https://pptr.dev/api)
- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Design Document](./.ai_design/desktop_app_design.md)
