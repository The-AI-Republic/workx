# Refactoring RepublicAgent: Platform Abstraction, RepublicAgentEngine & Sub-Agent System

## 1. Problem Statement

RepublicAgent is a 1319-line class that mixes **6 distinct responsibilities**:

| # | Responsibility | Lines | Description |
|---|---|---|---|
| 1 | Core execution | ~50 | Create task, delegate to Session → RegularTask → TurnManager → TaskRunner |
| 2 | Submission queue routing | ~200 | SQ/EQ architecture, 15-case op-type switch |
| 3 | Tab/browser management | ~220 | Create tabs, validate tabs, switch tabs, MCP browser connection |
| 4 | Approval routing | ~100 | ExecApproval, PatchApproval, remember-decision, dual-path resolution |
| 5 | Config/model reactivity | ~150 | Config subscriptions, model hot-swap, deferred model switch, PromptComposer |
| 6 | Channel dispatch/queries | ~200 | Event dispatching, progress, history queries, compaction, isReady |

### 1.1 The Sub-Agent Problem

The sub-agent system needs responsibilities #1 and #2 (core execution + queue routing for handling multiple messages). But today, calling the core execution path (`processUserInputWithTask`) unavoidably triggers tab binding (#3), pending model switch (#5), and mixes platform-specific logic throughout.

There is no way to run a prompt through the agentic loop without dragging in all the platform-specific and orchestration overhead.

### 1.2 The Multi-Platform Problem

BrowserX now supports three platforms with fundamentally different browser interaction models:

| Platform | Tab Management | Browser Control | Storage | Entry Point |
|----------|---------------|-----------------|---------|-------------|
| **Extension** | `chrome.tabs` API, tab groups | ChromeDebuggerClient via content script | chrome.storage + IndexedDB | service-worker.ts |
| **Desktop** | Sentinel tabId (MCP manages internally) | CDP via chrome-devtools-mcp | Filesystem + SQLite + Keychain | DesktopAgentBootstrap.ts |
| **Server** | Sentinel tabId (no real tabs) | Remote MCP to external browser | Files + SQLite | ServerAgentBootstrap.ts |

RepublicAgent handles all three with `__BUILD_MODE__` conditionals scattered throughout:

```typescript
// Current: Platform checks mixed into core logic
if (__BUILD_MODE__ === 'server') {
  this.session.setTabId(1);
} else if (__BUILD_MODE__ === 'desktop') {
  // MCP browser connection logic
} else {
  // Extension TabManager calls
  const createdTabId = await tabManager.createTab({...});
  await tabManager.addTabToGroup(createdTabId);
}
```

**Problems:**
- Adding a new platform requires modifying RepublicAgent
- Platform-specific code is hard to find and test
- No clear ownership boundaries between platform teams

## 2. Goals

### 2.1 Extract Platform-Specific Logic

Create an `IPlatformAdapter` interface that encapsulates all platform-specific behavior:
- Tab creation, validation, switching
- Browser controller instantiation
- Platform-specific tool registration
- Approval policies

**Result:** RepublicAgent becomes platform-agnostic with zero `__BUILD_MODE__` checks.

### 2.2 Extract Core Engine with Queue Support

Create an `RepublicAgentEngine` class that:
1. Has SQ/EQ (Submission Queue / Event Queue) for handling multiple concurrent messages
2. Can run prompts to completion with proper sequencing
3. Has no dependency on tabs, channel dispatch, or config subscriptions
4. Accepts injected dependencies (ToolRegistry, ModelClient, system prompt)
5. Is usable by both RepublicAgent (existing flow) and sub-agents (new flow)
6. Supports optional browser context for browser-capable sub-agents
7. Handles approval routing internally (can be configured for auto-approve)

## 3. Architecture Overview

### 3.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Platform Bootstrap Layer                            │
│                                                                         │
│   ExtensionBootstrap      DesktopBootstrap       ServerBootstrap        │
│         │                       │                      │                │
│         │                       │                      │                │
│         ▼                       ▼                      ▼                │
│   ┌───────────────┐    ┌────────────────┐    ┌─────────────────┐       │
│   │ Extension     │    │ Desktop        │    │ Server          │       │
│   │ Platform      │    │ Platform       │    │ Platform        │       │
│   │ Adapter       │    │ Adapter        │    │ Adapter         │       │
│   └───────┬───────┘    └───────┬────────┘    └────────┬────────┘       │
└───────────┼────────────────────┼─────────────────────┼──────────────────┘
            │                    │                     │
            └────────────────────┼─────────────────────┘
                                 │
                    Injected via constructor
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Backend Orchestration Layer                          │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  RepublicAgent (~350 lines, orchestration wrapper)                │  │
│  │                                                                   │  │
│  │  Responsibilities:                                                │  │
│  │  • Tab binding (delegates to platformAdapter)                     │  │
│  │  • Config subscriptions (model hot-swap)                          │  │
│  │  • Session queries (history, compaction, isReady)                 │  │
│  │  • Channel management (setEventDispatcher for external UI)        │  │
│  │                                                                   │  │
│  │  Delegates to RepublicAgentEngine for all execution                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                 │                                       │
│                          Uses internally                                │
│                                 ▼                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       Core Engine Layer                               │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  RepublicAgentEngine (~400 lines, platform-agnostic)                    │  │
│  │                                                                   │  │
│  │  Core Responsibilities:                                           │  │
│  │  • Submission Queue (SQ) — accepts operations, processes in order │  │
│  │  • Event Queue (EQ) — emits events to subscribers                 │  │
│  │  • Approval routing (configurable: auto-approve or interactive)   │  │
│  │  • Task execution (delegates to Session → RegularTask → ...)      │  │
│  │                                                                   │  │
│  │  Modes:                                                           │  │
│  │  • Interactive: getNextEvent() for pull-based event consumption   │  │
│  │  • Awaitable: run() returns EngineResult when complete          │  │
│  │                                                                   │  │
│  │  NO: tabs, config subscriptions, channel dispatch                 │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│              ┌──────────────────┴──────────────────┐                   │
│              │                                     │                   │
│              ▼                                     ▼                   │
│  ┌─────────────────────────┐       ┌─────────────────────────────┐    │
│  │ Interactive Mode        │       │ Awaitable Mode              │    │
│  │ (via RepublicAgent)     │       │ (Sub-agents, programmatic)  │    │
│  │                         │       │                             │    │
│  │ submitOperation()       │       │ run(prompt) → result        │    │
│  │ getNextEvent()          │       │ runMultiple(prompts)        │    │
│  │                         │       │                             │    │
│  │ Events pulled by UI     │       │ Returns EngineResult      │    │
│  └─────────────────────────┘       └─────────────────────────────┘    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      Execution Layer (unchanged)                        │
│                                                                         │
│   RegularTask ──► AgentTask ──► TaskRunner ──► TurnManager             │
│                                      │              │                   │
│                                      ▼              ▼                   │
│                                  Session       ToolRegistry             │
│                                      │              │                   │
│                                      ▼              ▼                   │
│                              TurnContext       ModelClient              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Component Relationships

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Shared Resources                                 │
│                                                                         │
│  ┌─────────────┐  ┌──────────────────┐  ┌─────────────────────────┐    │
│  │ AgentConfig │  │ ModelClientFactory│  │ PromptComposer (global) │    │
│  │ (singleton) │  │ (shared instance) │  │                         │    │
│  └──────┬──────┘  └────────┬─────────┘  └─────────────────────────┘    │
│         │                  │                                            │
│         │    Shared by parent + sub-agents                              │
│         │                  │                                            │
└─────────┼──────────────────┼────────────────────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                  RepublicAgent (Backend Orchestrator)                   │
│                                                                         │
│  Uses RepublicAgentEngine internally for ALL execution                        │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ RepublicAgentEngine (owned by RepublicAgent)                           │   │
│  │                                                                  │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐           │   │
│  │  │ToolRegistry │  │ Session      │  │ TurnContext   │           │   │
│  │  │ (full set)  │  │ (persistent) │  │ (config)      │           │   │
│  │  ├─────────────┤  ├──────────────┤  ├───────────────┤           │   │
│  │  │ SQ / EQ     │  │ Approval     │  │ Task Exec     │           │   │
│  │  │ (queues)    │  │ Manager      │  │ (core loop)   │           │   │
│  │  └─────────────┘  └──────────────┘  └───────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│         │                                                               │
│         │ createChildEngine() clones with restrictions                │
│         ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ RepublicAgentEngine (Sub-Agent — child instance)                       │   │
│  │                                                                  │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐           │   │
│  │  │ToolRegistry │  │ Session      │  │ TurnContext   │           │   │
│  │  │ (restricted)│  │ (ephemeral)  │  │ (sub-agent)   │           │   │
│  │  ├─────────────┤  ├──────────────┤  ├───────────────┤           │   │
│  │  │ SQ / EQ     │  │ Auto-approve │  │ Task Exec     │           │   │
│  │  │ (queues)    │  │              │  │ (core loop)   │           │   │
│  │  └─────────────┘  └──────────────┘  └───────────────┘           │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Responsibility Split

| Concern | RepublicAgent (Orchestrator) | RepublicAgentEngine (Core) |
|---------|--------------------------|----------------------|
| **SQ/EQ routing** | ❌ Delegates | ✅ Owns queues |
| **Task execution** | ❌ Delegates | ✅ Owns execution loop |
| **Approval routing** | ❌ Delegates | ✅ Configurable policy |
| **Tab binding** | ✅ Handles | ❌ Receives tabId |
| **Config subscriptions** | ✅ Handles | ❌ Fixed config |
| **Model hot-swap** | ✅ Handles | ❌ Notified via method |
| **Channel dispatch** | ✅ Handles | ❌ Emits events |
| **History queries** | ✅ Handles | ❌ Exposes session |
| **Platform adapter** | ✅ Owns | ❌ Unaware |

This split means:
- **RepublicAgentEngine** is a complete, self-contained execution engine with queues (the smaller core)
- **RepublicAgent** is a backend orchestrator that adds platform and channel concerns
- **Sub-agents** use RepublicAgentEngine directly, getting queue support without orchestration overhead
- **UI** is an external channel that connects to RepublicAgent (not part of this architecture)

## 4. IPlatformAdapter Design

### 4.1 Interface Definition

