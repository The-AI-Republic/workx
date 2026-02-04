# Implementation Plan: Dual-Mode Architecture (BrowserX Extension + PI Desktop Agent)

**Branch**: `001-dual-mode-architecture` | **Date**: 2026-02-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-dual-mode-architecture/spec.md`

## Summary

Restructure the BrowserX codebase to support dual build modes from a single source: (1) Chrome extension (existing) and (2) PI native desktop agent (new). The architecture introduces abstraction layers for browser control, storage, and UI channels, enabling code reuse while allowing platform-specific implementations. Native mode adds terminal execution, MCP integration, and WebSocket remote control capabilities.

## Technical Context

**Language/Version**: TypeScript 5.9, Rust (for Tauri backend)
**Primary Dependencies**:
- Extension: Vite, Svelte 4.x, chrome.* APIs
- Native: Tauri 1.x, puppeteer-core, better-sqlite3, keytar, ws
- Shared: zod, openai SDK, @modelcontextprotocol/sdk
**Storage**:
- Extension: IndexedDB + chrome.storage
- Native: SQLite (better-sqlite3) + OS keychain
**Testing**: vitest (existing), playwright (e2e for both modes)
**Target Platform**:
- Extension: Chrome browser (Manifest V3)
- Native: Windows 10+, macOS 11+, Linux (Ubuntu 20.04+)
**Project Type**: Monorepo with shared core
**Performance Goals**:
- WebSocket: 10 concurrent connections
- Auto-connect: <3s, profile-copy fallback: <20s
**Constraints**:
- Extension bundle: <5MB
- Native installer: <30MB
- Zero regressions in existing extension functionality
**Scale/Scope**: Single-user desktop application

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No project-specific constitution defined. Proceeding with industry best practices:
- [x] Code reuse maximized through abstraction interfaces
- [x] Platform-specific code isolated in separate directories
- [x] Existing tests preserved and extended
- [x] Security considerations addressed (WebSocket auth, terminal blocklist)

## Project Structure

### Documentation (this feature)

```text
specs/001-dual-mode-architecture/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/                       # Shared code (both modes) [EXISTING - expand]
│   ├── agent/                  # BrowserxAgent, Session, TurnManager [MOVE from src/core/]
│   ├── channels/               # NEW: ChannelAdapter, ChannelManager
│   │   ├── ChannelAdapter.ts   # Interface definition
│   │   ├── ChannelManager.ts   # Routing orchestrator
│   │   └── index.ts            # Factory with build-mode detection
│   ├── storage/                # NEW: Storage abstraction
│   │   ├── StorageProvider.ts  # Interface definition
│   │   ├── index.ts            # Factory
│   │   └── migrations/         # Schema migrations
│   ├── tools/                  # Tool abstractions [EXISTING - refactor]
│   │   ├── browser/            # NEW: BrowserController interface
│   │   │   ├── BrowserController.ts
│   │   │   ├── DebuggerClient.ts
│   │   │   └── index.ts
│   │   └── [existing tools]    # DOMTool, NavigationTool, etc.
│   ├── mcp/                    # [EXISTING - move from src/mcp/]
│   │   ├── MCPClient.ts        # Client wrapper
│   │   ├── MCPManager.ts       # Connection manager
│   │   ├── MCPToolAdapter.ts   # Tool integration
│   │   ├── MCPConfig.ts        # Configuration
│   │   └── transports/         # Transport implementations
│   │       ├── index.ts               # Transport factory (NEW)
│   │       ├── SSEClientTransport.ts  # Remote servers, both modes (existing)
│   │       └── TauriStdioTransport.ts # Local servers, native only (NEW)
│   ├── protocol/               # [EXISTING] Op, EventMsg types
│   ├── models/                 # [EXISTING] LLM client abstractions
│   └── types/                  # [EXISTING] Shared types
│
├── extension/                  # Chrome extension specific [NEW - move from src/]
│   ├── background/             # Service worker [MOVE from src/background/]
│   ├── content/                # Content scripts [MOVE from src/content/]
│   ├── sidepanel/              # Side panel UI [MOVE from src/sidepanel/]
│   ├── channels/               # NEW: Extension channel adapters
│   │   ├── SidePanelChannel.ts
│   │   └── TabPageChannel.ts
│   ├── tools/                  # NEW: Extension-specific tool implementations
│   │   └── browser/
│   │       └── ExtensionBrowserController.ts
│   ├── storage/                # NEW: IndexedDB provider
│   │   └── IndexedDBStorageProvider.ts
│   └── manifest.json           # [EXISTING]
│
├── desktop/                    # Desktop app specific [NEW]
│   ├── main.ts                 # Tauri entry point
│   ├── daemon.ts               # Background service
│   ├── tray.ts                 # System tray logic
│   ├── cli.ts                  # Optional CLI entry
│   ├── platform/               # OS-specific code (Windows/macOS/Linux)
│   │   └── paths.ts            # Chrome/Edge paths, profile locations per OS
│   ├── channels/               # Desktop channel adapters
│   │   ├── TauriChannel.ts
│   │   ├── WebSocketChannel.ts
│   │   └── TelegramChannel.ts  # Future
│   ├── tools/                  # Desktop-specific tools
│   │   ├── browser/
│   │   │   ├── CDPBrowserController.ts
│   │   │   ├── CDPDebuggerClient.ts
│   │   │   ├── ProfileManager.ts  # Uses platform/paths.ts
│   │   │   ├── BrowserDetector.ts # Uses platform/paths.ts
│   │   │   └── ChromeLauncher.ts
│   │   └── terminal/
│   │       ├── TerminalTool.ts
│   │       └── SecurityFilter.ts
│   ├── storage/                # SQLite provider
│   │   └── SQLiteStorageProvider.ts
│   └── ui/                     # Tauri frontend (Svelte)
│       └── [reuse sidepanel components]
│
├── tauri/                      # Tauri Rust backend [NEW]
│   ├── src/
│   │   ├── main.rs
│   │   ├── commands.rs         # General IPC commands
│   │   └── mcp_commands.rs     # MCP stdio process management
│   ├── Cargo.toml
│   └── tauri.conf.json
│
tests/
├── contract/                   # Interface contract tests [EXISTING - expand]
├── integration/                # Cross-module tests [EXISTING - expand]
└── unit/                       # Unit tests [EXISTING]
```

**Structure Decision**: Dual-platform monorepo with shared `src/core/` and platform-specific `src/extension/` and `src/desktop/` directories. Existing code migrates from flat `src/` to appropriate subdirectories. Tauri Rust backend in separate `tauri/` directory at repo root.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Multiple abstraction layers (Browser, Storage, Channel) | Enable code reuse across fundamentally different platforms (browser vs native) | Direct platform code would duplicate ~80% of business logic |
| Tauri + TypeScript hybrid | Tauri provides smallest native bundle + best cross-platform support | Electron rejected for bundle size; pure TS can't access OS APIs |
| Profile-copy fallback strategy | Chrome DevTools MCP not available on all Chrome versions | Single connection method would fail for many users |

## Platform-Specific Code Strategy (Windows/macOS/Linux)

### What Tauri/Libraries Handle

Most cross-platform concerns are abstracted by existing libraries:

| Feature | Handled By |
|---------|------------|
| Window management, system tray, menus | Tauri |
| Global hotkeys | Tauri (auto-maps Cmd↔Ctrl) |
| File dialogs | Tauri |
| Credential storage | `keytar` (Keychain/Credential Manager/libsecret) |
| SQLite | `better-sqlite3` |
| Process spawning | Tauri Rust backend |

### What Needs OS-Specific Code

Only browser/profile paths need OS-specific handling - kept in a single file:

```typescript
// src/desktop/platform/paths.ts
import { platform } from 'os';

