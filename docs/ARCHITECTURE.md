# WorkX Architecture

WorkX is a tri-platform AI agent built from a shared core with platform-specific adapters for Chrome extensions, desktop (Tauri), and headless server (Node.js).

## Platform Overview

| App | Platform | Entry Point | Channel | Build |
|-----|----------|-------------|---------|-------|
| **WorkX** | Chrome Extension | `src/extension/background/service-worker.ts` | `SidePanelChannel` / `TabPageChannel` (chrome.runtime) | `vite.config.mjs` |
| **WorkX** | Desktop (Tauri) | `src/desktop/main.ts` | `TauriChannel` (Tauri events) | `vite.config.desktop.mts` |
| **WorkX Server** | Headless (Node.js) | `src/server/index.ts` | `ServerChannel` (WebSocket) | `vite.config.server.mts` |

## High-Level Diagram

```
                     ┌─────────────────────────────┐
                     │         src/core/            │
                     │   RepublicAgent · ToolRegistry │
                     │   MCPManager · ApprovalGate  │
                     │   ChannelManager · Models    │
                     └──────┬──────┬──────┬─────────┘
                            │      │      │
              ┌─────────────┘      │      └──────────────┐
              │                    │                      │
     ┌────────▼────────┐ ┌────────▼────────┐  ┌──────────▼──────────┐
     │   Extension      │ │    Desktop      │  │      Server         │
     │   chrome.runtime │ │    Tauri IPC    │  │      WebSocket      │
     │   IndexedDB      │ │    OS Keychain  │  │      SQLite         │
     │   SSE MCP        │ │    Rust MCP     │  │      Node MCP       │
     └─────────────────┘ └─────────────────┘  └─────────────────────┘
```

## Shared Core (`src/core/`)

The core module is platform-agnostic and shared across all three builds:

| Module | Purpose |
|--------|---------|
| `RepublicAgent.ts` | Main agent class — session, turn management, tool execution |
| `Session.ts` | Conversation session lifecycle |
| `TurnManager.ts` | Multi-turn reasoning loop |
| `approval/` | Approval gate, policy engine, risk assessors |
| `channels/` | `ChannelAdapter` interface, `ChannelManager` routing |
| `mcp/` | `MCPManager` singleton, adapters, config, tool registration |
| `models/` | Model client factory (OpenAI, Google, etc.) |
| `storage/` | Storage interfaces (`ConfigStorageProvider`, `StorageProvider`, `CredentialStore`) |
| `tools/` | `ToolRegistry`, `ToolRunner`, shared tool implementations |
| `i18n.ts` | Platform-agnostic `t()` passthrough (core never depends on webfront i18n) |

## Platform Abstractions

Each platform provides concrete implementations of these interfaces:

| Abstraction | Extension | Desktop | Server |
|---|---|---|---|
| **ChannelAdapter** | `SidePanelChannel`, `TabPageChannel` | `TauriChannel` | `ServerChannel` (WebSocket) |
| **ConfigStorageProvider** | `ChromeConfigStorage` (chrome.storage) | `TauriConfigStorage` (Rust IPC) | `FileConfigStorageProvider` (JSON file) |
| **RolloutStorageProvider** | `IndexedDBRolloutStorageProvider` | `TauriRolloutStorageProvider` (Rust SQLite) | `TSRolloutStorageProvider` (better-sqlite3) |
| **CredentialStore** | `ChromeCredentialStore` (chrome.storage) | `KeytarCredentialStore` (OS keychain) | config.json / env vars |
| **IMCPClientAdapter** | `MCPClient` (SSE) | `RustMCPBridge` (Tauri stdio) | `NodeMCPBridge` (child_process) + `MCPClient` (SSE) |
| **MessageRouter** | Default (chrome.runtime) | `DesktopMessageRouter` | `ServerMessageRouter` |
| **Bootstrap** | `SessionManager` in service worker | `ServerAgentBootstrap` desktop-runtime profile | `ServerAgentBootstrap` |

## Durable multi-thread lifecycle

All platforms construct agents through `SessionManager` and a platform-owned
`AgentAssembler`. Extension and desktop keep conversations durable while live graphs are
hydrated and suspended on demand; headless server keeps eager construction. The
`thread_index` store is the UI list/search source, while rollout storage is the durable
conversation source. Agent events pass through the manager's per-session sequence/replay
gate before `ChannelManager` broadcasts them.