```typescript
// File: src/core/platform/IPlatformAdapter.ts

export interface TabOptions {
  url?: string;
  active?: boolean;
  groupName?: string;
}

export interface TabValidationResult {
  valid: boolean;
  reason?: 'closed' | 'crashed' | 'no_permission' | 'not_found';
}

export interface ModelCapabilities {
  supportsImage: boolean;
  supportsReasoning?: boolean;
}

export interface ApprovalPolicies {
  enhancers: IRiskEnhancer[];
  assessors: Record<string, IRiskAssessor>;
}

export interface IPlatformAdapter {
  // ─────────────────────────────────────────────────────────────────
  // Platform Identity
  // ─────────────────────────────────────────────────────────────────

  /** Platform identifier */
  readonly platformId: 'extension' | 'desktop' | 'server';

  /** Whether this platform manages real browser tabs */
  readonly hasRealTabs: boolean;

  /** Whether browser tools are available on this platform */
  readonly hasBrowserTools: boolean;

  // ─────────────────────────────────────────────────────────────────
  // Tab Management
  // ─────────────────────────────────────────────────────────────────

  /**
   * Create a new tab.
   * @returns tabId (real for extension, sentinel for desktop/server)
   */
  createTab(options?: TabOptions): Promise<number>;

  /** Close a tab */
  closeTab(tabId: number): Promise<void>;

  /** Validate tab is healthy and accessible */
  validateTab(tabId: number): Promise<TabValidationResult>;

  /** Switch context from one tab to another */
  switchTab(fromTabId: number, toTabId: number): Promise<void>;

  // ─────────────────────────────────────────────────────────────────
  // Browser Controller
  // ─────────────────────────────────────────────────────────────────

  /**
   * Get browser controller for DOM/navigation operations.
   * @returns null if browser tools not available
   */
  getBrowserController(tabId: number): Promise<IBrowserController | null>;

  // ─────────────────────────────────────────────────────────────────
  // Tool Registration
  // ─────────────────────────────────────────────────────────────────

  /**
   * Register platform-specific tools into the registry.
   * Called during RepublicAgent.initialize()
   */
  registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void>;

  /**
   * Get platform-specific approval policies.
   * Different platforms have different risk models.
   */
  getApprovalPolicies(): ApprovalPolicies;

  // ─────────────────────────────────────────────────────────────────
  // Storage (for completeness — already well-abstracted)
  // ─────────────────────────────────────────────────────────────────

  getConfigStorage(): IConfigStorage;
  getCredentialStore(): ICredentialStore;
  getStorageProvider(): IStorageProvider;

  // ─────────────────────────────────────────────────────────────────
  // Scheduler
  // ─────────────────────────────────────────────────────────────────

  createScheduler(): IScheduler;

  // ─────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────

  /** Initialize platform-specific resources (called once at startup) */
  initialize(): Promise<void>;

  /** Cleanup on shutdown */
  dispose(): Promise<void>;
}
```

### 4.2 Extension Platform Adapter

```typescript
// File: src/extension/platform/ExtensionPlatformAdapter.ts

export class ExtensionPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'extension' as const;
  readonly hasRealTabs = true;
  readonly hasBrowserTools = true;

  private tabManager: TabManager;

  async initialize(): Promise<void> {
    this.tabManager = TabManager.getInstance();
  }

  async createTab(options?: TabOptions): Promise<number> {
    const tab = await chrome.tabs.create({
      url: options?.url ?? 'about:blank',
      active: options?.active ?? true,
    });

    if (options?.groupName) {
      await this.tabManager.addTabToGroup(tab.id!, options.groupName);
    }

    return tab.id!;
  }

  async closeTab(tabId: number): Promise<void> {
    await chrome.tabs.remove(tabId);
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) {
        return { valid: false, reason: 'not_found' };
      }
      if (tab.status === 'unloaded') {
        return { valid: false, reason: 'crashed' };
      }
      // Check if we have permission to access the tab
      const hasPermission = await this.checkTabPermission(tabId);
      if (!hasPermission) {
        return { valid: false, reason: 'no_permission' };
      }
      return { valid: true };
    } catch (error) {
      return { valid: false, reason: 'closed' };
    }
  }

  async switchTab(fromTabId: number, toTabId: number): Promise<void> {
    await this.tabManager.clearAllTabsFromGroup();
    await this.tabManager.addTabToGroup(toTabId);
  }

  async getBrowserController(tabId: number): Promise<IBrowserController> {
    return new ExtensionBrowserController(tabId);
  }

  async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    // Extension-specific browser tools (DOM, screenshot, etc.)
    await registerExtensionBrowserTools(registry, toolsConfig, capabilities);

    // Web search (shared)
    if (toolsConfig.webSearch?.enabled) {
      await registerWebSearchTool(registry);
    }

    // Planning tool (shared)
    await registerPlanningTool(registry);
  }

  getApprovalPolicies(): ApprovalPolicies {
    return {
      enhancers: [
        new DomainSensitivityEnhancer(),
        new SemanticElementEnhancer(),
        new SensitivePathEnhancer(),
      ],
      assessors: {
        dom: new DomToolRiskAssessor(),
        navigation: new NavigationRiskAssessor(),
      },
    };
  }

  getConfigStorage(): IConfigStorage {
    return new ChromeConfigStorage();
  }

  getCredentialStore(): ICredentialStore {
    return new ChromeCredentialStore();
  }

  getStorageProvider(): IStorageProvider {
    return new IndexedDBStorageProvider();
  }

  createScheduler(): IScheduler {
    return new ChromeAlarmsScheduler();
  }

  async dispose(): Promise<void> {
    // Cleanup tab listeners, etc.
  }

  private async checkTabPermission(tabId: number): Promise<boolean> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => true,
      });
      return true;
    } catch {
      return false;
    }
  }
}
```

### 4.3 Desktop Platform Adapter

```typescript
// File: src/desktop/platform/DesktopPlatformAdapter.ts

export class DesktopPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'desktop' as const;
  readonly hasRealTabs = false;  // MCP manages tabs internally
  readonly hasBrowserTools = true;

  private mcpManager: MCPManager;
  private browserConnected = false;

  async initialize(): Promise<void> {
    this.mcpManager = await MCPManager.getInstance('desktop');

    // Attempt to connect to builtin browser MCP server
    try {
      const browserServer = this.mcpManager.getBuiltinBrowserServer();
      if (browserServer) {
        await this.mcpManager.connect(browserServer.id);
        this.browserConnected = true;
      }
    } catch (error) {
      console.warn('Desktop browser MCP not available:', error);
      this.browserConnected = false;
    }
  }

  async createTab(options?: TabOptions): Promise<number> {
    // Desktop doesn't manage tabs directly — MCP handles it
    // Return sentinel tabId for session tracking
    return 1;
  }

  async closeTab(tabId: number): Promise<void> {
    // No-op for desktop — MCP manages tab lifecycle
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    // Desktop tabs are managed by MCP, always considered valid
    return { valid: true };
  }

  async switchTab(fromTabId: number, toTabId: number): Promise<void> {
    // No-op for desktop — MCP handles tab context
  }

  async getBrowserController(tabId: number): Promise<IBrowserController | null> {
    if (!this.browserConnected) return null;

    const connection = this.mcpManager.getConnection('browser');
    if (!connection) return null;

    return new MCPBrowserController(connection);
  }

  async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    // MCP browser tools (if connected)
    if (this.browserConnected) {
      const connection = this.mcpManager.getConnection('browser');
      await registerMCPBrowserTools(registry, connection, new McpBrowserRiskAssessor());
    }

    // Terminal tool (desktop-specific)
    if (toolsConfig.execCommand?.enabled) {
      await registerTerminalTool(registry, new TerminalRiskAssessor());
    }

    // Settings tool (desktop-specific)
    await registerSettingTool(registry);

    // Web search (shared)
    if (toolsConfig.webSearch?.enabled) {
      await registerWebSearchTool(registry);
    }

    // Planning tool (shared)
    await registerPlanningTool(registry);
  }

  getApprovalPolicies(): ApprovalPolicies {
    return {
      enhancers: [
        new DomainSensitivityEnhancer(),
        new SensitivePathEnhancer(),
      ],
      assessors: {
        mcp_browser: new McpBrowserRiskAssessor(),
        terminal: new TerminalRiskAssessor(),
        setting: new SettingToolRiskAssessor(),
      },
    };
  }

  getConfigStorage(): IConfigStorage {
    return new TauriConfigStorage();
  }

  getCredentialStore(): ICredentialStore {
    return new KeytarCredentialStore();
  }

  getStorageProvider(): IStorageProvider {
    return new SQLiteStorageProvider(new TauriSQLiteAdapter());
  }

  createScheduler(): IScheduler {
    return new DesktopSchedulerAlarms();
  }

  async dispose(): Promise<void> {
    // Disconnect MCP connections
    if (this.browserConnected) {
      await this.mcpManager.disconnectAll();
    }
  }
}
```

### 4.4 Server Platform Adapter

```typescript
// File: src/server/platform/ServerPlatformAdapter.ts

export class ServerPlatformAdapter implements IPlatformAdapter {
  readonly platformId = 'server' as const;
  readonly hasRealTabs = false;
  hasBrowserTools = false;  // Determined at runtime

  private mcpManager: MCPManager;

  async initialize(): Promise<void> {
    this.mcpManager = await MCPManager.getInstance('server');

    // Attempt to connect to external browser MCP
    // Uses env vars: CHROME_REMOTE_URL or CHROME_WS_ENDPOINT
    try {
      const browserEndpoint = this.getBrowserEndpoint();
      if (browserEndpoint) {
        await this.mcpManager.connectExternal('browser', browserEndpoint);
        this.hasBrowserTools = true;
      }
    } catch (error) {
      console.warn('Server browser MCP not available:', error);
      this.hasBrowserTools = false;
    }
  }

  async createTab(options?: TabOptions): Promise<number> {
    // Server doesn't manage tabs — return sentinel
    return 1;
  }

  async closeTab(tabId: number): Promise<void> {
    // No-op
  }

  async validateTab(tabId: number): Promise<TabValidationResult> {
    // Always valid (no real tabs)
    return { valid: true };
  }

  async switchTab(fromTabId: number, toTabId: number): Promise<void> {
    // No-op
  }

  async getBrowserController(tabId: number): Promise<IBrowserController | null> {
    if (!this.hasBrowserTools) return null;

    const connection = this.mcpManager.getConnection('browser');
    if (!connection) return null;

    return new MCPBrowserController(connection);
  }

  async registerPlatformTools(
    registry: ToolRegistry,
    toolsConfig: IToolsConfig,
    capabilities: ModelCapabilities
  ): Promise<void> {
    // MCP browser tools (if available)
    if (this.hasBrowserTools) {
      const connection = this.mcpManager.getConnection('browser');
      await registerMCPBrowserTools(registry, connection, new StaticRiskAssessor('medium'));
    }

    // Web search (shared)
    if (toolsConfig.webSearch?.enabled) {
      await registerWebSearchTool(registry);
    }

    // Planning tool (shared)
    await registerPlanningTool(registry);

    // User-configured MCP servers via plugin system
    await this.registerUserMCPServers(registry);
  }

  getApprovalPolicies(): ApprovalPolicies {
    return {
      enhancers: [
        new SensitivePathEnhancer(),
      ],
      assessors: {
        mcp_browser: new StaticRiskAssessor('medium'),
        mcp_other: new StaticRiskAssessor('low'),
      },
    };
  }

  getConfigStorage(): IConfigStorage {
    return new FileConfigStorageProvider();
  }

  getCredentialStore(): ICredentialStore {
    return new FileCredentialStore();
  }

  getStorageProvider(): IStorageProvider {
    return new SQLiteStorageProvider(new NodeSQLiteAdapter());
  }

  createScheduler(): IScheduler {
    return new ServerSchedulerAlarms();
  }

  async dispose(): Promise<void> {
    await this.mcpManager.disconnectAll();
  }

  private getBrowserEndpoint(): string | null {
    return process.env.CHROME_REMOTE_URL
      ?? process.env.CHROME_WS_ENDPOINT
      ?? null;
  }

  private async registerUserMCPServers(registry: ToolRegistry): Promise<void> {
    // Load from server config, connect, register tools
    // Implementation details...
  }
}
```