const CHROME_PATHS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
  ],
};

const CHROME_PROFILE_PATHS: Record<string, string> = {
  darwin: '~/Library/Application Support/Google/Chrome',
  win32: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
  linux: '~/.config/google-chrome',
};

export const getChromePaths = () => CHROME_PATHS[platform()] ?? CHROME_PATHS.linux;
export const getChromeProfilePath = () => CHROME_PROFILE_PATHS[platform()] ?? CHROME_PROFILE_PATHS.linux;
```

If more OS-specific code is needed later (auto-start, notifications), we can split into subdirectories at that point.

## MCP Integration Strategy

### Current State

MCP client **already exists** at `src/mcp/` with full functionality:

| Component | Description |
|-----------|-------------|
| `MCPClient.ts` | Wraps `@modelcontextprotocol/sdk` with connection lifecycle management |
| `MCPManager.ts` | Singleton managing multiple concurrent MCP server connections |
| `MCPToolAdapter.ts` | Adapts MCP tools for the agent's tool system |
| `MCPConfig.ts` | Configuration schema and validation |
| `SSEClientTransport.ts` | SSE-based transport (browser-compatible) |

### Why TypeScript MCP Works in Desktop Mode

Tauri apps run TypeScript in a webview - the same execution environment as Chrome extensions. This means:

- **Full code reuse**: `MCPClient`, `MCPManager`, `MCPToolAdapter` work unchanged
- **SSE transport works**: Remote MCP servers (HTTP-based) work in both modes
- **No rewrite needed**: Only relocation to `src/core/mcp/` and new transport

### Stdio Transport Architecture

For local MCP servers (spawned as subprocesses), the webview cannot use Node.js `child_process`. Instead, we bridge through Tauri's Rust backend:

```
┌─────────────────────────────────────────────────────────┐
│ TypeScript (Tauri Webview)                              │
│                                                         │
│  MCPClient                                              │
│     ↓                                                   │
│  StdioTransport (implements Transport interface)        │
│     ↓                                                   │
│  invoke('mcp_spawn', { server, args })                  │
│  invoke('mcp_send', { sessionId, message })             │
│  listen('mcp_message', callback)                        │
└───────────────────────┬─────────────────────────────────┘
                        │ Tauri IPC (JSON messages)