The webfront holds a single `threadStore` projection containing index metadata, runtime
state, conversation buffers, replay cursors, pending correlated submissions, and browser
attention. It persists only the selected session ID locally.

## Build System

### `__BUILD_MODE__` Compile-Time Constant

All platform branching uses the `__BUILD_MODE__` global, set by Vite at build time:

```typescript
declare const __BUILD_MODE__: 'extension' | 'desktop' | 'server' | 'mobile';
```

Vite replaces this with a string literal, enabling dead-code elimination. Each build output contains only its platform's code:

```typescript
// CORRECT — Vite eliminates dead branch + its dynamic imports
if (__BUILD_MODE__ === 'server') {
  const { NodeMCPBridge } = await import('@/server/mcp/NodeMCPBridge');
  return new NodeMCPBridge(config);
}

// WRONG — runtime check, Vite bundles both branches
if (this.platform === 'server') { ... }
```

### Build Configurations

| Config | Target | Output | Define |
|--------|--------|--------|--------|
| `vite.config.mjs` | Extension (Chrome) | `dist/background.js`, `dist/sidepanel.js` | `__BUILD_MODE__ = 'extension'` |
| `vite.config.content.mjs` | Content script | `dist/content.js` (IIFE) | `__BUILD_MODE__ = 'extension'` |
| `vite.config.desktop.mts` | Desktop (Tauri WebView) | `dist/desktop/main.js` | `__BUILD_MODE__ = 'desktop'` |
| `vite.config.server.mts` | Server (Node.js 22+) | `dist/server/index.mjs` (ESM) | `__BUILD_MODE__ = 'server'` |

### TypeScript Configs

| Config | Scope |
|--------|-------|
| `tsconfig.json` | Base — extension + desktop |
| `tsconfig.server.json` | Server only (excludes `src/extension`, `src/webfront`, `src/desktop`) |

## Agent Bootstrap Sequence

All platforms follow the same initialization pattern:

```
1. Config Storage Setup (platform-specific provider)
2. AgentConfig Initialization
3. RepublicAgent Creation
4. PromptComposer Configuration (system prompt, platform context)
5. Channel Creation & Registration (ChannelManager)
6. Event Forwarding (agent → ChannelManager → channel → UI/client)
7. Agent Initialization (model client, tool registration)
8. Platform-Specific Setup
   - Extension: Content script injection, tab listeners
   - Desktop: MCP registration, skills, approval gate, auth restore
   - Server: Persistence (SessionIndex, TranscriptStore), plugins, health monitor
9. Ready
```

## Storage Architecture

### Rollout Recording (Conversation Persistence)

Factory: `src/storage/rollout/provider/createRolloutStorageProvider.ts`

```typescript
if (__BUILD_MODE__ === 'desktop')   → TauriRolloutStorageProvider  // Rust → SQLite
if (__BUILD_MODE__ === 'server')    → TSRolloutStorageProvider      // better-sqlite3
if (__BUILD_MODE__ === 'extension') → IndexedDBRolloutStorageProvider
throw Error(`Unsupported: ${__BUILD_MODE__}`)  // no fallthrough
```

Desktop and server use the same SQLite schema (defined in `tauri/src/rollout_db.rs` and `TSRolloutStorageProvider` respectively). Extension uses IndexedDB.

### Config Storage

- Extension: `chrome.storage.local`
- Desktop: Tauri storage commands (Rust backend)
- Server: `FileConfigStorageProvider` — reads/writes `$WORKX_DATA_DIR/config-storage.json`

## MCP (Model Context Protocol)

`MCPManager` is a singleton that manages MCP server connections and tool discovery.

### Transport Selection

```
MCPManager.createAdapter(config)
  ├── config.transport === 'stdio'
  │   ├── __BUILD_MODE__ === 'server'  → NodeMCPBridge (child_process.spawn)
  │   └── else                          → RustMCPBridge (Tauri IPC → Rust)
  └── config.transport === 'sse' | 'streamable-http'
      └── MCPClient (SSE / Streamable HTTP via MCP SDK)
```

### Platform Scopes

MCP servers are scoped to platforms: `'shared'` | `'extension'` | `'desktop'` | `'server'`. Each platform only sees servers matching its scope plus `'shared'`.

### Tool Registration Flow