## 5. RepublicAgentEngine Design

### 5.1 Core Concept

RepublicAgentEngine is the **core execution engine** that owns:
- **Submission Queue (SQ)**: Accepts operations, processes them in order
- **Event Queue (EQ)**: Emits events to subscribers
- **Approval Manager**: Configurable approval policy (auto-approve or interactive)
- **Task Execution**: Delegates to Session → RegularTask → TaskRunner

It operates in two modes:
- **Interactive Mode**: For channel-driven execution (submitOperation + getNextEvent)
- **Awaitable Mode**: For programmatic execution (run + runMultiple)

### 5.2 Interface

```typescript
// File: src/core/engine/RepublicAgentEngineConfig.ts

export interface RepublicAgentEngineConfig {
  /** AgentConfig instance (shared — for credentials and provider info) */
  agentConfig: AgentConfig;

  /** Pre-built ToolRegistry (caller controls which tools are available) */
  toolRegistry: ToolRegistry;

  /** System prompt (base instructions) for this engine */
  systemPrompt: string;

  /** Optional user instructions appended to system prompt */
  userInstructions?: string;

  /** Model to use. If omitted, uses agentConfig.selectedModelKey */
  model?: string;

  /** Shared ModelClientFactory (reuses parent's cached clients + auth) */
  modelClientFactory: ModelClientFactory;

  /** Max turns before forced stop. Default: 500 (TaskRunner.MAX_TURNS) */
  maxTurns?: number;

  /** Whether to persist session history. Default: false for sub-agents */
  persistent?: boolean;

  /**
   * Optional ApprovalGate for tool execution approval.
   * ApprovalGate internally contains ApprovalManager for user interactions.
   * If not provided, all tool calls auto-approve (no stopping).
   * RepublicAgent injects its ApprovalGate; sub-agents typically omit this.
   */
  approvalGate?: ApprovalGate;

  /**
   * Optional browser context for sub-agents that need browser tools.
   * If provided, sub-agent can use browser tools with this context.
   */
  browserContext?: {
    tabId: number;
    controller: IBrowserController;
  };

  /**
   * Optional event router for namespacing sub-agent events.
   * If provided, events are routed through this instead of direct emission.
   */
  eventRouter?: IEventRouter;

  /**
   * Parent engine ID for tracing nested sub-agents.
   */
  parentEngineId?: string;

  /**
   * Initial conversation history (for session recovery).
   */
  initialHistory?: InitialHistory;
}

export interface EngineResult {
  /** Whether execution completed successfully */
  success: boolean;

  /** Final assistant text response (last AgentMessage) */
  response: string | null;

  /** Number of turns executed */
  turnCount: number;

  /** Token usage for this execution */
  tokenUsage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };

  /** Why execution stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled' | 'interrupted';

  /** Error message if stopReason is 'error' */
  error?: string;

  /** Engine ID for tracing */
  engineId: string;

  /** Submission ID that produced this result */
  submissionId: string;
}

export interface RunOptions {
  /** Override max turns for this specific run */
  maxTurns?: number;

  /** AbortSignal for external cancellation */
  signal?: AbortSignal;

  /** Context for the execution (tabId, etc.) */
  context?: ExecutionContext;
}

export interface ExecutionContext {
  tabId?: number;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}
```

### 5.3 Operation Types

RepublicAgentEngine handles a subset of the operation types that RepublicAgent currently handles:

```typescript
// File: src/core/engine/operations.ts

/** Operations handled by RepublicAgentEngine */
export type EngineOp =
  | { type: 'UserInput'; items: InputItem[]; context?: ExecutionContext }
  | { type: 'UserTurn'; items: InputItem[]; context?: ExecutionContext }
  | { type: 'Interrupt'; reason?: string }
  | { type: 'ExecApproval'; callId: string; approved: boolean; remember?: boolean }
  | { type: 'PatchApproval'; patchId: string; approved: boolean }
  | { type: 'Compact'; mode?: 'auto' | 'manual' }
  | { type: 'ClearHistory' };

/** Operations that stay in RepublicAgent (orchestration-specific) */
export type OrchestrationOp =
  | { type: 'GetPath' }
  | { type: 'GetHistoryEntry'; entryId: string }
  | { type: 'ConfigChange'; key: string; value: unknown }
  | { type: 'ModelSwitch'; modelKey: string }
  | { type: 'TabSwitch'; tabId: number };

export interface Submission {
  id: string;
  op: EngineOp;
  timestamp: number;
}
```

### 5.4 Implementation

```typescript
// File: src/core/engine/RepublicAgentEngine.ts

import { v4 as uuidv4 } from 'uuid';

export class RepublicAgentEngine {
  readonly engineId: string;

  // Core components
  private session: Session;
  private toolRegistry: ToolRegistry;
  private turnContext: TurnContext;
  private approvalManager: ApprovalManager;
  private config: RepublicAgentEngineConfig;

  // Queue state
  private submissionQueue: Submission[] = [];
  private eventQueue: Event[] = [];
  private processingSubmission = false;
  private eventWaiters: Array<(event: Event) => void> = [];

  // Lifecycle state
  private disposed = false;
  private initialized = false;

  constructor(config: RepublicAgentEngineConfig) {
    this.engineId = uuidv4();
    this.config = config;
    this.toolRegistry = config.toolRegistry;

    // Setup approval manager based on policy
    this.approvalManager = this.createApprovalManager(config.approvalPolicy);

    // Create Session (persistent or ephemeral)
    this.session = new Session(
      config.agentConfig,
      config.persistent ?? false,
      undefined,
      config.toolRegistry,
      config.initialHistory
    );

    // Set browser context if provided
    if (config.browserContext) {
      this.session.setTabId(config.browserContext.tabId);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Create model client
    const modelClient = this.config.model
      ? await this.config.modelClientFactory.createClient(this.config.model)
      : await this.config.modelClientFactory.createClientForCurrentModel();

    // Create TurnContext
    this.turnContext = new TurnContext(modelClient, {
      sessionId: this.session.conversationId,
      approvalPolicy: this.config.approvalPolicy === 'auto' ? 'never' : 'on-request',
    });

    this.turnContext.setBaseInstructions(this.config.systemPrompt);
    if (this.config.userInstructions) {
      this.turnContext.setUserInstructions(this.config.userInstructions);
    }

    this.session.setTurnContext(this.turnContext);

    // Wire event emission
    this.session.setEventEmitter(async (event) => {
      this.pushEvent(event);
    });

    this.initialized = true;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Interactive Mode (SQ/EQ)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Submit an operation to the queue.
   * Operations are processed in order.
   */
  submitOperation(op: EngineOp): string {
    this.ensureReady();

    const submission: Submission = {
      id: uuidv4(),
      op,
      timestamp: Date.now(),
    };

    this.submissionQueue.push(submission);
    this.processSubmissionQueue();

    return submission.id;
  }

  /**
   * Get the next event from the queue.
   * Blocks until an event is available.
   */
  async getNextEvent(): Promise<Event> {
    // Return queued event if available
    if (this.eventQueue.length > 0) {
      return this.eventQueue.shift()!;
    }

    // Wait for next event
    return new Promise((resolve) => {
      this.eventWaiters.push(resolve);
    });
  }

  /**
   * Check if there are pending events.
   */
  hasEvents(): boolean {
    return this.eventQueue.length > 0;
  }

  /**
   * Get all pending events (non-blocking).
   */
  drainEvents(): Event[] {
    const events = this.eventQueue.slice();
    this.eventQueue.length = 0;
    return events;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Awaitable Mode
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Run a single prompt to completion. Awaitable.
   * Uses the queue internally but waits for completion.
   */
  async run(input: InputItem[], options?: RunOptions): Promise<EngineResult> {
    this.ensureReady();

    const submissionId = this.submitOperation({
      type: 'UserInput',
      items: input,
      context: options?.context,
    });

    return this.waitForCompletion(submissionId, options);
  }

  /**
   * Run multiple prompts in sequence. Awaitable.
   * Useful for multi-turn sub-agent conversations.
   */
  async runMultiple(
    inputs: InputItem[][],
    options?: RunOptions
  ): Promise<EngineResult[]> {
    const results: EngineResult[] = [];

    for (const input of inputs) {
      const result = await this.run(input, options);
      results.push(result);

      // Stop on error unless configured otherwise
      if (!result.success && result.stopReason !== 'completed') {
        break;
      }
    }

    return results;
  }

  /**
   * Send a follow-up message in the same conversation.
   * Equivalent to UserTurn operation.
   */
  async sendFollowUp(input: InputItem[], options?: RunOptions): Promise<EngineResult> {
    this.ensureReady();

    const submissionId = this.submitOperation({
      type: 'UserTurn',
      items: input,
      context: options?.context,
    });

    return this.waitForCompletion(submissionId, options);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Approval Handling
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Approve a pending tool execution.
   */
  approveExecution(callId: string, remember?: boolean): void {
    this.submitOperation({
      type: 'ExecApproval',
      callId,
      approved: true,
      remember,
    });
  }

  /**
   * Reject a pending tool execution.
   */
  rejectExecution(callId: string): void {
    this.submitOperation({
      type: 'ExecApproval',
      callId,
      approved: false,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Control
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Interrupt the current execution.
   */
  interrupt(reason?: string): void {
    this.submitOperation({ type: 'Interrupt', reason });
  }

  /**
   * Cancel all pending operations and abort current task.
   */
  cancel(): void {
    this.submissionQueue.length = 0;
    this.session.abortAllTasks('UserInterrupt');
  }

  /**
   * Dispose of engine resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    this.cancel();
    this.session.clearHistory();

    // Resolve any waiting getNextEvent calls
    const disposeEvent: Event = {
      id: uuidv4(),
      msg: { type: 'EngineDisposed', data: { engineId: this.engineId } },
    };
    this.eventWaiters.forEach((resolve) => resolve(disposeEvent));
    this.eventWaiters.length = 0;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Accessors
  // ═══════════════════════════════════════════════════════════════════

  getSession(): Session { return this.session; }
  getToolRegistry(): ToolRegistry { return this.toolRegistry; }
  getApprovalManager(): ApprovalManager { return this.approvalManager; }
  isReady(): boolean { return this.initialized && !this.disposed; }

  /**
   * Update the model client (for model hot-swap from parent).
   */
  async updateModelClient(modelKey: string): Promise<void> {
    const modelClient = await this.config.modelClientFactory.createClient(modelKey);
    this.turnContext.setModelClient(modelClient);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: Queue Processing
  // ═══════════════════════════════════════════════════════════════════

  private async processSubmissionQueue(): Promise<void> {
    if (this.processingSubmission) return;
    this.processingSubmission = true;

    try {
      while (this.submissionQueue.length > 0) {
        const submission = this.submissionQueue.shift()!;
        await this.handleSubmission(submission);
      }
    } finally {
      this.processingSubmission = false;
    }
  }

  private async handleSubmission(submission: Submission): Promise<void> {
    const { op } = submission;

    switch (op.type) {
      case 'UserInput':
      case 'UserTurn':
        await this.handleUserInput(submission.id, op.items, op.context);
        break;

      case 'Interrupt':
        this.session.abortAllTasks(op.reason ?? 'UserInterrupt');
        this.pushEvent({
          id: uuidv4(),
          msg: { type: 'TaskAborted', data: { reason: op.reason } },
        });
        break;

      case 'ExecApproval':
        await this.approvalManager.resolveApproval(op.callId, op.approved, op.remember);
        break;

      case 'PatchApproval':
        await this.approvalManager.resolvePatchApproval(op.patchId, op.approved);
        break;

      case 'Compact':
        await this.session.compact(op.mode ?? 'manual');
        break;

      case 'ClearHistory':
        this.session.clearHistory();
        break;
    }
  }

  private async handleUserInput(
    submissionId: string,
    items: InputItem[],
    context?: ExecutionContext
  ): Promise<void> {
    // Set tab context if provided
    if (context?.tabId) {
      this.session.setTabId(context.tabId);
    }

    const task = new RegularTask();

    try {
      this.pushEvent({
        id: uuidv4(),
        msg: { type: 'TaskStarted', data: { submissionId } },
      });

      const result = await task.run(
        this.session,
        this.turnContext,
        submissionId,
        items,
        { maxTurns: this.config.maxTurns }
      );

      this.pushEvent({
        id: uuidv4(),
        msg: {
          type: 'TaskComplete',
          data: {
            submissionId,
            response: result,
            turnCount: this.getTurnCount(),
            tokenUsage: this.getTokenUsage(),
          },
        },
      });
    } catch (error) {
      this.pushEvent({
        id: uuidv4(),
        msg: {
          type: 'TaskError',
          data: {
            submissionId,
            error: error instanceof Error ? error.message : String(error),
          },
        },
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: Event Handling
  // ═══════════════════════════════════════════════════════════════════

  private pushEvent(event: Event): void {
    // Route through event router if configured
    if (this.config.eventRouter) {
      this.config.eventRouter.routeEvent(event, {
        engineId: this.engineId,
        parentEngineId: this.config.parentEngineId,
      });
      return;
    }

    // Add to queue
    this.eventQueue.push(event);

    // Resolve waiting getNextEvent call if any
    if (this.eventWaiters.length > 0) {
      const waiter = this.eventWaiters.shift()!;
      const queuedEvent = this.eventQueue.shift()!;
      waiter(queuedEvent);
    }
  }

  private async waitForCompletion(
    submissionId: string,
    options?: RunOptions
  ): Promise<EngineResult> {
    const abortController = new AbortController();

    if (options?.signal) {
      options.signal.addEventListener('abort', () => {
        abortController.abort();
        this.interrupt('Cancelled');
      });
    }

    // Collect events until TaskComplete or TaskError
    while (true) {
      const event = await this.getNextEvent();

      if (event.msg.type === 'TaskComplete' && event.msg.data?.submissionId === submissionId) {
        return {
          success: true,
          response: event.msg.data.response,
          turnCount: event.msg.data.turnCount,
          tokenUsage: event.msg.data.tokenUsage,
          stopReason: 'completed',
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'TaskError' && event.msg.data?.submissionId === submissionId) {
        return {
          success: false,
          response: null,
          turnCount: this.getTurnCount(),
          tokenUsage: this.getTokenUsage(),
          stopReason: 'error',
          error: event.msg.data.error,
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'TaskAborted') {
        return {
          success: false,
          response: null,
          turnCount: this.getTurnCount(),
          tokenUsage: this.getTokenUsage(),
          stopReason: abortController.signal.aborted ? 'cancelled' : 'interrupted',
          engineId: this.engineId,
          submissionId,
        };
      }

      if (event.msg.type === 'EngineDisposed') {
        return {
          success: false,
          response: null,
          turnCount: 0,
          stopReason: 'cancelled',
          error: 'Engine disposed',
          engineId: this.engineId,
          submissionId,
        };
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal: Helpers
  // ═══════════════════════════════════════════════════════════════════

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('RepublicAgentEngine.initialize() must be called first');
    }
    if (this.disposed) {
      throw new Error('RepublicAgentEngine has been disposed');
    }
  }

  private createApprovalManager(
    policy?: 'auto' | 'interactive' | ApprovalManager
  ): ApprovalManager {
    if (policy instanceof ApprovalManager) {
      return policy;
    }

    // Auto-approve policy creates a pass-through manager
    if (policy === 'auto') {
      return new ApprovalManager({ autoApprove: true });
    }

    // Interactive policy creates a standard manager
    return new ApprovalManager({ autoApprove: false });
  }

  private getTurnCount(): number {
    return this.session.getCurrentTaskState()?.currentTurnIndex ?? 0;
  }

  private getTokenUsage(): EngineResult['tokenUsage'] | undefined {
    const state = this.session.getCurrentTaskState();
    if (!state?.tokenUsageDetail?.total) return undefined;

    return {
      input_tokens: state.tokenUsageDetail.total.input_tokens ?? 0,
      output_tokens: state.tokenUsageDetail.total.output_tokens ?? 0,
      total_tokens: state.tokenUsageDetail.total.total_tokens ?? 0,
    };
  }
}
```