┌───────────────────────▼─────────────────────────────────┐
│ Rust (Tauri Backend - tauri/src/mcp_commands.rs)        │
│                                                         │
│  #[tauri::command]                                      │
│  fn mcp_spawn(server: String, args: Vec<String>)        │
│     → std::process::Command::new(server)                │
│     → spawn with stdin/stdout pipes                     │
│     → return session_id                                 │
│                                                         │
│  #[tauri::command]                                      │
│  fn mcp_send(session_id: String, message: String)       │
│     → write to child stdin                              │
│                                                         │
│  Background thread:                                     │
│     → read from child stdout                            │
│     → emit 'mcp_message' event to webview               │
└─────────────────────────────────────────────────────────┘
```

### Transport Selection

```typescript
// In src/core/mcp/transports/index.ts
export function createTransport(config: MCPServerConfig): Transport {
  if (config.transport === 'sse') {
    return new SSEClientTransport(config.url);
  } else if (config.transport === 'stdio') {
    if (__BUILD_MODE__ === 'extension') {
      throw new Error('Stdio transport not available in extension mode');
    }
    // Desktop mode: use Tauri IPC to spawn MCP server processes
    return new TauriStdioTransport(config.command, config.args);
  }
}
```

### Work Required

| Task | Effort | Description |
|------|--------|-------------|
| Move to `src/core/mcp/` | Low | Relocate existing code, update imports |
| `TauriStdioTransport.ts` | Medium | TypeScript transport calling Tauri commands |
| `mcp_commands.rs` | Medium | Rust commands for process spawn/management |
| Config integration | Low | Read MCP servers from `~/.pi/config.yaml` |

## Implementation Phases

### Phase 1: Code Restructuring (P0 - Foundation)

**Goal**: Reorganize codebase without breaking existing extension

1. Create new directory structure (`src/core/`, `src/extension/`)
2. Move existing shared code to `src/core/`
3. Move extension-specific code to `src/extension/`
4. Update all import paths
5. Configure Vite for extension build from new structure
6. Verify extension builds and all tests pass

**Risk**: Low - no functionality changes, purely organizational

### Phase 2: Abstraction Interfaces (P1 - Architecture)

**Goal**: Define interfaces that work for both modes

1. Define `ChannelAdapter` interface
2. Define `ChannelManager` orchestrator
3. Define `BrowserController` interface
4. Define `DebuggerClient` interface
5. Define `StorageProvider` interface
6. Implement extension-side adapters (wrap existing code)
7. Refactor `MessageRouter` to use `ChannelManager`
8. Refactor `DomService` to use `DebuggerClient`

**Risk**: Medium - refactoring core functionality

### Phase 3: Native Infrastructure (P1 - Tauri Shell)

**Goal**: Create native app entry points

1. Initialize Tauri project
2. Create basic Tauri frontend (reuse Svelte components)
3. Implement `TauriChannel` adapter
4. Implement system tray with basic menu
5. Implement global hotkey support
6. Configure build for Windows/macOS/Linux

**Risk**: Medium - new technology (Tauri), but isolated

### Phase 4: Native Browser Control (P2)

**Goal**: Implement CDP browser control with fallback chain

1. Implement Chrome DevTools MCP auto-connect
2. Implement debug port detection (localhost:9222)
3. Implement `ProfileManager` for profile copy
4. Implement `BrowserDetector` for multi-browser support
5. Implement `ChromeLauncher` with debugging flags
6. Implement `CDPBrowserController` with puppeteer-core
7. Implement `CDPDebuggerClient`
8. Implement graceful degradation mode

**Risk**: Medium - multiple fallback paths to test

### Phase 5: Native Storage & Tools (P2)

**Goal**: Implement native-specific providers and tools

1. Implement `SQLiteStorageProvider`
2. Implement credential storage via keytar
3. Implement `TerminalTool` with security filters
4. Implement `WebSocketChannel` with auth
5. MCP integration for native mode (see [MCP Integration Strategy](#mcp-integration-strategy))
   - Move existing `src/mcp/` to `src/core/mcp/`
   - Implement `TauriStdioTransport.ts` (TypeScript side)
   - Implement `mcp_commands.rs` (Rust process management)
   - Add transport factory with build-mode detection
   - Integrate MCP server config from `~/.pi/config.yaml`

**Risk**: Medium - security-sensitive components

### Phase 6: Integration & Polish (P2-P3)

**Goal**: End-to-end testing and refinement

1. Integration tests for both build modes
2. E2E tests for native app
3. Cross-platform testing (CI)
4. Performance optimization
5. Documentation

**Risk**: Low - validation and refinement