```
MCPManager connects to server → discovers tools → registerMCPTools()
  → creates tool wrappers (prefixed as "server:toolname")
  → registers with ToolRegistry
  → tools available to RepublicAgent
```

## Server Mode Architecture

```
                    Client (WS)
                        │
                    ┌───▼───┐
                    │ HTTP/ │
                    │ HTTPS │  ← TLS optional
                    │ + WS  │
                    └───┬───┘
                        │
               ┌────────▼────────┐
               │   Handshake     │  ← HMAC-SHA256 challenge/response
               │   + Auth        │  ← token/password/trusted-proxy
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │  Rate Limiter   │  ← Per-method limits
               │  + Watchdog     │  ← Connection tracking, stale cleanup
               └────────┬────────┘
                        │
               ┌────────▼────────┐
               │ Method Dispatch │  ← chat.send, session.list, tools.list, ...
               └────────┬────────┘
                        │
          ┌─────────────┼─────────────┐
          │             │             │
   ┌──────▼──────┐ ┌───▼────┐ ┌─────▼──────┐
   │ RepublicAgent     │ │Session │ │ Health     │
   │ (core)      │ │Index   │ │ Monitor    │
   │             │ │(SQLite)│ │ CPU/Mem/EL │
   └──────┬──────┘ └────────┘ └────────────┘
          │
    ┌─────┼──────────────┐
    │     │              │
┌───▼──┐ ┌▼────────┐ ┌──▼──────────┐
│Plan  │ │Web      │ │Browser      │
│Tool  │ │Search   │ │(MCP)        │
│      │ │Tool     │ │             │
└──────┘ └─────────┘ └──┬──────────┘
                        │
              ┌─────────▼─────────────┐
              │ Chrome Connection     │
              │                       │
              │ CHROME_REMOTE_URL  ───┼→ Remote (K8s pool/sidecar)
              │ CHROME_WS_ENDPOINT ───┼→ Remote (WebSocket)
              │ CHROME_BIN / detect ──┼→ Local headless Chrome
              │ (none) ──────────────┼→ Graceful degradation
              └───────────────────────┘
```

### Server Source Layout

```
src/server/
├── index.ts                 # HTTP/WS server entry point
├── agent/                   # ServerAgentBootstrap, graceful shutdown
├── auth/                    # Authorization & role-based scopes
├── channels/                # ServerChannel, ServerMessageRouter
├── config/                  # Zod-validated config with hot-reload
├── connection/              # Handshake, watchdog, rate limiting
├── exec/                    # Tool approval queue
├── handlers/                # Method handlers (chat, sessions, tools, config, health, logs)
├── health/                  # CPU/memory/event-loop monitoring, log streaming
├── limits/                  # Connection & payload enforcement
├── mcp/                     # NodeMCPBridge (stdio MCP via child_process)
├── persistence/             # SessionIndex, TranscriptStore (SQLite), backup
├── plugins/                 # Plugin discovery, registration, channel bridge
├── protocol/                # Frame schemas (Zod), method dispatch, error codes
├── storage/                 # FileConfigStorageProvider (JSON file)
├── streaming/               # Chat delta streaming, agent event conversion
└── tools/                   # Planning, web search, browser tool registration
```

### WebSocket Protocol

Clients connect via WebSocket and communicate using JSON request/response frames.

**Connection flow:**
1. Client connects via WebSocket
2. Server sends HMAC-SHA256 challenge (if auth enabled)
3. Client responds with signed challenge
4. Bidirectional JSON messaging begins

**Available methods:** `chat.send`, `session.list`, `session.get`, `session.delete`, `tools.list`, `config.get`, `config.set`, `health.get`, `exec.approve`, `logs.subscribe`

### Browser Automation

WorkX Server connects to Chrome via `chrome-devtools-mcp` MCP server. Three deployment patterns:

| Pattern | Env Var | Use Case |
|---------|---------|----------|
| **Bundled** | `CHROME_BIN` (auto-detected) | Single container, simplest setup |
| **Remote HTTP** | `CHROME_REMOTE_URL=http://host:port` | Browserless, Chrome sidecar, shared pool |
| **Remote WebSocket** | `CHROME_WS_ENDPOINT=ws://host:port` | Direct CDP WebSocket connection |

If no Chrome is available, the server gracefully degrades — planning and web search remain functional.

## Project Structure