### 5.5 What RepublicAgentEngine Has vs Does NOT Have

**RepublicAgentEngine HAS (Core Execution):**

| Feature | Description |
|---------|-------------|
| Submission Queue (SQ) | Accepts operations, processes in order |
| Event Queue (EQ) | Emits events, supports getNextEvent() for pull-based consumption |
| Approval routing | Routes ExecApproval/PatchApproval ops to injected ApprovalManager + Session |
| Task execution | Delegates to Session → RegularTask → TaskRunner |
| Dual-mode operation | Interactive (submitOperation/getNextEvent) or Awaitable (run/runMultiple) |
| Interrupt handling | Can interrupt current task |
| Compaction | Supports manual and auto compaction |

**RepublicAgentEngine Does NOT Have (Orchestration/Platform Concerns):**

| Feature | Why Excluded | Handled By |
|---------|--------------|------------|
| ApprovalGate (with ApprovalManager) | Injected, not owned | RepublicAgent creates ApprovalGate, injects via config |
| Tab binding | Platform-specific | RepublicAgent + IPlatformAdapter |
| Tab creation/validation | Platform-specific | IPlatformAdapter |
| Config subscriptions | Orchestration concern | RepublicAgent |
| Model hot-swap initiation | Orchestration concern | RepublicAgent (calls updateModelClient) |
| UserNotifier | Channel concern | RepublicAgent |
| GetPath / GetHistoryEntry | Session queries | RepublicAgent |
| Platform tool registration | Platform-specific | IPlatformAdapter |
| PromptComposer setup | Bootstrap concern | Platform bootstrap |
| Channel management | Orchestration concern | RepublicAgent |
| BUILD_MODE checks | Platform-specific | IPlatformAdapter |

### 5.6 Approval System Integration

The current approval system has **two distinct paths** that both need to work with RepublicAgentEngine:

#### 5.6.1 Dual-Path Approval Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Approval System Paths                             │
│                                                                         │
│  Path 1: Risk-Based Approvals (Tool Execution)                          │
│  ──────────────────────────────────────────────                         │
│  TurnManager.executeBrowserTool()                                       │
│    → ToolRegistry.execute()                                             │
│      → ApprovalGate.check()                                             │
│        1. Blocked domains → deny                                        │
│        2. Trusted domains → auto_approve                                │
│        3. Risk assessment (IRiskAssessor)                               │
│        4. Enhancers (IContextEnhancer)                                  │
│        5. Policy rules (PolicyRulesEngine)                              │
│        6. Session memory check                                          │
│        7. Mode-based threshold                                          │
│        8. ApprovalManager.requestApproval() ──► ApprovalRequested event │
│           → Wait for ExecApproval operation                             │
│           → ApprovalGranted/ApprovalDenied                              │
│                                                                         │
│  Path 2: Protocol-Level Approvals (Model Response)                      │
│  ─────────────────────────────────────────────────                      │
│  Model emits ExecApprovalRequest or ApplyPatchApprovalRequest           │
│    → Session.notifyApproval()                                           │
│      → Wait for ExecApproval/PatchApproval operation                    │
│      → Resolve pending promise in TaskRunner                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 5.6.2 ApprovalGate Contains ApprovalManager

The relationship is **composition** - ApprovalGate contains ApprovalManager:

```
┌─────────────────────────────────────────────────────────┐
│                  ApprovalGate                           │
│  (Risk assessment + policy orchestrator)                │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ApprovalManager (internal)                       │   │
│  │ - Emits ApprovalRequested events                 │   │
│  │ - Waits for user decision                        │   │
│  │ - Handles ExecApproval operations                │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  + PolicyRulesEngine                                    │
│  + Risk Enhancers                                       │
│  + Session Memory                                       │
└─────────────────────────────────────────────────────────┘
```

So RepublicAgentEngine only needs **one optional parameter**: `approvalGate`

```typescript
export interface RepublicAgentEngineConfig {
  /**
   * Optional ApprovalGate for tool execution approval.
   * ApprovalGate internally contains ApprovalManager.
   * If not provided, all tool calls auto-approve (no stopping).
   */
  approvalGate?: ApprovalGate;
}
```

**Behavior:**

| Config | Risk-Based (Path 1) | Protocol-Level (Path 2) |
|--------|---------------------|-------------------------|
| No approvalGate | ToolRegistry has no gate → auto-approve | Session auto-approves |
| approvalGate provided | ToolRegistry uses gate → may ask user | Session follows normal flow |

#### 5.6.3 RepublicAgentEngine Approval Setup (Simple)

```typescript
// Inside RepublicAgentEngine constructor - just wire up what's provided

private setupApprovalSystem(): void {
  if (this.config.approvalGate) {
    // Inject gate into ToolRegistry for risk-based approvals
    this.toolRegistry.setApprovalGate(this.config.approvalGate);
    this.session.setAutoApprove(false);
  } else {
    // No gate = no stopping for approvals
    this.session.setAutoApprove(true);
  }
}
```

#### 5.6.4 Handling ExecApproval Operations

When an `ExecApproval` operation arrives, RepublicAgentEngine routes to **both** paths:

```typescript
private async handleExecApproval(op: ExecApprovalOp): Promise<void> {
  const { callId, approved, remember, alternativeText } = op;

  // Path 1: Risk-based approval (via ApprovalGate's internal ApprovalManager)
  if (this.config.approvalGate) {
    try {
      const approvalManager = this.config.approvalGate.getApprovalManager();

      // Capture pending approval data before resolution (for "remember")
      const pendingApproval = approvalManager.getApproval(callId);

      approvalManager.handleDecision(callId, approved, alternativeText);

      // Handle "remember" for session memory
      if (remember && pendingApproval && approved) {
        this.config.approvalGate.rememberDecision(pendingApproval);
      }
    } catch (e) {
      // No pending risk-based approval for this callId
    }
  }

  // Path 2: Protocol-level approval (Session) - always try
  try {
    this.session.notifyApproval(callId, approved);
  } catch (e) {
    // No pending protocol-level approval for this callId
  }
}
```

#### 5.6.5 Sub-Agent Approval Handling

Sub-agents typically run **without** approval components:
1. The parent agent already has user approval
2. Sub-agents can't interact with users (no channel access)
3. Blocking on approval would deadlock (no one to approve)

