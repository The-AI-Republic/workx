# Enable External-Facing Agent — Implementation Design

**Status:** Ready to implement
**Date:** 2026-03-16
**Decision:** Monorepo, Path A (clean core first, then build agent)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [Architecture](#3-architecture)
4. [Phase 1: Core Extraction Refactoring](#4-phase-1-core-extraction-refactoring)
5. [Phase 2: Monorepo Setup](#5-phase-2-monorepo-setup)
6. [Phase 3: DigitalMe Agent Implementation](#6-phase-3-digitalme-agent-implementation)
7. [DigitalMe Platform Protocol Specification](#7-digitalme-platform-protocol-specification)
8. [Security Model](#8-security-model)
9. [Data Model](#9-data-model)
10. [Configuration](#10-configuration)
11. [Deployment](#11-deployment)
12. [Testing Strategy](#12-testing-strategy)
13. [Migration Checklist](#13-migration-checklist)

---

## 1. Overview

BrowserX is a tri-platform personal AI assistant (Chrome extension, desktop, headless server). We are building a second product — **digitalme-agent** — an external-facing AI agent that creators deploy behind the DigitalMe platform so fans can interact with creator-controlled AI personas.

The two products share a common agent engine (model clients, turn management, tool execution, streaming) but differ fundamentally in trust model, session management, and transport protocol.

This document specifies how to:

1. Extract the shared engine from BrowserX into `@browserx/core`
2. Set up a monorepo with npm workspaces
3. Build the digitalme-agent as a new package consuming the shared core

### Why monorepo, not separate repos

- **Shared engine improvements flow automatically** — new model providers, streaming fixes, MCP updates benefit both products in one PR.
- **Boundary isn't proven yet** — we'll discover what belongs in core vs. shell as we build. Monorepo makes moves trivial; cross-repo moves require publish cycles.
- **Forks rot** — duplicated code never converges back. Every bug fix becomes two patches.
- **Workspace infrastructure exists** — `packages/ws-server` already works as a workspace package.

### Why Path A (clean core first), not Path B (build agent first, converge later)

- Duplicated code accumulates tech debt that never gets paid down.
- The refactoring (removing platform code from core) is good hygiene regardless — `chrome.tabs` calls in core is a design smell.
- DigitalMe provides the forcing function to do it now.

---

## 2. Goals & Non-Goals

### Goals

- Extract a platform-agnostic `@browserx/core` package from the existing codebase
- Build `digitalme-agent` that implements the DigitalMe platform agent endpoint protocol
- Support per-fan conversation isolation with creator-controlled tool access
- Enable creators to deploy agents via Docker with minimal configuration
- Maintain full BrowserX functionality (extension, desktop, server) after extraction

### Non-Goals

- Rewriting BrowserX — this is a refactor + extraction, not a rewrite
- Building a UI for digitalme-agent — the DigitalMe mobile app IS the UI
- Supporting non-DigitalMe protocols in digitalme-agent (generic REST API, etc.)
- Merging BrowserX server mode and digitalme-agent into one binary

---

## 3. Architecture

### Target monorepo structure

```
browserx/
├── packages/
│   ├── core/                         # @browserx/core — shared agent engine
│   │   ├── src/
│   │   │   ├── agent/                # RepublicAgent, TaskRunner, QueueProcessor
│   │   │   ├── session/              # Session, SessionState, ActiveTurn, TurnManager
│   │   │   ├── models/               # ModelClientFactory, all provider clients
│   │   │   ├── tools/                # ToolRegistry, BaseTool (abstractions)
│   │   │   ├── channels/             # ChannelAdapter, ChannelManager (interfaces)
│   │   │   ├── protocol/             # Op, Event, ResponseItem, schemas, guards
│   │   │   ├── mcp/                  # MCPManager (platform-agnostic parts)
│   │   │   ├── storage/              # Abstract providers (interfaces only)
│   │   │   ├── approval/             # Risk assessment framework
│   │   │   ├── streaming/            # StreamProcessor, delta handling
│   │   │   ├── compact/              # History compaction
│   │   │   ├── config/               # AgentConfig, types, defaults
│   │   │   ├── prompts/              # PromptComposer
│   │   │   ├── types/                # Shared type definitions
│   │   │   ├── utils/                # Shared utilities
│   │   │   └── platform/             # Platform abstraction interfaces (NEW)
│   │   │       ├── TabProvider.ts
│   │   │       ├── NotificationProvider.ts
│   │   │       ├── MCPBridgeProvider.ts
│   │   │       └── StorageProviderFactory.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── browserx/                     # BrowserX — personal assistant
│   │   ├── src/
│   │   │   ├── extension/            # Chrome extension shell
│   │   │   ├── desktop/              # Tauri desktop shell
│   │   │   ├── server/               # WebSocket server shell
│   │   │   ├── tools/                # Browser tools (DOM, CDP, screenshots)
│   │   │   ├── webfront/             # Svelte UI
│   │   │   └── platform/             # Platform interface implementations
│   │   │       ├── ChromeTabProvider.ts
│   │   │       ├── ChromeNotificationProvider.ts
│   │   │       ├── TauriMCPBridge.ts
│   │   │       ├── RustMCPBridge.ts
│   │   │       └── storage/          # IndexedDB, Tauri, SQLite providers
│   │   ├── package.json              # depends on @browserx/core
│   │   └── tsconfig.json
│   │
│   ├── digitalme-agent/              # DigitalMe — external-facing agent (NEW)
│   │   ├── src/
│   │   │   ├── server/               # HTTP server (REST+SSE)
│   │   │   │   ├── index.ts          # Entry point
│   │   │   │   ├── routes/           # DigitalMe protocol endpoints
│   │   │   │   │   ├── health.ts
│   │   │   │   │   ├── verify.ts
│   │   │   │   │   └── conversations.ts
│   │   │   │   └── middleware/
│   │   │   │       ├── hmac-auth.ts
│   │   │   │       └── rate-limit.ts
│   │   │   ├── auth/                 # HMAC-SHA256 verification
│   │   │   │   └── hmac.ts
│   │   │   ├── conversations/        # Per-fan session management
│   │   │   │   ├── ConversationManager.ts
│   │   │   │   ├── FanSessionAdapter.ts
│   │   │   │   └── types.ts
│   │   │   ├── persona/              # Creator persona configuration
│   │   │   │   ├── PersonaConfig.ts
│   │   │   │   └── PersonaPromptComposer.ts
│   │   │   ├── safety/               # Fan input/output filtering
│   │   │   │   ├── InputFilter.ts
│   │   │   │   ├── OutputFilter.ts
│   │   │   │   └── ToolAllowlist.ts
│   │   │   ├── streaming/            # SSE response streaming
│   │   │   │   └── SSEStreamAdapter.ts
│   │   │   ├── storage/              # Fan-scoped persistence
│   │   │   │   ├── ConversationStore.ts
│   │   │   │   └── SQLiteProvider.ts
│   │   │   └── platform/             # Platform interface implementations
│   │   │       ├── NoOpTabProvider.ts
│   │   │       ├── NoOpNotificationProvider.ts
│   │   │       └── NodeMCPBridge.ts
│   │   ├── config.example.yaml
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   ├── package.json              # depends on @browserx/core
│   │   └── tsconfig.json
│   │
│   └── ws-server/                    # @applepi/ws-server (existing)
│
├── package.json                      # workspaces: ["packages/*"]
├── tsconfig.base.json                # shared TS config
└── turbo.json                        # build orchestration (optional)
```

### Dependency graph

```
@browserx/core (no platform dependencies)
    ▲                    ▲
    │                    │
packages/browserx    packages/digitalme-agent
(chrome, tauri,      (REST+SSE, HMAC auth,
 node platform       fan isolation,
 implementations)    persona config)
```

Core depends on nothing platform-specific. Both shells depend on core and provide their own platform implementations via dependency injection.

---

## 4. Phase 1: Core Extraction Refactoring

Before extracting `@browserx/core`, we must remove all platform-specific code from `src/core/`. This phase modifies the existing codebase in-place — no file moves yet.

### 4.1 Create platform abstraction interfaces

Create new file: `src/core/platform/types.ts`

```typescript
/**
 * Platform abstraction interfaces.
 * Core depends on these interfaces. Each platform provides implementations.
 */

export interface TabProvider {
  getTab(tabId: number): Promise<TabInfo | null>;
  queryActiveTabs(): Promise<TabInfo[]>;
  groupTabs(tabIds: number[], options?: TabGroupOptions): Promise<number>;
  ungroupTabs(tabIds: number[]): Promise<void>;
}

export interface NotificationProvider {
  create(id: string, options: NotificationOptions): Promise<void>;
  clear(id: string): Promise<void>;
  update(id: string, options: Partial<NotificationOptions>): Promise<void>;
  onClicked(callback: (id: string) => void): void;
}

export interface MCPBridgeFactory {
  createBridge(config: MCPBridgeConfig): MCPBridge;
}

export interface StorageProviderFactory {
  createStorageProvider(): Promise<StorageProvider>;
  createCredentialStore(): Promise<CredentialStore>;
  createConfigStorage(): Promise<ConfigStorage>;
  createRolloutStorageProvider(): Promise<RolloutStorageProvider>;
}

export interface PlatformContext {
  readonly platformType: 'extension' | 'desktop' | 'server' | 'digitalme';
  readonly tabProvider: TabProvider;
  readonly notificationProvider: NotificationProvider;
  readonly mcpBridgeFactory: MCPBridgeFactory;
  readonly storageProviderFactory: StorageProviderFactory;
}

/** No-op defaults for platforms that don't need certain features */
export class NoOpTabProvider implements TabProvider {
  async getTab(): Promise<null> { return null; }
  async queryActiveTabs(): Promise<TabInfo[]> { return []; }
  async groupTabs(): Promise<number> { return -1; }
  async ungroupTabs(): Promise<void> {}
}

export class NoOpNotificationProvider implements NotificationProvider {
  async create(): Promise<void> {}
  async clear(): Promise<void> {}
  async update(): Promise<void> {}
  onClicked(): void {}
}
```

### 4.2 Remove `__BUILD_MODE__` from core (23+ locations)

Each file needs its platform branching replaced with calls to the injected `PlatformContext`.

#### 4.2.1 `src/core/storage/index.ts` (lines 77-165)

**Current:** Three factory functions with `__BUILD_MODE__` switches for StorageProvider, CredentialStore, ConfigStorage.

**Change:** Replace with delegation to `PlatformContext.storageProviderFactory`:

```typescript
// BEFORE
export async function createStorageProvider(): Promise<StorageProvider> {
  if (__BUILD_MODE__ === 'extension') {
    const { IndexedDBStorageProvider } = await import('...');
    return new IndexedDBStorageProvider();
  }
  // ...
}

// AFTER
import { getPlatformContext } from '../platform';

export async function createStorageProvider(): Promise<StorageProvider> {
  return getPlatformContext().storageProviderFactory.createStorageProvider();
}
```

Apply the same pattern for `createCredentialStore()` and `createConfigStorage()`.

#### 4.2.2 `src/core/RepublicAgent.ts` (lines 173, 465, 475, 587, 611)

**Current:** Five `__BUILD_MODE__` checks for:
- Line 173: Agent type selection (`'applepi'` vs `'browserx'`)
- Line 465: Server-mode sentinel tabId
- Line 475: Desktop MCP setup
- Line 587: Extension-only tab validation
- Line 611: Platform-specific tab handling

**Change:** Replace with `PlatformContext`:

```typescript
// BEFORE
const agentType = (__BUILD_MODE__ === 'desktop') ? 'applepi' : 'browserx';

// AFTER
const agentType = this.platformContext.platformType === 'desktop' ? 'applepi' : 'browserx';
```

For tab handling, delegate to `TabProvider`:

```typescript
// BEFORE
if (__BUILD_MODE__ !== 'desktop' && __BUILD_MODE__ !== 'server') {
  // Extension-only tab validation via TabManager
}

// AFTER
const tab = await this.platformContext.tabProvider.getTab(tabId);
if (!tab) {
  // Handle no-tab case (server, digitalme)
}
```

#### 4.2.3 `src/core/messaging/index.ts` (lines 46-53)

**Current:** Transport selection via `__BUILD_MODE__`.

**Change:** Transport must be provided by the platform bootstrap, not selected in core. Make `createTransport()` accept a factory or remove it entirely — each platform creates its own transport and passes it in.

#### 4.2.4 `src/core/mcp/MCPManager.ts` (lines 71-74, 533)

**Current:** Platform detection in constructor, server-specific NodeMCPBridge creation.

**Change:** Accept `MCPBridgeFactory` via constructor injection:

```typescript
// BEFORE
if (__BUILD_MODE__ === 'server') {
  const { NodeMCPBridge } = await import('@/server/mcp/NodeMCPBridge');
  bridge = new NodeMCPBridge(config);
}

// AFTER
bridge = this.mcpBridgeFactory.createBridge(config);
```

#### 4.2.5 `src/core/mcp/transports/index.ts` (line 90)

**Current:** `return __BUILD_MODE__ === 'desktop' ? 'stdio' : 'sse'`

**Change:** Accept default transport type from `PlatformContext`:

```typescript
export function getDefaultTransportType(platformType: string): 'stdio' | 'sse' {
  return platformType === 'desktop' ? 'stdio' : 'sse';
}
```

#### 4.2.6 `src/core/a2a/A2AManager.ts` (lines 72-76)

**Current:** Constructor platform detection with nested ternaries.

**Change:** Accept platform type from `PlatformContext`.

#### 4.2.7 `src/core/PromptLoader.ts` (line 85)

**Current:** `__BUILD_MODE__` check to select default prompt.

**Change:** Accept agent type / prompt selection from `PlatformContext.platformType`.

#### 4.2.8 `src/core/tools/browser/index.ts` (lines 29, 61)

**Current:** `__BUILD_MODE__ === 'extension'` for browser controller creation.

**Change:** Browser controller must be injected, not created by core. The tools/browser module should accept a `DebuggerClient` interface, not create one.

### 4.3 Remove Chrome APIs from core (3 files, 20+ lines)

#### 4.3.1 `src/core/TurnManager.ts` (lines 816-817, 965-967, 980-982)

**Current:** Direct `chrome.tabs.get(tabId)` and `chrome.tabs.query()` calls.

**Change:** Use injected `TabProvider`:

```typescript
// BEFORE
if (tabId && tabId > 0 && typeof chrome !== 'undefined' && chrome.tabs) {
  const tab = await chrome.tabs.get(tabId);
}

// AFTER
const tab = await this.platformContext.tabProvider.getTab(tabId);
```

#### 4.3.2 `src/core/UserNotifier.ts` (lines 92-596)

**Current:** 10+ direct `chrome.notifications.*` calls.

**Change:** Use injected `NotificationProvider`:

```typescript
// BEFORE
chrome.notifications.create(notification.id, chromeOptions, callback);

// AFTER
await this.platformContext.notificationProvider.create(notification.id, options);
```

#### 4.3.3 `src/core/registry/AgentSession.ts` (lines 295-414)

**Current:** 10+ direct `chrome.tabs.*` and `chrome.tabGroups.*` calls.

**Change:** Use injected `TabProvider`:

```typescript
// BEFORE
const groupId = await chrome.tabs.group({ tabIds: this._metadata.tabId });
await chrome.tabGroups.update(groupId, { title, color, collapsed });

// AFTER
const groupId = await this.platformContext.tabProvider.groupTabs([this._metadata.tabId], { title, color, collapsed });
```

### 4.4 Remove Tauri APIs from core (3 files, 10+ lines)

#### 4.4.1 `src/core/messaging/transports/TauriTransport.ts`

**Change:** Move to `packages/browserx/src/platform/`. Core should not contain platform-specific transport implementations. The transport interface stays in core; the Tauri implementation moves out.

#### 4.4.2 `src/core/mcp/RustMCPBridge.ts` (8 Tauri invoke calls)

**Change:** Move to `packages/browserx/src/platform/`. MCPManager uses `MCPBridgeFactory` interface; `RustMCPBridge` is the desktop implementation.

#### 4.4.3 `src/core/mcp/MCPManager.ts` (line 581)

**Change:** Already covered by 4.2.4 — delegate to `MCPBridgeFactory`.

### 4.5 Break circular dependency: config ↔ core

**Current state:**
- `src/config/AgentConfig.ts` imports from `src/core/storage/ConfigStorageProvider`
- `src/config/AgentConfig.ts` imports from `src/core/approval/types`
- `src/core/RepublicAgent.ts`, `Session.ts`, `TurnManager.ts` all import from `src/config/`

**Solution:** Merge `src/config/` into core. Config is small (~5 files) and tightly coupled to core. The circular dependency exists because they're artificially separated.

Move:
- `src/config/AgentConfig.ts` → `src/core/config/AgentConfig.ts`
- `src/config/types.ts` → `src/core/config/types.ts`
- `src/config/defaults.ts` → `src/core/config/defaults.ts`
- `src/config/validators.ts` → `src/core/config/validators.ts`

Update all imports accordingly.

### 4.6 Convert RolloutRecorder to pure dependency injection

**Current:** `RolloutRecorder.getProvider()` calls `createRolloutStorageProvider()` which uses `__BUILD_MODE__`.

**Change:** Remove lazy factory initialization. Require `setProvider()` before any use.

```typescript
// BEFORE (in RolloutRecorder.ts, lines 60-75)
static async getProvider(): Promise<RolloutStorageProvider> {
  if (!RolloutRecorder._provider) {
    if (!RolloutRecorder._providerPromise) {
      RolloutRecorder._providerPromise = createRolloutStorageProvider().then(...)
    }
  }
}

// AFTER
static async getProvider(): Promise<RolloutStorageProvider> {
  if (!RolloutRecorder._provider) {
    throw new Error('RolloutStorageProvider not initialized. Call RolloutRecorder.setProvider() at startup.');
  }
  return RolloutRecorder._provider;
}
```

Each platform bootstrap calls `setProvider()`:
- Extension: `RolloutRecorder.setProvider(new IndexedDBRolloutStorageProvider())` (already does this)
- Desktop: `RolloutRecorder.setProvider(new TauriRolloutStorageProvider())`
- Server: `RolloutRecorder.setProvider(new TSRolloutStorageProvider(dataDir))`
- DigitalMe: `RolloutRecorder.setProvider(new FanConversationStorageProvider(dataDir))`

Delete `src/storage/rollout/provider/createRolloutStorageProvider.ts` entirely.

### 4.7 Move `registerPlatformTools` out of core imports

**Current:** `RepublicAgent.ts` line 21 imports `registerPlatformTools` from `../tools/registerPlatformTools`.

**Change:** `registerPlatformTools` is platform-specific (registers different tools per build mode). It should be called by the platform bootstrap and the resulting `ToolRegistry` passed into `RepublicAgent`.

```typescript
// BEFORE (in RepublicAgent.ts)
import { registerPlatformTools } from '../tools/registerPlatformTools';
// ... later in initialize():
await registerPlatformTools(this.toolRegistry);

// AFTER
// RepublicAgent receives a pre-configured ToolRegistry
constructor(config: AgentConfig, options: AgentOptions) {
  this.toolRegistry = options.toolRegistry; // already has platform tools registered
}
```

### 4.8 Remove `__BUILD_MODE__` from `src/config/AgentConfig.ts`

**Current:** Line 76 checks `__BUILD_MODE__ === 'extension'` for approval config migration.

**Change:** After merging config into core (4.5), accept platform type from `PlatformContext`:

```typescript
if (platformContext.platformType === 'extension') {
  await this.migrateApprovalConfig();
}
```

### 4.9 Fix storage/rollout importing from core/title

**Current:** `src/storage/rollout/RolloutRecorder.ts` imports `generatePlaceholderTitle` from `../../core/title`.

**Change:** Move `generatePlaceholderTitle` into the storage/rollout module, or into a shared utils module. It's a pure function with no dependencies — it doesn't need to live in core/title.

### 4.10 Validation

After all refactoring:

- `src/core/` must contain **zero** occurrences of:
  - `__BUILD_MODE__`
  - `chrome.` (browser API)
  - `@tauri-apps`
  - imports from `../extension/`, `../desktop/`, `../server/`
- All existing tests must pass
- All three builds (extension, desktop, server) must work

Run verification:

```bash
# No platform APIs in core
grep -r "__BUILD_MODE__" src/core/ && echo "FAIL" || echo "PASS"
grep -r "chrome\." src/core/ --include="*.ts" | grep -v "// " | grep -v "test" && echo "FAIL" || echo "PASS"
grep -r "@tauri-apps" src/core/ && echo "FAIL" || echo "PASS"

# All tests pass
npm test

# All builds succeed
npm run build:extension
npm run build:desktop
npm run build:server
```

---

## 5. Phase 2: Monorepo Setup

After Phase 1, core is platform-agnostic. Now we move files into the workspace structure.

### 5.1 Create shared TypeScript config

Create `tsconfig.base.json` at repo root:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true
  }
}
```

### 5.2 Create `packages/core/`

```bash
mkdir -p packages/core/src
```

Move files:

```
src/core/**          → packages/core/src/          # Agent engine
src/config/**        → packages/core/src/config/   # Already merged in Phase 1
src/types/**         → packages/core/src/types/
src/utils/**         → packages/core/src/utils/
src/prompts/**       → packages/core/src/prompts/
src/tools/BaseTool.ts        → packages/core/src/tools/BaseTool.ts
src/tools/ToolRegistry.ts    → packages/core/src/tools/ToolRegistry.ts
src/tools/WebSearchTool.ts   → packages/core/src/tools/WebSearchTool.ts
src/storage/rollout/RolloutRecorder.ts    → packages/core/src/storage/rollout/
src/storage/rollout/RolloutWriter.ts      → packages/core/src/storage/rollout/
src/storage/rollout/types.ts              → packages/core/src/storage/rollout/
src/storage/rollout/listing.ts            → packages/core/src/storage/rollout/
src/storage/rollout/cleanup.ts            → packages/core/src/storage/rollout/
src/storage/rollout/helpers.ts            → packages/core/src/storage/rollout/
src/storage/rollout/policy.ts             → packages/core/src/storage/rollout/
src/storage/rollout/provider/RolloutStorageProvider.ts  → packages/core/src/storage/rollout/provider/
src/storage/TokenUsageStore.ts            → packages/core/src/storage/
src/storage/ConfigStorage.ts              → packages/core/src/storage/
src/storage/CacheManager.ts              → packages/core/src/storage/
```

Do NOT move:
- `src/storage/rollout/provider/createRolloutStorageProvider.ts` (deleted in Phase 1)
- `src/storage/rollout/provider/IndexedDBRolloutStorageProvider.ts` → stays in `packages/browserx/`
- `src/storage/rollout/provider/TauriRolloutStorageProvider.ts` → stays in `packages/browserx/`
- `src/storage/rollout/provider/TSRolloutStorageProvider.ts` → stays in `packages/browserx/`

Create `packages/core/package.json`:

```json
{
  "name": "@browserx/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": "./dist/index.js",
    "./*": "./dist/*.js"
  },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run"
  },
  "dependencies": {
    "uuid": "^13.0.0",
    "zod": "^3.23.8"
  },
  "peerDependencies": {
    "openai": "^4.0.0"
  }
}
```

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

### 5.3 Move BrowserX into `packages/browserx/`

Move remaining source:

```
src/extension/**     → packages/browserx/src/extension/
src/desktop/**       → packages/browserx/src/desktop/
src/server/**        → packages/browserx/src/server/
src/tools/**         → packages/browserx/src/tools/     (except what moved to core)
src/webfront/**      → packages/browserx/src/webfront/
src/storage/rollout/provider/{IndexedDB,Tauri,TS}*.ts → packages/browserx/src/storage/
```

Create `packages/browserx/package.json`:

```json
{
  "name": "@browserx/app",
  "version": "0.1.0",
  "type": "module",
  "dependencies": {
    "@browserx/core": "workspace:*",
    "@applepi/ws-server": "workspace:*"
  }
}
```

### 5.4 Update all imports (569 `@/` alias imports across 212 files)

This is the largest mechanical change. Strategy:

1. In `packages/core/`, replace all `@/core/` → relative imports within the package
2. In `packages/core/`, replace `@/config/`, `@/types/`, `@/utils/`, `@/prompts/`, `@/storage/` → relative imports (these are now inside core)
3. In `packages/browserx/`, replace `@/core/` → `@browserx/core`
4. In `packages/browserx/`, keep `@/` aliases for within-package imports, update tsconfig paths

Automate with a codemod script:

```bash
# Example: replace @/core/ imports in packages/browserx/
find packages/browserx/src -name "*.ts" -exec sed -i \
  "s|from '@/core/|from '@browserx/core/|g" {} \;
```

### 5.5 Update Vite configs

Each build target keeps its own vite config but with updated paths:

- `vite.config.mjs` (extension) → `packages/browserx/vite.config.extension.mjs`
- `vite.config.desktop.mts` → `packages/browserx/vite.config.desktop.mts`
- `vite.config.server.mts` → `packages/browserx/vite.config.server.mts`

Key changes in each:
- Update `resolve.alias` to point to new package locations
- Remove `__BUILD_MODE__` from `@browserx/core` bundle (it's no longer used there)
- Keep `__BUILD_MODE__` in `packages/browserx/` build configs for platform bootstrap code

### 5.6 Update build scripts

Update `scripts/build.js` paths from `src/` to `packages/browserx/src/`.

### 5.7 Update test configs

Update `vitest.config.mjs`:

```typescript
resolve: {
  alias: {
    '@browserx/core': resolve(__dirname, 'packages/core/src'),
    '@': resolve(__dirname, 'packages/browserx/src'),
  }
}
```

### 5.8 Validation

```bash
# Workspace resolution works
npm install

# Core builds independently
cd packages/core && npm run build

# All BrowserX builds work
npm run build:extension
npm run build:desktop
npm run build:server

# All tests pass
npm test
```

---

## 6. Phase 3: DigitalMe Agent Implementation

### 6.1 Package setup

Create `packages/digitalme-agent/package.json`:

```json
{
  "name": "@browserx/digitalme-agent",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "digitalme-agent": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -b && vite build",
    "start": "node dist/index.js",
    "dev": "tsx src/server/index.ts"
  },
  "dependencies": {
    "@browserx/core": "workspace:*",
    "better-sqlite3": "^11.0.0",
    "uuid": "^13.0.0",
    "zod": "^3.23.8"
  }
}
```

### 6.2 Server entry point

`packages/digitalme-agent/src/server/index.ts`:

HTTP server (Node.js `http` module or lightweight framework like Hono) exposing:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `POST` | `/verify` | HMAC challenge verification |
| `POST` | `/conversations` | Create conversation |
| `GET` | `/conversations` | List conversations (query: `fan_user_id`) |
| `GET` | `/conversations/:id/messages` | Get message history |
| `POST` | `/conversations/:id/messages` | Send message (SSE stream response) |

All endpoints except `/health` are protected by HMAC-SHA256 middleware.

### 6.3 HMAC authentication

`packages/digitalme-agent/src/auth/hmac.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'crypto';

export function verifyHMAC(
  signingSecret: string,
  timestamp: string,
  body: string,
  receivedSignature: string
): boolean {
  const message = `${timestamp}:${body}`;
  const expected = createHmac('sha256', signingSecret)
    .update(message)
    .digest('hex');

  // Timing-safe comparison
  if (expected.length !== receivedSignature.length) return false;
  return timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(receivedSignature)
  );
}
```

Middleware extracts `X-DigitalMe-Key`, `X-DigitalMe-Signature`, `X-DigitalMe-Timestamp` headers and verifies against stored credentials.

### 6.4 Conversation manager

`packages/digitalme-agent/src/conversations/ConversationManager.ts`:

Maps the DigitalMe conversation model to browserx core sessions:

```typescript
import { RepublicAgent } from '@browserx/core/agent/RepublicAgent';
import { Session } from '@browserx/core/session/Session';

export class ConversationManager {
  private agents: Map<string, RepublicAgent> = new Map(); // conversationId → agent

  async createConversation(fanUserId: string): Promise<string> {
    const conversationId = uuid();
    const agent = new RepublicAgent(this.config, {
      toolRegistry: this.createFanToolRegistry(),
      platformContext: this.platformContext,
    });
    await agent.initialize();
    this.agents.set(conversationId, agent);
    this.store.createConversation(conversationId, fanUserId);
    return conversationId;
  }

  async sendMessage(
    conversationId: string,
    fanUserId: string,
    content: string
  ): AsyncGenerator<SSEEvent> {
    const agent = this.agents.get(conversationId);
    if (!agent) throw new ConversationNotFoundError(conversationId);

    // Safety filter on input
    const filtered = await this.inputFilter.filter(content);
    if (filtered.blocked) throw new InputBlockedError(filtered.reason);

    // Submit to agent
    const op: Op = {
      type: 'UserTurn',
      items: [{ type: 'text', text: filtered.content }],
      tabId: 0,   // No tab concept for digitalme
      approval_policy: 'never',  // Creator pre-approved tools
      sandbox_policy: this.persona.sandboxPolicy,
      model: this.persona.model,
      effort: this.persona.reasoningEffort,
      summary: { enabled: false },
    };

    // Collect events and yield SSE
    yield* this.streamAgentResponse(agent, op);
  }
}
```

### 6.5 Fan session adapter

`packages/digitalme-agent/src/conversations/FanSessionAdapter.ts`:

Adapts browserx sessions for per-fan isolation:

- Each conversation gets its own `RepublicAgent` instance (or pooled for efficiency)
- Session history is scoped to `(fan_user_id, conversation_id)`
- Creator persona prompt is shared, prepended to every session
- Tool registry is creator-configured, same for all fans

### 6.6 SSE stream adapter

`packages/digitalme-agent/src/streaming/SSEStreamAdapter.ts`:

Converts browserx `EventMsg` to DigitalMe SSE format:

```typescript
export function eventToSSE(event: EventMsg): SSEEvent | null {
  switch (event.type) {
    case 'AgentMessageDelta':
      return {
        type: 'text_delta',
        content: event.data.delta,
      };
    case 'TaskComplete':
      return {
        type: 'done',
      };
    case 'Error':
    case 'TaskFailed':
      return {
        type: 'done',
        status: 'error',
      };
    default:
      // Internal events (tool execution, reasoning, etc.) — don't expose to fans
      return null;
  }
}
```

### 6.7 Persona configuration

`packages/digitalme-agent/src/persona/PersonaConfig.ts`:

```typescript
export interface PersonaConfig {
  name: string;
  systemPrompt: string;
  model: string;                        // e.g. 'gpt-4o', 'claude-sonnet-4-6'
  modelProvider: ModelProvider;          // e.g. 'openai', 'anthropic'
  reasoningEffort?: ReasoningEffortConfig;

  // Tool access control
  tools: {
    allowWebSearch: boolean;
    allowBrowser: boolean;              // Sandboxed browser, NOT creator's desktop
    mcpServers?: MCPServerConfig[];     // Creator-approved MCP tools
    customTools?: ToolDefinition[];
  };

  // Safety
  safety: {
    blockedTopics?: string[];
    maxResponseLength?: number;
    outputModeration: boolean;
  };

  // Sandbox policy — enforced for ALL fan interactions
  sandboxPolicy: SandboxPolicy;
}
```

Loaded from `config.yaml`:

```yaml
persona:
  name: "Alice's Digital Self"
  system_prompt: |
    You are Alice's digital representative. You help Alice's fans
    learn about her work, answer questions about her content, and
    assist with general inquiries. You are friendly, knowledgeable,
    and always represent Alice's values.

    You do NOT have access to Alice's personal accounts, files, or
    devices. You cannot make purchases, send messages, or take
    actions on Alice's behalf.
  model: gpt-4o
  model_provider: openai

  tools:
    allow_web_search: true
    allow_browser: false
    mcp_servers:
      - name: alice-knowledge-base
        command: npx
        args: ["-y", "@alice/kb-mcp-server"]

  safety:
    blocked_topics: ["financial advice", "medical advice"]
    max_response_length: 4000
    output_moderation: true

server:
  port: 8080
  hmac:
    api_key: ${DIGITALME_API_KEY}
    signing_secret: ${DIGITALME_SIGNING_SECRET}

storage:
  data_dir: ./data
  max_conversations_per_fan: 10
  message_retention_days: 90
```

### 6.8 Safety layer

`packages/digitalme-agent/src/safety/InputFilter.ts`:

```typescript
export class InputFilter {
  constructor(private config: PersonaConfig['safety']) {}

  async filter(content: string): Promise<FilterResult> {
    // Length check
    if (content.length > 4000) {
      return { blocked: true, reason: 'message_too_long' };
    }

    // Blocked topics
    for (const topic of this.config.blockedTopics ?? []) {
      if (this.matchesTopic(content, topic)) {
        return { blocked: true, reason: `blocked_topic:${topic}` };
      }
    }

    // Prompt injection detection (basic)
    if (this.detectsInjection(content)) {
      return { blocked: true, reason: 'injection_detected' };
    }

    return { blocked: false, content };
  }
}
```

`packages/digitalme-agent/src/safety/ToolAllowlist.ts`:

```typescript
export class ToolAllowlist {
  constructor(private allowed: Set<string>) {}

  createRestrictedRegistry(fullRegistry: ToolRegistry): ToolRegistry {
    const restricted = new ToolRegistry();
    for (const tool of fullRegistry.listTools()) {
      if (this.allowed.has(tool.function?.name ?? '')) {
        restricted.register(tool, fullRegistry.getHandler(tool), fullRegistry.getRiskAssessor(tool));
      }
    }
    return restricted;
  }
}
```

### 6.9 Storage

`packages/digitalme-agent/src/storage/ConversationStore.ts`:

SQLite database with fan-scoped conversation persistence:

```sql
CREATE TABLE conversations (
  conversation_id TEXT PRIMARY KEY,
  fan_user_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  last_message_at TEXT
);

CREATE INDEX idx_conversations_fan ON conversations(fan_user_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id),
  sender_type TEXT NOT NULL,  -- 'fan' | 'agent' | 'system'
  content TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  moderation_state TEXT DEFAULT 'allow',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_conversation ON messages(conversation_id);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event_type TEXT DEFAULT 'token_out',
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 6.10 Platform implementations for core interfaces

`packages/digitalme-agent/src/platform/`:

```typescript
// NoOpTabProvider.ts — digitalme agents don't use tabs
export class NoOpTabProvider implements TabProvider {
  async getTab(): Promise<null> { return null; }
  async queryActiveTabs(): Promise<TabInfo[]> { return []; }
  async groupTabs(): Promise<number> { return -1; }
  async ungroupTabs(): Promise<void> {}
}

// NoOpNotificationProvider.ts — no notifications for headless agent
export class NoOpNotificationProvider implements NotificationProvider {
  async create(): Promise<void> {}
  async clear(): Promise<void> {}
  async update(): Promise<void> {}
  onClicked(): void {}
}

// NodeMCPBridge.ts — reuse server's MCP bridge for stdio MCP servers
// (can be copied/adapted from packages/browserx/src/server/mcp/NodeMCPBridge.ts)

// DigitalMeStorageProviderFactory.ts
export class DigitalMeStorageProviderFactory implements StorageProviderFactory {
  constructor(private dataDir: string) {}

  async createStorageProvider(): Promise<StorageProvider> {
    return new SQLiteStorageProvider(this.dataDir);
  }

  async createCredentialStore(): Promise<CredentialStore> {
    return new FileCredentialStore(path.join(this.dataDir, 'credentials'));
  }

  async createConfigStorage(): Promise<ConfigStorage> {
    return new FileConfigStorage(path.join(this.dataDir, 'config.json'));
  }

  async createRolloutStorageProvider(): Promise<RolloutStorageProvider> {
    return new TSRolloutStorageProvider(this.dataDir);
  }
}
```

---

## 7. DigitalMe Platform Protocol Specification

This is the exact protocol the agent must implement, derived from the platform source code.

### 7.1 Authentication

All requests include three headers:

| Header | Value |
|--------|-------|
| `X-DigitalMe-Key` | API key (64-char URL-safe base64) |
| `X-DigitalMe-Signature` | HMAC-SHA256 hex digest |
| `X-DigitalMe-Timestamp` | Unix timestamp (seconds) |

**Signature computation:**

```
message = "{timestamp}:{request_body}"
signature = HMAC-SHA256(signing_secret, message).hexdigest()
```

For GET requests with no body, use empty string: `"{timestamp}:"`

### 7.2 Endpoints

#### `GET /health`

**Response (200):**

```json
{ "status": "ok" }
```

#### `POST /verify`

**Request body:**

```json
{
  "type": "verification",
  "challenge": "{32-char-urlsafe-base64}"
}
```

**Response (200):**

```json
{
  "challenge": "{echo-same-value}"
}
```

#### `POST /conversations`

**Request body:**

```json
{
  "fan_user_id": "{uuid}"
}
```

**Response (200):**

```json
{
  "id": "{conversation_id}",
  "status": "active"
}
```

#### `GET /conversations?fan_user_id={uuid}`

**Response (200):**

```json
[
  {
    "id": "{conversation_id}",
    "fan_user_id": "{uuid}",
    "status": "active"
  }
]
```

#### `GET /conversations/{conversation_id}/messages`

**Response (200):**

```json
[
  {
    "id": "{message_id}",
    "sender_type": "fan",
    "content": "Hello!",
    "sequence_no": 1,
    "moderation_state": "allow"
  }
]
```

#### `POST /conversations/{conversation_id}/messages`

**Request body:**

```json
{
  "fan_user_id": "{uuid}",
  "content": "Hello!"
}
```

**Response:** `Content-Type: text/event-stream`

```
data: {"type": "text_delta", "content": "Hi"}

data: {"type": "text_delta", "content": " there!"}

data: {"type": "done"}

```

### 7.3 Timeouts and retries

- Platform timeout per request: 12 seconds (`agent_request_timeout_seconds`)
- Platform retries: up to 2 (`agent_max_retries`)
- If all retries fail, connection status set to `offline`

### 7.4 Connection lifecycle

```
pending_verification → (verify success) → active
active → (verify fail / relay fail after retries) → offline
active → (rotate keys) → pending_verification
active → (revoke) → revoked
```

---

## 8. Security Model

### 8.1 Principal separation

| Principal | Role | Trust level |
|-----------|------|-------------|
| **Creator** | Configures agent, defines persona, selects tools | Trusted — full control |
| **Fan** | Sends messages, receives responses | Untrusted — sandboxed |
| **Platform** | Routes messages, enforces rate limits, moderates | Trusted intermediary |

### 8.2 Fan isolation guarantees

1. **No cross-fan data access** — fan A's conversation history is never visible to fan B
2. **No creator resource access** — fan input cannot access creator's filesystem, browser, desktop, or credentials
3. **Tool allowlist** — only creator-approved tools execute; all others are rejected
4. **Input filtering** — fan messages are filtered for injection attacks, blocked topics before reaching the agent
5. **Output filtering** — agent responses are filtered for PII leakage, blocked content before reaching the fan
6. **Sandbox policy** — all fan interactions run under the creator's defined sandbox policy (default: `read-only`)

### 8.3 Tool safety rules

| Tool | BrowserX (personal) | DigitalMe (external) |
|------|---------------------|---------------------|
| Web search | Allowed by default | Allowed if creator enables |
| Browser automation | Full access (user's browser) | **Sandboxed only** — isolated headless browser, no access to creator's sessions |
| File system | User's files | **Blocked** — no file system access |
| Shell commands | Available with approval | **Blocked** |
| MCP tools | User-configured | Creator-configured, fan cannot add |
| Custom tools | User-defined | Creator-defined, fan cannot add |

### 8.4 HMAC verification

The agent must verify every request from the platform:

1. Check `X-DigitalMe-Timestamp` is within acceptable window (e.g., ±300 seconds) to prevent replay attacks
2. Recompute HMAC-SHA256 signature using stored `signing_secret`
3. Compare with `X-DigitalMe-Signature` using timing-safe comparison
4. Check `X-DigitalMe-Key` matches stored `api_key`
5. Reject if any check fails (401)

---

## 9. Data Model

### 9.1 Conversation storage (agent-side)

The agent stores all conversation data locally. The platform only stores routing metadata.

```
data/
├── conversations.db          # SQLite: conversation + message metadata
├── rollouts/                 # Per-conversation agent history (for session resume)
│   ├── {conversation_id_1}.jsonl
│   ├── {conversation_id_2}.jsonl
│   └── ...
├── credentials/              # Encrypted API keys
│   └── credentials.json
└── config.json               # Runtime config cache
```

### 9.2 Creator dashboard queries

The agent should support queries that enable a creator dashboard (future API):

- List all conversations (across all fans)
- List conversations for a specific fan
- Get message count / token usage per fan
- Get total token usage across all fans

---

## 10. Configuration

### 10.1 Config file (`config.yaml`)

```yaml
# DigitalMe Agent Configuration

persona:
  name: "Agent Name"
  system_prompt: |
    Your persona prompt here...
  model: gpt-4o
  model_provider: openai
  reasoning_effort: medium    # low | medium | high (optional)

  tools:
    allow_web_search: true
    allow_browser: false
    mcp_servers: []

  safety:
    blocked_topics: []
    max_response_length: 4000
    output_moderation: true

server:
  port: 8080
  bind: "0.0.0.0"

auth:
  api_key: ${DIGITALME_API_KEY}             # From env var
  signing_secret: ${DIGITALME_SIGNING_SECRET}  # From env var

storage:
  data_dir: ./data
  max_conversations_per_fan: 10
  message_retention_days: 90

model:
  api_key: ${MODEL_API_KEY}                 # LLM provider API key

limits:
  max_concurrent_conversations: 20
  max_message_length: 4000
  rate_limit_per_fan: 20         # messages per minute per fan
```

### 10.2 Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DIGITALME_API_KEY` | Yes | Platform-issued API key |
| `DIGITALME_SIGNING_SECRET` | Yes | Platform-issued signing secret |
| `MODEL_API_KEY` | Yes | LLM provider API key (OpenAI, Anthropic, etc.) |
| `DIGITALME_PORT` | No | Server port (default: 8080) |
| `DIGITALME_DATA_DIR` | No | Data directory (default: ./data) |
| `DIGITALME_CONFIG_PATH` | No | Config file path (default: ./config.yaml) |

### 10.3 Config validation

Use Zod schema (following browserx server pattern):

```typescript
export const DigitalMeConfigSchema = z.object({
  persona: z.object({
    name: z.string().min(1).max(80),
    system_prompt: z.string().min(1),
    model: z.string(),
    model_provider: z.enum(['openai', 'anthropic', 'google-ai-studio', 'groq', 'fireworks', 'together']),
    reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
    tools: z.object({
      allow_web_search: z.boolean().default(true),
      allow_browser: z.boolean().default(false),
      mcp_servers: z.array(MCPServerConfigSchema).default([]),
    }).default({}),
    safety: z.object({
      blocked_topics: z.array(z.string()).default([]),
      max_response_length: z.number().default(4000),
      output_moderation: z.boolean().default(true),
    }).default({}),
  }),
  server: z.object({
    port: z.number().default(8080),
    bind: z.string().default('0.0.0.0'),
  }).default({}),
  auth: z.object({
    api_key: z.string(),
    signing_secret: z.string(),
  }),
  storage: z.object({
    data_dir: z.string().default('./data'),
    max_conversations_per_fan: z.number().default(10),
    message_retention_days: z.number().default(90),
  }).default({}),
  model: z.object({
    api_key: z.string(),
  }),
  limits: z.object({
    max_concurrent_conversations: z.number().default(20),
    max_message_length: z.number().default(4000),
    rate_limit_per_fan: z.number().default(20),
  }).default({}),
});
```

---

## 11. Deployment

### 11.1 Docker

`packages/digitalme-agent/Dockerfile`:

```dockerfile
FROM node:20-slim

WORKDIR /app

# Copy built artifacts
COPY packages/core/dist ./packages/core/dist
COPY packages/core/package.json ./packages/core/
COPY packages/digitalme-agent/dist ./packages/digitalme-agent/dist
COPY packages/digitalme-agent/package.json ./packages/digitalme-agent/
COPY package.json ./

# Install production dependencies
RUN npm install --production --workspace=packages/digitalme-agent

# Create data directory
RUN mkdir -p /app/data

EXPOSE 8080

ENV DIGITALME_DATA_DIR=/app/data
ENV DIGITALME_PORT=8080

CMD ["node", "packages/digitalme-agent/dist/index.js"]
```

`packages/digitalme-agent/docker-compose.yml`:

```yaml
version: '3.8'

services:
  agent:
    build:
      context: ../..
      dockerfile: packages/digitalme-agent/Dockerfile
    ports:
      - "8080:8080"
    environment:
      - DIGITALME_API_KEY=${DIGITALME_API_KEY}
      - DIGITALME_SIGNING_SECRET=${DIGITALME_SIGNING_SECRET}
      - MODEL_API_KEY=${MODEL_API_KEY}
    volumes:
      - agent-data:/app/data
      - ./config.yaml:/app/config.yaml:ro

volumes:
  agent-data:
```

### 11.2 Minimal deployment

For creators who just want to run the agent:

```bash
# 1. Install
npm install -g @browserx/digitalme-agent

# 2. Configure
digitalme-agent init          # Creates config.yaml template

# 3. Set secrets
export DIGITALME_API_KEY="..."
export DIGITALME_SIGNING_SECRET="..."
export MODEL_API_KEY="..."

# 4. Run
digitalme-agent start
```

### 11.3 Health monitoring

The agent exposes `/health` for the platform's periodic checks. Internally it should track:

- Active conversation count
- Memory usage
- Model API latency (last request)
- Error rate (last 5 minutes)

---

## 12. Testing Strategy

### 12.1 Phase 1 tests (core refactoring)

**Goal:** No regressions in existing functionality.

- Run all existing BrowserX tests after each refactoring step
- Add unit tests for new `PlatformContext` interfaces
- Add integration tests verifying DI wiring for each platform bootstrap

### 12.2 Phase 2 tests (monorepo setup)

**Goal:** All builds and tests pass from new locations.

- `packages/core` builds independently and passes its own tests
- `packages/browserx` builds all three targets (extension, desktop, server)
- All existing tests pass with updated imports

### 12.3 Phase 3 tests (digitalme-agent)

**Unit tests:**

- HMAC verification (valid signature, invalid signature, expired timestamp, replay)
- Input filter (blocked topics, injection detection, length limits)
- Output filter (PII detection, blocked content)
- Tool allowlist (allowed tool passes, blocked tool rejected)
- SSE stream adapter (event conversion, null for internal events)
- Conversation store (CRUD operations, fan isolation)
- Config validation (valid config, missing fields, invalid values)

**Integration tests:**

- Full request cycle: `POST /conversations/{id}/messages` → HMAC verify → create session → run agent → stream SSE → persist
- Conversation isolation: two fans, verify no cross-contamination
- Tool execution: creator-allowed tool executes, non-allowed tool rejected
- Session resume: conversation persists across agent restart
- Concurrent conversations: multiple fans chatting simultaneously

**Contract tests (against platform):**

- Verification handshake matches platform expectations
- SSE format matches platform's parser
- Error responses match platform's error handling

---

## 13. Migration Checklist

### Phase 1: Core Extraction Refactoring

- [ ] Create `src/core/platform/types.ts` with `PlatformContext`, `TabProvider`, `NotificationProvider`, `MCPBridgeFactory`, `StorageProviderFactory` interfaces
- [ ] Create `src/core/platform/index.ts` with `setPlatformContext()` / `getPlatformContext()` global accessor
- [ ] Implement `ChromeTabProvider` in `src/extension/platform/`
- [ ] Implement `ChromeNotificationProvider` in `src/extension/platform/`
- [ ] Implement `NoOpTabProvider`, `NoOpNotificationProvider` in `src/core/platform/` (defaults)
- [ ] Refactor `src/core/storage/index.ts` — replace `__BUILD_MODE__` with `StorageProviderFactory`
- [ ] Refactor `src/core/RepublicAgent.ts` — replace 5 `__BUILD_MODE__` checks with `PlatformContext`
- [ ] Refactor `src/core/messaging/index.ts` — remove `__BUILD_MODE__` transport selection
- [ ] Refactor `src/core/mcp/MCPManager.ts` — replace `__BUILD_MODE__` with `MCPBridgeFactory`
- [ ] Refactor `src/core/mcp/transports/index.ts` — replace `__BUILD_MODE__` with platform parameter
- [ ] Refactor `src/core/a2a/A2AManager.ts` — replace `__BUILD_MODE__` with platform parameter
- [ ] Refactor `src/core/PromptLoader.ts` — replace `__BUILD_MODE__` with platform parameter
- [ ] Refactor `src/core/tools/browser/index.ts` — replace `__BUILD_MODE__` with injected factory
- [ ] Refactor `src/core/TurnManager.ts` — replace `chrome.tabs.*` calls (lines 816, 965, 980) with `TabProvider`
- [ ] Refactor `src/core/UserNotifier.ts` — replace `chrome.notifications.*` (10+ calls) with `NotificationProvider`
- [ ] Refactor `src/core/registry/AgentSession.ts` — replace `chrome.tabs.*` / `chrome.tabGroups.*` (10+ calls) with `TabProvider`
- [ ] Move `src/core/messaging/transports/TauriTransport.ts` → `src/desktop/platform/`
- [ ] Move `src/core/mcp/RustMCPBridge.ts` → `src/desktop/platform/`
- [ ] Merge `src/config/` into `src/core/config/`
- [ ] Remove `__BUILD_MODE__` from `AgentConfig.ts`
- [ ] Convert `RolloutRecorder.getProvider()` to require `setProvider()` (remove lazy factory)
- [ ] Delete `src/storage/rollout/provider/createRolloutStorageProvider.ts`
- [ ] Update desktop/server bootstrap to call `RolloutRecorder.setProvider()` explicitly
- [ ] Move `registerPlatformTools` out of core — pass pre-configured `ToolRegistry` to `RepublicAgent`
- [ ] Move `generatePlaceholderTitle` from `core/title` to `storage/rollout` or `utils`
- [ ] Verify: zero `__BUILD_MODE__` in `src/core/`
- [ ] Verify: zero `chrome.*` in `src/core/`
- [ ] Verify: zero `@tauri-apps` in `src/core/`
- [ ] Verify: all tests pass
- [ ] Verify: extension, desktop, server builds succeed

### Phase 2: Monorepo Setup

- [ ] Create `tsconfig.base.json`
- [ ] Create `packages/core/` directory with `package.json`, `tsconfig.json`
- [ ] Move core files to `packages/core/src/`
- [ ] Create `packages/browserx/` directory with `package.json`, `tsconfig.json`
- [ ] Move remaining source to `packages/browserx/src/`
- [ ] Update all imports (569 `@/` aliases across 212 files)
- [ ] Move and update vite configs
- [ ] Update `scripts/build.js` paths
- [ ] Update `vitest.config.mjs` aliases
- [ ] Update `eslint.config.js`
- [ ] Verify: `npm install` succeeds (workspace resolution)
- [ ] Verify: `packages/core` builds independently
- [ ] Verify: all BrowserX builds succeed
- [ ] Verify: all tests pass

### Phase 3: DigitalMe Agent

- [ ] Create `packages/digitalme-agent/` with `package.json`, `tsconfig.json`
- [ ] Implement HMAC auth middleware
- [ ] Implement HTTP server with protocol endpoints
- [ ] Implement `ConversationManager` with per-fan session isolation
- [ ] Implement `SSEStreamAdapter`
- [ ] Implement `PersonaConfig` loader (YAML + env vars)
- [ ] Implement `InputFilter` and `OutputFilter`
- [ ] Implement `ToolAllowlist`
- [ ] Implement `ConversationStore` (SQLite)
- [ ] Implement platform providers (`NoOpTabProvider`, `NoOpNotificationProvider`, `NodeMCPBridge`, `DigitalMeStorageProviderFactory`)
- [ ] Implement Dockerfile and docker-compose.yml
- [ ] Implement `digitalme-agent init` CLI command
- [ ] Write unit tests (HMAC, filters, allowlist, SSE adapter, store, config)
- [ ] Write integration tests (full request cycle, fan isolation, concurrent conversations)
- [ ] Write contract tests (platform protocol compliance)
- [ ] End-to-end test with running DigitalMe platform instance