```
src/
├── core/                    # Shared agent runtime (all platforms)
│   ├── RepublicAgent.ts     # Main agent class
│   ├── Session.ts           # Conversation session
│   ├── TurnManager.ts       # Multi-turn reasoning
│   ├── i18n.ts              # Platform-agnostic t() passthrough
│   ├── approval/            # Approval gate & policy engine
│   ├── channels/            # Channel abstraction (ChannelAdapter, ChannelManager)
│   ├── mcp/                 # MCPManager, RustMCPBridge, MCPClient, MCPToolAdapter
│   ├── models/              # Model client factory & implementations
│   ├── storage/             # Storage interfaces & initialization
│   └── tools/               # ToolRegistry, ToolRunner
│
├── extension/               # Chrome extension platform
│   ├── background/          # Service worker (agent entry point)
│   ├── content/             # Content scripts (DOM tool injection)
│   ├── storage/             # ChromeConfigStorage, ChromeCredentialStore
│   └── _locales/            # i18n (50+ languages)
│
├── desktop/                 # Desktop platform (Tauri)
│   ├── agent/               # DesktopAgentBootstrap
│   ├── storage/             # TauriConfigStorage, KeytarCredentialStore
│   └── tools/               # Desktop-specific tools (terminal, etc.)
│
├── server/                  # Headless server platform
│   ├── agent/               # ServerAgentBootstrap, shutdown
│   ├── channels/            # ServerChannel (WebSocket), ServerMessageRouter
│   ├── config/              # Zod-validated server config
│   ├── connection/          # Handshake, watchdog, rate limiting
│   ├── handlers/            # Method handlers
│   ├── health/              # Health monitoring, log streaming
│   ├── mcp/                 # NodeMCPBridge (stdio via child_process)
│   ├── persistence/         # SessionIndex, TranscriptStore (SQLite), backup
│   ├── plugins/             # Plugin system
│   ├── protocol/            # Frame schemas, method dispatch, errors
│   ├── storage/             # FileConfigStorageProvider
│   ├── streaming/           # Chat streaming, agent event conversion
│   └── tools/               # Server tool registration
│
├── storage/                 # Shared storage abstractions
│   └── rollout/             # RolloutRecorder + platform providers
│       └── provider/        # IndexedDB, Tauri, TS (better-sqlite3)
│
├── tools/                   # Shared tool implementations
├── prompts/                 # LLM system prompts
├── webfront/                # Web UI (Svelte components, stores)
├── config/                  # AgentConfig, constants, defaults
├── types/                   # Global type declarations (globals.d.ts)
└── utils/                   # Shared utilities

tauri/                       # Tauri Rust backend (desktop only)
scripts/                     # Build & i18n scripts
tests/                       # E2E tests
docs/                        # Documentation
```

## Server Mode Credential Storage

Server mode uses `FileCredentialStore` (AES-256-GCM encrypted file) for secure API key persistence.

### How Credentials Are Stored

- **Encryption:** AES-256-GCM with scrypt key derivation from `VITE_VAULT_SECRET`
- **File location:** `$WORKX_DATA_DIR/credentials.enc`
- **Key format:** Each credential is stored as `service:account` → encrypted value

### Setup

1. Generate a vault secret:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
2. Pass it to the server:
   ```bash
   # Docker
   docker run -e VITE_VAULT_SECRET=<your-secret> ...

   # docker-compose — set in .env file
   VITE_VAULT_SECRET=<your-secret>
   ```

### API Methods

| Method | Scope | Description |
|--------|-------|-------------|
| `credentials.list` | `credentials.read` | List providers with `hasKey` boolean (no secrets exposed) |
| `credentials.set` | `credentials.write` | Store an API key for a provider (requires TLS or loopback) |
| `credentials.delete` | `credentials.write` | Remove an API key for a provider (requires TLS or loopback) |

### Security Model

- **Scopes:** `credentials.read` and `credentials.write` are granted only to the `operator` role
- **Transport:** `credentials.set` and `credentials.delete` require TLS or loopback connection to prevent plaintext key transmission
- **No key exposure:** `credentials.list` returns metadata only (`id`, `name`, `hasKey`) — never the actual key
- **Audit logging:** All set/delete operations are logged with connection ID (visible via `logs.tail`)

### Graceful Degradation

If `VITE_VAULT_SECRET` is not set, the server starts normally with a warning. Credential operations log a warning but do not error — the server remains functional for non-credential features.