```typescript
// In RepublicAgent.createChildEngine()
createChildEngine(config: Partial<RepublicAgentEngineConfig>): RepublicAgentEngine {
  return new RepublicAgentEngine({
    // ... other config
    // NO approvalGate, NO approvalManager → runs without stopping
    // ...
  });
}
```

If a sub-agent needs approval (rare), the parent can inject its ApprovalGate:

```typescript
const engine = parentAgent.createChildEngine({
  // Share parent's approval system (ApprovalGate contains ApprovalManager)
  approvalGate: parentAgent.getApprovalGate(),
  eventRouter: new SubAgentEventRouter({
    parentEmitter: (event) => {
      // ApprovalRequested events bubble up to parent's channel
      parentAgent.getEngine().pushEvent(event);
    },
  }),
});
```

#### 5.6.6 RepublicAgent Approval Responsibilities

RepublicAgent **owns ApprovalGate** (which contains ApprovalManager) and injects it into RepublicAgentEngine:

```
RepublicAgent
  └── owns ApprovalGate
        └── contains ApprovalManager
        └── contains PolicyRulesEngine
        └── contains Risk Enhancers
```

```typescript
// RepublicAgent constructor
constructor(config: AgentConfig, platformAdapter: IPlatformAdapter) {
  // Create ApprovalManager (handles user interaction events)
  const approvalManager = new ApprovalManager(
    config,
    (event) => this.emitEvent(event.msg)
  );

  // Create ApprovalGate (contains ApprovalManager + policy logic)
  this.approvalGate = new ApprovalGate(
    approvalManager,
    new PolicyRulesEngine(platformAdapter.getDefaultRules())
  );
  this.approvalGate.addEnhancer(new DomainSensitivityEnhancer());
  this.approvalGate.addEnhancer(new SemanticElementEnhancer());

  // Inject ApprovalGate into RepublicAgentEngine
  this.engine = new RepublicAgentEngine({
    // ... other config
    approvalGate: this.approvalGate,
  });
}
```

RepublicAgent forwards approval operations to its internal RepublicAgentEngine:

```typescript
// RepublicAgent
async submitOperation(op: Op, context?: OperationContext): Promise<string> {
  if (op.type === 'ExecApproval' || op.type === 'PatchApproval') {
    // Forward directly to engine - it handles both approval paths
    return this.engine.submitOperation(op);
  }
  // ... other operations
}
```

## 6. Event Routing for Sub-Agents

### 6.1 IEventRouter Interface

```typescript
// File: src/core/events/IEventRouter.ts

export interface EventRoutingMetadata {
  engineId: string;
  parentEngineId?: string;
  depth?: number;
}

export interface IEventRouter {
  /**
   * Route a sub-agent event.
   * Implementation can namespace, filter, or transform events.
   */
  routeEvent(event: Event, metadata: EventRoutingMetadata): void;

  /**
   * Whether to emit a particular event type.
   * Allows filtering verbose events from sub-agents.
   */
  shouldEmit(eventType: string): boolean;
}
```

### 6.2 SubAgentEventRouter Implementation

```typescript
// File: src/core/events/SubAgentEventRouter.ts

export class SubAgentEventRouter implements IEventRouter {
  private readonly parentEmitter: (event: Event) => void;
  private readonly engineId: string;
  private readonly suppressedTypes: Set<string>;

  constructor(options: {
    parentEmitter: (event: Event) => void;
    engineId: string;
    suppressedTypes?: string[];
  }) {
    this.parentEmitter = options.parentEmitter;
    this.engineId = options.engineId;
    this.suppressedTypes = new Set(options.suppressedTypes ?? [
      'AgentMessageDelta',  // Too verbose for sub-agents
      'AgentReasoningDelta',
    ]);
  }

  routeEvent(event: Event, metadata: EventRoutingMetadata): void {
    if (!this.shouldEmit(event.msg.type)) return;

    // Namespace the event ID
    const namespacedEvent: Event = {
      ...event,
      id: `${this.engineId}:${event.id}`,
      msg: {
        ...event.msg,
        // Add sub-agent metadata
        _subAgent: {
          engineId: this.engineId,
          parentEngineId: metadata.parentEngineId,
          depth: metadata.depth ?? 1,
        },
      },
    };

    this.parentEmitter(namespacedEvent);
  }

  shouldEmit(eventType: string): boolean {
    return !this.suppressedTypes.has(eventType);
  }
}
```

## 7. Tool Registry Cloning

### 7.1 Clone Options

```typescript
// File: src/tools/ToolRegistryCloner.ts

export interface ToolCloneOptions {
  /**
   * Tools to include (allowlist).
   * If undefined, include all tools.
   */
  include?: string[];

  /**
   * Tools to exclude (denylist).
   * Applied after include filter.
   */
  exclude?: string[];

  /**
   * Override handlers for specific tools.
   * Useful for injecting sub-agent-specific context.
   */
  handlerOverrides?: Record<string, ToolHandler>;

  /**
   * Override risk assessors for specific tools.
   */
  assessorOverrides?: Record<string, IRiskAssessor>;

  /**
   * Default risk level for tools without assessors.
   */
  defaultRiskLevel?: 'low' | 'medium' | 'high';
}
```

### 7.2 Clone Implementation

```typescript
// File: src/tools/ToolRegistryCloner.ts

export function cloneToolRegistry(
  source: ToolRegistry,
  options: ToolCloneOptions = {}
): ToolRegistry {
  const clone = new ToolRegistry();

  for (const [name, entry] of source.entries()) {
    // Apply include filter
    if (options.include && !options.include.includes(name)) {
      continue;
    }

    // Apply exclude filter
    if (options.exclude?.includes(name)) {
      continue;
    }

    // Get handler (with possible override)
    const handler = options.handlerOverrides?.[name] ?? entry.handler;

    // Get risk assessor (with possible override)
    const riskAssessor = options.assessorOverrides?.[name]
      ?? entry.riskAssessor
      ?? new StaticRiskAssessor(options.defaultRiskLevel ?? 'low');

    clone.register(entry.definition, handler, riskAssessor);
  }

  return clone;
}

/**
 * Convenience function for creating sub-agent tool registries.
 */
export function createSubAgentToolRegistry(
  parentRegistry: ToolRegistry,
  subAgentType: SubAgentTypeConfig
): ToolRegistry {
  return cloneToolRegistry(parentRegistry, {
    include: subAgentType.allowedTools,
    exclude: subAgentType.deniedTools ?? [
      // Default dangerous tools to exclude
      'terminal',
      'execute_command',
      'file_write',
      'file_delete',
    ],
    defaultRiskLevel: 'low',  // Sub-agents auto-approve
  });
}
```

## 8. RepublicAgent as Backend Orchestrator

### 8.1 Design Philosophy

RepublicAgent becomes a **thin backend orchestrator** that:
1. Owns the `IPlatformAdapter` for platform-specific operations
2. Owns an `RepublicAgentEngine` for all execution (delegates SQ/EQ to it)
3. Handles orchestration concerns (config subscriptions, tab binding, channel dispatch)
4. Forwards operations to the engine and events to external channels (UI is one such channel)

### 8.2 Implementation

```typescript
// File: src/core/RepublicAgent.ts

export class RepublicAgent {
  private config: AgentConfig;
  private platformAdapter: IPlatformAdapter;
  private engine: RepublicAgentEngine;
  private modelClientFactory: ModelClientFactory;
  private userNotifier?: IUserNotifier;
  private eventDispatcher?: (event: Event) => void;

  // Config state
  private pendingModelKey?: string;

  constructor(
    config: AgentConfig,
    platformAdapter: IPlatformAdapter,
    initialHistory?: InitialHistory,
    agentId?: string,
    userNotifier?: IUserNotifier
  ) {
    this.config = config;
    this.platformAdapter = platformAdapter;
    this.userNotifier = userNotifier;
    this.modelClientFactory = new ModelClientFactory();

    // Create tool registry and register platform tools (done in initialize)
    const toolRegistry = new ToolRegistry();

    // Get approval policies from platform
    const policies = platformAdapter.getApprovalPolicies();
    const approvalManager = new ApprovalManager(policies);

    // Create the core engine
    this.engine = new RepublicAgentEngine({
      agentConfig: config,
      toolRegistry,
      systemPrompt: '',  // Set during initialize
      modelClientFactory: this.modelClientFactory,
      persistent: true,
      approvalPolicy: approvalManager,
      initialHistory,
    });

    this.setupConfigSubscriptions();
  }

  async initialize(): Promise<void> {
    // Initialize platform adapter
    await this.platformAdapter.initialize();

    // Register platform-specific tools
    const modelData = await this.config.getSelectedModel();
    await this.platformAdapter.registerPlatformTools(
      this.engine.getToolRegistry(),
      this.config.getToolsConfig(),
      { supportsImage: modelData.model.supportsImage }
    );

    // Initialize model client factory
    await this.modelClientFactory.initialize(this.config);

    // Initialize engine
    await this.engine.initialize();

    // Start event forwarding loop
    this.startEventForwarding();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Public API (delegates to engine)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Submit an operation. Handles tab binding before delegating.
   */
  async submitOperation(op: Op, context?: OperationContext): Promise<string> {
    // Handle orchestration-only operations locally
    if (this.isOrchestrationOp(op)) {
      return this.handleOrchestrationOp(op);
    }

    // Handle tab binding for execution operations
    if (this.needsTabBinding(op)) {
      await this.handleTabBinding(context);
    }

    // Apply pending model switch
    if (this.pendingModelKey) {
      await this.applyPendingModelSwitch();
    }

    // Delegate to engine
    return this.engine.submitOperation(op as EngineOp);
  }

  /**
   * Get next event (delegates to engine).
   */
  async getNextEvent(): Promise<Event> {
    return this.engine.getNextEvent();
  }

  /**
   * Set event dispatcher for channel routing.
   */
  setEventDispatcher(dispatcher: (event: Event) => void): void {
    this.eventDispatcher = dispatcher;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Child Engine Factory
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Create a child engine for sub-agents.
   */
  createChildEngine(config: Partial<RepublicAgentEngineConfig>): RepublicAgentEngine {
    // Get browser controller if needed
    let browserContext: RepublicAgentEngineConfig['browserContext'];
    if (config.browserContext === undefined && this.platformAdapter.hasBrowserTools) {
      const tabId = this.engine.getSession().getTabId();
      const controller = this.platformAdapter.getBrowserController(tabId);
      if (controller) {
        browserContext = { tabId, controller };
      }
    }

    return new RepublicAgentEngine({
      agentConfig: this.config,
      modelClientFactory: this.modelClientFactory,
      toolRegistry: config.toolRegistry ?? this.engine.getToolRegistry(),
      systemPrompt: config.systemPrompt ?? '',
      approvalPolicy: config.approvalPolicy ?? 'auto',
      browserContext: config.browserContext ?? browserContext,
      persistent: false,  // Sub-agents are ephemeral
      ...config,
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Orchestration-Specific Handlers
  // ═══════════════════════════════════════════════════════════════════

  private async handleTabBinding(context?: { tabId?: number }): Promise<void> {
    const newTabId = context?.tabId ?? -1;
    const currentTabId = this.engine.getSession().getTabId();

    // Platforms without real tabs just use sentinel
    if (!this.platformAdapter.hasRealTabs) {
      this.engine.getSession().setTabId(1);
      return;
    }

    // Create new tab
    if (newTabId === -1) {
      const createdTabId = await this.platformAdapter.createTab({
        url: 'about:blank',
        active: true,
        groupName: 'ApplePi',
      });
      this.engine.getSession().setTabId(createdTabId);
      return;
    }

    // Reuse or switch tab
    if (newTabId !== currentTabId) {
      const validation = await this.platformAdapter.validateTab(newTabId);
      if (!validation.valid) {
        throw new TabValidationError(validation.reason);
      }
      await this.platformAdapter.switchTab(currentTabId, newTabId);
      this.engine.getSession().setTabId(newTabId);
    }
  }

  private setupConfigSubscriptions(): void {
    // Subscribe to model changes
    this.config.onModelChange((modelKey) => {
      this.pendingModelKey = modelKey;
    });

    // Subscribe to tools config changes
    this.config.onToolsConfigChange(async (toolsConfig) => {
      // Re-register platform tools
      const modelData = await this.config.getSelectedModel();
      await this.platformAdapter.registerPlatformTools(
        this.engine.getToolRegistry(),
        toolsConfig,
        { supportsImage: modelData.model.supportsImage }
      );
    });
  }

  private async applyPendingModelSwitch(): Promise<void> {
    if (!this.pendingModelKey) return;

    const modelKey = this.pendingModelKey;
    this.pendingModelKey = undefined;

    await this.engine.updateModelClient(modelKey);
  }

  private handleOrchestrationOp(op: OrchestrationOp): string {
    const id = uuidv4();

    switch (op.type) {
      case 'GetPath':
        // Return session path
        const path = this.engine.getSession().getPath();
        this.emitChannelEvent({ type: 'PathResult', data: { path } });
        break;

      case 'GetHistoryEntry':
        const entry = this.engine.getSession().getHistoryEntry(op.entryId);
        this.emitChannelEvent({ type: 'HistoryEntryResult', data: { entry } });
        break;

      // ... other orchestration operations
    }

    return id;
  }

  private startEventForwarding(): void {
    // Forward events from engine to external channels (e.g., UI)
    (async () => {
      while (!this.engine.isDisposed()) {
        const event = await this.engine.getNextEvent();
        this.eventDispatcher?.(event);
      }
    })();
  }

  private emitChannelEvent(msg: EventMsg): void {
    const event: Event = { id: uuidv4(), msg };
    this.eventDispatcher?.(event);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Accessors
  // ═══════════════════════════════════════════════════════════════════

  getSession(): Session { return this.engine.getSession(); }
  getToolRegistry(): ToolRegistry { return this.engine.getToolRegistry(); }
  getApprovalManager(): ApprovalManager { return this.engine.getApprovalManager(); }
  getModelClientFactory(): ModelClientFactory { return this.modelClientFactory; }
  getPlatformAdapter(): IPlatformAdapter { return this.platformAdapter; }
  getEngine(): RepublicAgentEngine { return this.engine; }

  isReady(): boolean {
    return this.engine.isReady() && this.platformAdapter !== undefined;
  }

  async dispose(): Promise<void> {
    await this.engine.dispose();
    await this.platformAdapter.dispose();
  }
}
```

### 8.3 Public API Impact

| Method | Change |
|--------|--------|
| `constructor()` | **CHANGED** — requires `platformAdapter` parameter |
| `submitOperation()` | **CHANGED** — now delegates to engine after tab binding |
| `getNextEvent()` | **CHANGED** — now delegates to engine |
| `setEventDispatcher()` | No change |
| `getSession()` | **CHANGED** — now delegates to engine |
| `getToolRegistry()` | **CHANGED** — now delegates to engine |
| `getApprovalManager()` | **CHANGED** — now delegates to engine |
| `getModelClientFactory()` | No change |
| `getPlatformAdapter()` | **NEW** — expose platform adapter |
| `getEngine()` | **NEW** — expose internal engine |
| `createChildEngine()` | **NEW** — factory for sub-agent engines |
| `initialize()` | **CHANGED** — initializes adapter and engine |
| `dispose()` | **NEW** — disposes engine and adapter |

**Breaking changes:**
1. Constructor now requires `platformAdapter` parameter
2. Internal implementation completely restructured (delegates to RepublicAgentEngine)

**Backwards compatible:** All existing public methods still work, they just delegate internally.

## 9. How Sub-Agents Use RepublicAgentEngine

### 9.1 Basic Usage (Awaitable Mode)

```typescript
// File: src/subagent/SubAgentRunner.ts

export class SubAgentRunner {
  constructor(private parentAgent: RepublicAgent) {}

  async run(params: SubAgentToolParams): Promise<SubAgentResult> {
    const typeConfig = getSubAgentType(params.type);

    // Create restricted tool registry
    const childRegistry = createSubAgentToolRegistry(
      this.parentAgent.getToolRegistry(),
      typeConfig
    );

    // Create event router for namespaced events
    const eventRouter = new SubAgentEventRouter({
      parentEmitter: (event) => this.parentAgent.getEngine().pushEvent(event),
      engineId: uuidv4(),
      suppressedTypes: typeConfig.suppressedEvents,
    });

    // Create child engine via parent's factory
    const engine = this.parentAgent.createChildEngine({
      toolRegistry: childRegistry,
      systemPrompt: typeConfig.systemPrompt,
      model: typeConfig.model,
      maxTurns: typeConfig.maxTurns,
      approvalPolicy: 'auto',  // Auto-approve for sub-agents
      eventRouter,
    });

    try {
      await engine.initialize();

      // Run single prompt (awaitable mode)
      const input: InputItem[] = [{ type: 'text', text: params.prompt }];
      const result = await engine.run(input, {
        maxTurns: typeConfig.maxTurns,
        signal: params.signal,
      });

      return {
        success: result.success,
        response: result.response ?? '',
        runId: result.engineId,
        turnCount: result.turnCount,
        tokenUsage: result.tokenUsage,
        stopReason: result.stopReason,
        error: result.error,
      };
    } finally {
      await engine.dispose();
    }
  }
}
```

### 9.2 Multi-Turn Sub-Agent (Using Queue)

```typescript
// For sub-agents that need multiple turns of interaction

async runMultiTurn(params: MultiTurnSubAgentParams): Promise<SubAgentResult> {
  const engine = this.parentAgent.createChildEngine({
    toolRegistry: this.createRestrictedRegistry(params.type),
    systemPrompt: params.systemPrompt,
    approvalPolicy: 'auto',
  });

  await engine.initialize();

  try {
    // Run multiple prompts in sequence
    const results = await engine.runMultiple(params.prompts, {
      signal: params.signal,
    });

    // Return combined result
    return {
      success: results.every(r => r.success),
      responses: results.map(r => r.response),
      totalTurns: results.reduce((sum, r) => sum + r.turnCount, 0),
      // ...
    };
  } finally {
    await engine.dispose();
  }
}
```

### 9.3 Interactive Sub-Agent (Using SQ/EQ Directly)

```typescript
// For sub-agents that need to handle approvals or custom events

async runInteractive(params: InteractiveSubAgentParams): Promise<SubAgentResult> {
  const engine = this.parentAgent.createChildEngine({
    toolRegistry: this.createRestrictedRegistry(params.type),
    systemPrompt: params.systemPrompt,
    approvalPolicy: 'interactive',  // Require approval handling
  });

  await engine.initialize();

  try {
    // Submit the operation
    const submissionId = engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: params.prompt }],
    });

    // Process events until completion
    while (true) {
      const event = await engine.getNextEvent();

      if (event.msg.type === 'ApprovalRequired') {
        // Custom approval logic
        const approved = await params.approvalHandler(event.msg.data);
        engine.approveExecution(event.msg.data.callId, approved);
        continue;
      }

      if (event.msg.type === 'TaskComplete') {
        return {
          success: true,
          response: event.msg.data.response,
          // ...
        };
      }

      if (event.msg.type === 'TaskError') {
        return {
          success: false,
          error: event.msg.data.error,
          // ...
        };
      }
    }
  } finally {
    await engine.dispose();
  }
}
```

## 10. Sub-Agent Tool & Types

### 10.1 SubAgentTool Definition

The tool definition registered in the parent's ToolRegistry that the LLM invokes to spawn sub-agents.

```typescript
// File: src/core/subagent/SubAgentTool.ts

import type { ToolDefinition } from '../tools/ToolRegistry';
import type { SubAgentTypeConfig } from './types';

/**
 * Build the sub_agent tool definition.
 * The type enum is dynamically populated from registered sub-agent types.
 */
export function buildSubAgentToolDefinition(
  types: SubAgentTypeConfig[]
): ToolDefinition {
  const typeDescriptions = types
    .map(t => `- "${t.id}": ${t.description}`)
    .join('\n');

  return {
    type: 'function',
    function: {
      name: 'sub_agent',
      description: `Delegate a task to a specialized sub-agent. The sub-agent runs independently with its own context and returns a result. Use this when a task is self-contained and can be fully described in the prompt.

Available types:
${typeDescriptions}`,
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: types.map(t => t.id),
            description: 'Which sub-agent type to invoke',
          },
          prompt: {
            type: 'string',
            description: 'Complete task description with all necessary context. The sub-agent has NO access to your conversation history — include everything it needs.',
          },
          description: {
            type: 'string',
            description: 'Short (3-5 word) summary of what the sub-agent will do',
          },
          background: {
            type: 'boolean',
            description: 'Run in background (you continue without waiting). Default: false',
          },
        },
        required: ['type', 'prompt'],
      },
    },
  };
}
```

### 10.2 SubAgentTypeConfig

```typescript
// File: src/core/subagent/types.ts

/**
 * Configuration for a sub-agent type.
 * Analogous to Claude Code's .claude/agents/*.md frontmatter.
 */
export interface SubAgentTypeConfig {
  /** Unique identifier for this sub-agent type (e.g., "researcher", "coder") */
  id: string;

  /** Human-readable name shown in tool description */
  name: string;

  /** Description of when to use this sub-agent — included in the sub_agent
   *  tool schema so the LLM knows when to delegate */
  description: string;

  /** System prompt for this sub-agent type */
  systemPrompt: string;

  /** Tool access control */
  tools?: {
    /** If set, only these tools are available (allowlist) */
    allow?: string[];
    /** If set, these tools are removed from available set (denylist) */
    deny?: string[];
  };

  /** Model override. If omitted, inherits parent's model */
  model?: string;

  /** Max turns before forced stop. Prevents runaway agents. Default: 25 */
  maxTurns?: number;

  /** Approval policy for the sub-agent. Default: 'never' (auto-approve) */
  approvalPolicy?: 'never' | 'inherit';

  /** Whether this type always runs in background. Default: false */
  background?: boolean;

  /** Event types to suppress when routing to parent (reduce noise) */
  suppressedEvents?: string[];
}

/**
 * Parameters for the sub_agent tool call (what the LLM provides)
 */
export interface SubAgentToolParams {
  /** Which sub-agent type to invoke */
  type: string;

  /** The task/prompt to send to the sub-agent */
  prompt: string;

  /** Short description of what the sub-agent will do (for logging) */
  description?: string;

  /** Run in background (parent continues without waiting). Default: false */
  background?: boolean;

  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

/**
 * Result returned from a sub-agent execution
 */
export interface SubAgentResult {
  /** Whether the sub-agent completed successfully */
  success: boolean;

  /** The sub-agent's final text response */
  response: string;

  /** Unique ID for this sub-agent run (for resumption/reference) */
  runId: string;

  /** Token usage for the sub-agent's execution */
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };

  /** Number of turns the sub-agent took */
  turnCount: number;

  /** Why the sub-agent stopped */
  stopReason: 'completed' | 'max_turns' | 'error' | 'cancelled';

  /** Error message if stopReason is 'error' */
  error?: string;
}
```

### 10.3 Built-in Sub-Agent Types

```typescript
// File: src/core/subagent/builtinTypes.ts

import type { SubAgentTypeConfig } from './types';

export const BUILTIN_SUBAGENT_TYPES: SubAgentTypeConfig[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    description: 'Fast read-only agent for exploring the codebase, searching files, reading documentation, and gathering information. Use when you need to find or understand something before acting.',
    systemPrompt: `You are a research assistant. Your job is to find information, read files, search code, and report back concisely.

Rules:
- Focus on gathering facts, not making changes
- Be thorough but concise in your findings
- Report file paths and line numbers when referencing code
- If you can't find what you're looking for, say so clearly`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'browser_screenshot', 'exec_command', 'sub_agent'],
    },
    maxTurns: 15,
    approvalPolicy: 'never',
    suppressedEvents: ['AgentMessageDelta', 'AgentReasoningDelta'],
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Agent for analyzing requirements and creating implementation plans. Use when you need to break down a complex task into steps before executing.',
    systemPrompt: `You are a planning assistant. Analyze the task, identify the files and components involved, and create a clear step-by-step plan.

Rules:
- Read relevant code before planning
- Identify dependencies between steps
- Note potential risks or edge cases
- Keep plans actionable and concrete`,
    tools: {
      deny: ['browser_dom', 'browser_navigate', 'exec_command', 'sub_agent'],
    },
    maxTurns: 20,
    approvalPolicy: 'never',
    suppressedEvents: ['AgentMessageDelta', 'AgentReasoningDelta'],
  },
  {
    id: 'worker',
    name: 'Worker',
    description: 'General-purpose agent that can read, write, and execute. Use for independent sub-tasks that can be fully described in the prompt without needing back-and-forth.',
    systemPrompt: `You are a task executor. Complete the assigned task efficiently and report what you did.

Rules:
- Do exactly what is asked, no more
- Report what you changed and why
- If you encounter an unexpected situation, describe it clearly`,
    tools: {
      deny: ['sub_agent'],  // No nesting
    },
    maxTurns: 25,
    approvalPolicy: 'never',
    suppressedEvents: ['AgentMessageDelta'],
  },
];
```

### 10.4 SubAgentRegistry

Tracks active sub-agents within a parent session scope.

```typescript
// File: src/core/subagent/SubAgentRegistry.ts

/**
 * Tracks an active sub-agent within a parent session
 */
export interface ActiveSubAgent {
  runId: string;
  type: string;
  description: string;
  parentSessionId: string;
  engine: RepublicAgentEngine;
  startTime: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
}

/**
 * SubAgentRegistry tracks active sub-agent runs within a parent session.
 *
 * Responsibilities:
 * - Track active sub-agents per parent session
 * - Enforce concurrency limits (max 3 concurrent sub-agents per parent)
 * - Cancel all sub-agents when parent session ends
 * - Provide status queries for display
 *
 * NOT a singleton — one per parent agent instance.
 */
export class SubAgentRegistry {
  private activeAgents = new Map<string, ActiveSubAgent>();
  private readonly maxConcurrent: number;

  constructor(options: { maxConcurrent?: number } = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 3;
  }

  register(agent: ActiveSubAgent): void {
    if (this.activeAgents.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent sub-agents (${this.maxConcurrent}) reached`);
    }
    this.activeAgents.set(agent.runId, agent);
  }

  unregister(runId: string): void {
    this.activeAgents.delete(runId);
  }

  get(runId: string): ActiveSubAgent | undefined {
    return this.activeAgents.get(runId);
  }

  getActive(): ActiveSubAgent[] {
    return Array.from(this.activeAgents.values())
      .filter(a => a.status === 'running');
  }

  async cancelAll(): Promise<void> {
    const running = this.getActive();
    await Promise.all(running.map(async (agent) => {
      agent.status = 'cancelled';
      await agent.engine.dispose();
    }));
    this.activeAgents.clear();
  }

  canSpawn(): boolean {
    return this.getActive().length < this.maxConcurrent;
  }
}
```

### 10.5 Sub-Agent Events

Sub-agent events are **not** forwarded directly to the parent's channel. Instead:

- Sub-agent events are collected internally by `SubAgentRunner`
- Parent channel sees only: `SubAgentStart`, `SubAgentComplete`, `SubAgentError` events
- These lightweight events show progress without flooding the channel

```typescript
// New event types in src/core/protocol/events.ts

interface SubAgentStartEvent {
  type: 'SubAgentStart';
  runId: string;
  subAgentType: string;
  description: string;
  background: boolean;
}

interface SubAgentCompleteEvent {
  type: 'SubAgentComplete';
  runId: string;
  subAgentType: string;
  turnCount: number;
  tokenUsage?: { input: number; output: number; total: number };
  duration: number;  // ms
}

interface SubAgentErrorEvent {
  type: 'SubAgentError';
  runId: string;
  subAgentType: string;
  error: string;
}
```

### 10.6 Background Execution (Phase 2)

**Foreground (default — Phase 1):**
```
Parent turn blocked → SubAgentRunner.run() → awaits completion → returns result
```

- Parent's agentic loop pauses on this tool call
- Sub-agent runs to completion
- Result returned as tool_call_output

**Background (Phase 2):**
```
Parent continues → SubAgentRunner.runBackground() → tracks in registry
  ...later...
Parent can query: sub_agent_status tool call → check if done
```

Background execution requires:
1. A `sub_agent_status` companion tool to check/retrieve results
2. The parent emits `SubAgentStart` event so channel can show a spinner
3. When done, result stored in `SubAgentRegistry` keyed by `runId`
4. Parent gets `SubAgentComplete` notification in its event stream

### 10.7 Error Handling

| Scenario | Behavior |
|---|---|
| Sub-agent exceeds maxTurns | Stop, return partial result + `stopReason: 'max_turns'` |
| Sub-agent tool call fails | Sub-agent handles internally (retry or give up) |
| Sub-agent throws unhandled error | Catch, return `stopReason: 'error'` with message |
| Parent cancelled while sub-agent running | Cancel sub-agent, return `stopReason: 'cancelled'` |
| Invalid sub-agent type | Return error immediately (no agent spawned) |
| Max concurrent sub-agents reached | Foreground: wait. Background: reject with error |
| Model API error (auth, rate limit) | Sub-agent retries per TurnManager logic, then fails |

### 10.8 Constraints & Non-Goals

**Hard Constraints:**
- **No nesting**: Sub-agents cannot invoke sub_agent tool (enforced by tool exclusion)
- **No parent history**: Sub-agents start with empty conversation history
- **No shared state**: Sub-agents don't share Session, history, or tool state with parent
- **No peer communication**: Sub-agents can't talk to each other

**Phase 1 Non-Goals (future consideration):**
- Background execution (Phase 2)
- Sub-agent resume/continuation (Phase 2)
- User-defined sub-agent types via config (Phase 2)
- Sub-agent memory persistence across sessions (Phase 3)
- Token budget per sub-agent (Phase 2)
- Sub-agent streaming to parent channel (Phase 2)

## 11. File Structure

```
src/
├── core/
│   ├── platform/
│   │   ├── IPlatformAdapter.ts           # Interface definition
│   │   └── types.ts                      # Shared platform types
│   ├── engine/
│   │   ├── RepublicAgentEngine.ts              # Core engine (~400 lines)
│   │   ├── RepublicAgentEngineConfig.ts        # Config types
│   │   ├── operations.ts                 # Operation type definitions
│   │   └── index.ts                      # Public exports
│   ├── events/
│   │   ├── IEventRouter.ts               # Event routing interface
│   │   └── SubAgentEventRouter.ts        # Sub-agent event namespacing
│   ├── subagent/
│   │   ├── types.ts                      # SubAgentTypeConfig, SubAgentToolParams
│   │   ├── builtinTypes.ts               # Built-in sub-agent type configs
│   │   ├── SubAgentTool.ts               # Tool definition builder
│   │   ├── SubAgentRunner.ts             # Spawn, run, collect, cleanup
│   │   ├── SubAgentRegistry.ts           # Track active sub-agents per parent
│   │   ├── register.ts                   # Bootstrap registration helper
│   │   └── index.ts                      # Public API exports
│   ├── RepublicAgent.ts                  # Backend orchestrator (~350 lines)
│   ├── Session.ts                        # (unchanged)
│   ├── TaskRunner.ts                     # (unchanged)
│   ├── TurnManager.ts                    # (unchanged)
│   └── ...
│
├── tools/
│   ├── ToolRegistry.ts                   # (add entries() method)
│   ├── ToolRegistryCloner.ts             # Tool cloning utilities
│   └── ...
│
├── extension/
│   ├── platform/
│   │   └── ExtensionPlatformAdapter.ts   # Extension implementation
│   ├── background/
│   │   └── service-worker.ts             # Creates adapter, injects
│   └── ...
│
├── desktop/
│   ├── platform/
│   │   └── DesktopPlatformAdapter.ts     # Desktop implementation
│   ├── agent/
│   │   └── DesktopAgentBootstrap.ts      # Creates adapter, injects
│   └── ...
│
└── server/
    ├── platform/
    │   └── ServerPlatformAdapter.ts      # Server implementation
    ├── agent/
    │   └── ServerAgentBootstrap.ts       # Creates adapter, injects
    └── ...
```

## 12. Implementation Tasks

### Phase 1: Core Engine (Foundation)

| Task | File | Description | Blocked By |
|------|------|-------------|------------|
| E1.1 | `src/core/engine/RepublicAgentEngineConfig.ts` | Define config + result + operation types | — |
| E1.2 | `src/core/events/IEventRouter.ts` | Define event routing interface | — |
| E1.3 | `src/core/events/SubAgentEventRouter.ts` | Implement sub-agent router | E1.2 |
| E1.4 | `src/core/engine/RepublicAgentEngine.ts` | Implement engine with SQ/EQ | E1.1, E1.3 |
| E1.5 | — | Unit tests for RepublicAgentEngine | E1.4 |

### Phase 2: Platform Abstraction

| Task | File | Description | Blocked By |
|------|------|-------------|------------|
| P2.1 | `src/core/platform/IPlatformAdapter.ts` | Define interface + types | — |
| P2.2 | `src/extension/platform/ExtensionPlatformAdapter.ts` | Implement for extension | P2.1 |
| P2.3 | `src/desktop/platform/DesktopPlatformAdapter.ts` | Implement for desktop | P2.1 |
| P2.4 | `src/server/platform/ServerPlatformAdapter.ts` | Implement for server | P2.1 |
| P2.5 | — | Unit tests for each adapter | P2.2, P2.3, P2.4 |

### Phase 3: RepublicAgent Refactoring

| Task | File | Description | Blocked By |
|------|------|-------------|------------|
| R3.1 | `src/core/RepublicAgent.ts` | Refactor to use RepublicAgentEngine internally | E1.4, P2.2, P2.3, P2.4 |
| R3.2 | `src/core/RepublicAgent.ts` | Add createChildEngine() method | R3.1 |
| R3.3 | `src/*/bootstrap/*.ts` | Update bootstraps to create adapters | R3.1 |
| R3.4 | — | Integration tests for RepublicAgent | R3.2 |

### Phase 4: Tool Registry Cloning

| Task | File | Description | Blocked By |
|------|------|-------------|------------|
| T4.1 | `src/tools/ToolRegistry.ts` | Add entries() method | — |
| T4.2 | `src/tools/ToolRegistryCloner.ts` | Implement cloning utilities | T4.1 |
| T4.3 | — | Unit tests for cloning | T4.2 |

### Phase 5: Sub-Agent Integration

| Task | File | Description | Blocked By |
|------|------|-------------|------------|
| S5.1 | `src/core/subagent/types.ts` | Define type config interface | — |
| S5.2 | `src/core/subagent/builtinTypes.ts` | Define built-in sub-agent types | S5.1 |
| S5.3 | `src/core/subagent/SubAgentTool.ts` | Build tool definition | S5.2 |
| S5.4 | `src/core/subagent/SubAgentRegistry.ts` | Track active sub-agents | — |
| S5.5 | `src/core/subagent/SubAgentRunner.ts` | Implement runner | R3.2, T4.2, S5.3, S5.4 |
| S5.6 | `src/core/subagent/register.ts` | Bootstrap registration helper | S5.5 |
| S5.7 | — | Integration tests | S5.6 |

### Dependency Graph

```
Phase 1 (Engine):
E1.1 ──┬── E1.4 ── E1.5
E1.2 ──┼── E1.3 ──┘
       └──────────┘

Phase 2 (Platform) - parallel with Phase 1:
P2.1 ─┬─ P2.2 ─┐
      ├─ P2.3 ─┼─ P2.5
      └─ P2.4 ─┘

Phase 3 (RepublicAgent):
E1.4 + P2.2/3/4 ─── R3.1 ── R3.2 ── R3.3 ── R3.4

Phase 4 (Cloning) - can start anytime:
T4.1 ── T4.2 ── T4.3

Phase 5 (Sub-Agent):
S5.1 ── S5.2 ── S5.3 ─┐
S5.4 ─────────────────┼── S5.5 ── S5.6 ── S5.7
R3.2 + T4.2 ──────────┘
```

**Critical Path:** E1.1 → E1.4 → R3.1 → R3.2 → S5.5

**Parallelization:**
- Phase 1 (Engine) and Phase 2 (Platform) can run in parallel
- Phase 4 (Cloning) can start anytime and run in parallel

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Breaking change to RepublicAgent constructor | All bootstraps must update | Phased rollout: implement adapters first, then switch |
| Platform adapter initialization order | Adapter may not be ready when needed | Explicit initialize() call before use |
| Session constructor side effects | Memory leaks, disk writes | `persistent: false` skips rollout init; dispose() cleans up |
| Tool handlers closing over parent state | Incorrect behavior in sub-agents | Tool handlers use execution request context, not closures |
| MCP connection failures in adapters | Browser tools unavailable | Graceful degradation: hasBrowserTools flag, warn but continue |
| Event routing overhead | Performance impact | Suppress verbose events; batch if needed |
| Nested sub-agents | Stack overflow, resource exhaustion | sub_agent tool always excluded from sub-agent registry |
| Token cost explosion (sub-agent makes many tool calls) | High cost | maxTurns limit + future token budget |
| Context bloat (large sub-agent results) | Parent context consumed | Sub-agent instructed to be concise in system prompt; consider truncation |
| Stale model client (sub-agent uses expired auth) | API errors | Share parent's ModelClientFactory (auto-refreshes) |
| LLM over-delegates (uses sub-agent for simple tasks) | Unnecessary cost | System prompt guidance: "only delegate complex tasks" |
| Sub-agent hangs on a single tool call | Parent blocks indefinitely | maxDurationMs wall-clock timeout wrapping engine.run() |

## 14. Migration Guide

### 14.1 Updating Extension Bootstrap

```typescript
// BEFORE
const agent = new RepublicAgent(config, initialHistory);

// AFTER
import { ExtensionPlatformAdapter } from '../platform/ExtensionPlatformAdapter';

const platformAdapter = new ExtensionPlatformAdapter();
const agent = new RepublicAgent(config, platformAdapter, initialHistory);
```

### 14.2 Updating Desktop Bootstrap

```typescript
// BEFORE
const agent = new RepublicAgent(config);
// ... scattered MCP connection code ...

// AFTER
import { DesktopPlatformAdapter } from '../platform/DesktopPlatformAdapter';

const platformAdapter = new DesktopPlatformAdapter();
const agent = new RepublicAgent(config, platformAdapter);
// MCP connection now handled inside adapter.initialize()
```

### 14.3 Updating Server Bootstrap

```typescript
// BEFORE
const agent = new RepublicAgent(config);
// ... scattered browser endpoint code ...

// AFTER
import { ServerPlatformAdapter } from '../platform/ServerPlatformAdapter';

const platformAdapter = new ServerPlatformAdapter();
const agent = new RepublicAgent(config, platformAdapter);
// Browser endpoint now handled inside adapter.initialize()
```

### 14.4 Registering Sub-Agent Tool

```typescript
// In ServerAgentBootstrap.ts, DesktopAgentBootstrap.ts, service-worker.ts

// After registering platform tools...
import { registerSubAgentTool } from '../core/subagent/register';
import { BUILTIN_SUBAGENT_TYPES } from '../core/subagent/builtinTypes';

// Register sub-agent tool with built-in types
registerSubAgentTool(agent, {
  types: BUILTIN_SUBAGENT_TYPES,
  maxConcurrent: 3,
});
```

## 15. Future Considerations

### 15.1 Unifying Execution Paths

After RepublicAgentEngine is proven stable, RepublicAgent's `processUserInputWithTask()` could delegate to an internal RepublicAgentEngine:

```typescript
private async processUserInputWithTask(items, overrides, newTask, context) {
  await this.handleTabBinding(context);
  await this.applyPendingModelSwitch();

  // Future: delegate to internal engine
  const result = await this.engine.run(inputItems);

  this.emitEvent({ type: 'TaskComplete', data: { ... } });
}
```

### 15.2 New Platform Support

Adding a new platform (e.g., VS Code extension, mobile app) requires:

1. Implement `IPlatformAdapter` for the platform
2. Create bootstrap that instantiates adapter + RepublicAgent
3. No changes to RepublicAgent or RepublicAgentEngine

### 15.3 Sub-Agent Browser Access

Some sub-agents may need browser capabilities (e.g., screenshot analyzer). The `browserContext` config option supports this:

```typescript
const engine = parentAgent.createChildEngine({
  browserContext: {
    tabId: parentSession.getTabId(),
    controller: await platformAdapter.getBrowserController(tabId),
  },
  // ... other config
});
```

## 16. Comparison with Claude Code

| Aspect | Claude Code | Our Design |
|---|---|---|
| Tool name | `Agent` | `sub_agent` |
| Type definitions | `.md` files with YAML frontmatter | TypeScript config objects (Phase 1), file-based (Phase 2) |
| Context passing | `prompt` param only | `prompt` param only (same) |
| Result return | Last text message | Last AgentMessage event text (same pattern) |
| Nesting | Sub-agents cannot spawn sub-agents | Same |
| Tool restrictions | `tools`/`disallowedTools` fields | `tools.allow`/`tools.deny` (same semantics) |
| Model override | `model` field (sonnet/opus/haiku/inherit) | `model` field (compositeKey or inherit) |
| Background | Yes, with pre-approved permissions | Phase 2 |
| Resume | Yes, via agentId | Phase 2 |
| Worktree isolation | Yes, git worktree per agent | N/A (browser context, not filesystem) |
| Max turns | `maxTurns` field | `maxTurns` field (same) |
| Discovery | Auto-load from `.claude/agents/` | Programmatic registration (Phase 1) |
| Memory | Persistent memory directories | Phase 3 |

## 17. Summary

This refactoring achieves four goals:

### 1. Core Engine with Queue Support

`RepublicAgentEngine` is the **complete execution engine** that owns:
- Submission Queue (SQ) for handling multiple operations
- Event Queue (EQ) for emitting events
- Approval routing with configurable policy
- Dual-mode operation: Interactive (SQ/EQ) or Awaitable (run/runMultiple)

This enables sub-agents to handle multi-turn conversations and proper message sequencing.

### 2. Platform Abstraction

`IPlatformAdapter` extracts all platform-specific logic:
- Tab management (create, validate, switch)
- Browser controller instantiation
- Platform-specific tool registration
- Approval policies

Zero `__BUILD_MODE__` checks remain in core code.

### 3. Thin Backend Orchestrator

`RepublicAgent` becomes a thin orchestrator (~350 lines) that:
- Owns the platform adapter
- Owns an RepublicAgentEngine (delegates all execution)
- Handles orchestration concerns (config subscriptions, tab binding, channel dispatch)
- UI is an external channel that connects to this backend

| Metric | Before | After |
|--------|--------|-------|
| RepublicAgent lines | ~1319 | ~350 (orchestrator) |
| RepublicAgentEngine lines | N/A | ~400 (core engine) |
| `__BUILD_MODE__` checks in core | 6+ | 0 |
| SQ/EQ location | RepublicAgent | RepublicAgentEngine |
| Sub-agent queue support | ❌ | ✅ Full SQ/EQ |
| Sub-agent multi-turn | ❌ | ✅ runMultiple() |
| Platform-specific code | Scattered | Isolated in adapters |
| Adding new platform | Modify core files | Implement adapter only |
| Testing core execution | Requires full agent | Test RepublicAgentEngine directly |

### 4. Sub-Agent Tool System

The `sub_agent` tool enables the LLM to delegate tasks to child engines:
- Built-in types: researcher, planner, worker
- Tool restrictions via allow/deny lists
- Auto-approve policy for sub-agents
- Event routing to parent with suppression of verbose events
- SubAgentRegistry for concurrency control

### Key Architectural Decisions

1. **SQ/EQ in RepublicAgentEngine**: Sub-agents need queue support for multi-turn conversations and handling interrupts. Moving SQ/EQ to the core engine makes this available to all execution contexts.

2. **RepublicAgent as Backend Orchestrator**: Tab binding, config subscriptions, and channel dispatch are orchestration concerns that don't belong in the core engine. RepublicAgent handles these before/after delegating to the engine. UI is an external channel.

3. **Dual-Mode Engine**: Interactive mode (submitOperation/getNextEvent) for channel-driven execution (e.g., UI), Awaitable mode (run/runMultiple) for programmatic execution. Same underlying queue, different consumption patterns.

4. **Platform Adapter Injection**: Dependency injection makes RepublicAgent testable and extensible without modifying core code.
