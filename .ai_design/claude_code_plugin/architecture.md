# Architecture — Claude Code Plugin System for BrowserX

## Module Layout

```
src/core/plugins/                    ← NEW shared module (all platforms)
├── types.ts                         ← Plugin types, manifest schema, hook config
├── PluginManifestLoader.ts          ← Parse plugin.json + auto-discover components
├── PluginManager.ts                 ← Central lifecycle (install/enable/load/disable)
├── PluginCache.ts                   ← Local cache management
├── PluginSkillLoader.ts             ← Load & namespace skills from plugins
├── PluginAgentLoader.ts             ← Load agent markdown definitions
├── PluginMCPLoader.ts               ← Load & start MCP servers from plugins
├── PluginSettingsLoader.ts          ← Load plugin settings.json
├── HookRunner.ts                    ← Execute hooks on events
├── HookDispatcher.ts                ← Route events to matching hooks
├── MarketplaceClient.ts             ← Marketplace discovery & installation
└── PluginLSPLoader.ts               ← Load LSP server configs (desktop/server)

src/extension/plugins/               ← Extension-specific adapters
├── ExtensionPluginStorage.ts        ← IndexedDB/chrome.storage for plugin state
└── ExtensionHookAdapter.ts          ← Limited hook support (prompt hooks only)

src/desktop/plugins/                  ← Desktop-specific adapters
├── TauriPluginStorage.ts            ← File-based plugin cache + Tauri config
└── TauriHookAdapter.ts              ← Full hook support via Tauri commands

src/server/plugins/                   ← Server-specific adapters (alongside existing)
├── ServerPluginStorage.ts           ← File-based plugin cache
└── ServerHookAdapter.ts             ← Full hook support via child_process
```

## Core Types

```typescript
// src/core/plugins/types.ts

/** Claude Code-compatible plugin manifest */
interface PluginManifest {
  name: string;                          // required, kebab-case
  version?: string;                      // semver
  description?: string;
  author?: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];

  // Component paths (supplement defaults, don't replace)
  commands?: string | string[];          // additional command files/dirs
  agents?: string | string[];            // additional agent files
  skills?: string | string[];            // additional skill dirs
  hooks?: string | string[] | HookConfig; // hook config paths or inline
  mcpServers?: string | string[] | MCPConfig; // MCP paths or inline
  lspServers?: string | string[] | LSPConfig; // LSP paths or inline
  outputStyles?: string | string[];
}

/** Plugin installation scope */
type PluginScope = 'user' | 'project' | 'local' | 'managed';

/** Resolved plugin with all components discovered */
interface ResolvedPlugin {
  manifest: PluginManifest;
  rootPath: string;
  scope: PluginScope;
  enabled: boolean;

  // Discovered components
  skills: PluginSkill[];
  commands: PluginCommand[];
  agents: PluginAgent[];
  hooks: HookConfig | null;
  mcpServers: MCPServerConfig[];
  lspServers: LSPServerConfig[];
  settings: PluginSettings | null;
}

/** Hook configuration (mirrors Claude Code format) */
interface HookConfig {
  hooks: {
    [event in HookEvent]?: HookRule[];
  };
}

type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'Notification'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PermissionRequest'
  | 'TeammateIdle'
  | 'TaskCompleted';

interface HookRule {
  matcher?: string;    // regex to match tool names, etc.
  hooks: HookAction[];
}

interface HookAction {
  type: 'command' | 'prompt' | 'agent';
  command?: string;    // for type: command
  prompt?: string;     // for type: prompt
  agent?: string;      // for type: agent
}

/** Plugin settings (currently only agent key) */
interface PluginSettings {
  agent?: string;      // activate a plugin agent as main thread
}
```

## Data Flow

### Plugin Loading Sequence

```
Application Start
    │
    ├── PluginManager.initialize()
    │       │
    │       ├── Load enabled plugins from settings (per scope)
    │       │     user:    ~/.browserx/settings.json → enabledPlugins[]
    │       │     project: .claude/settings.json → enabledPlugins[]
    │       │     local:   .claude/settings.local.json → enabledPlugins[]
    │       │
    │       ├── Load --plugin-dir plugins (dev mode, desktop/server only)
    │       │
    │       ├── For each plugin directory:
    │       │     PluginManifestLoader.load(dir)
    │       │       ├── Parse .claude-plugin/plugin.json (or derive from dir name)
    │       │       ├── Auto-discover: skills/, commands/, agents/, hooks/, .mcp.json
    │       │       ├── Resolve ${CLAUDE_PLUGIN_ROOT} in all paths
    │       │       └── Return ResolvedPlugin
    │       │
    │       ├── For each resolved plugin:
    │       │     ├── PluginSkillLoader.load(plugin)
    │       │     │     → Register namespaced skills in SkillRegistry
    │       │     │
    │       │     ├── PluginAgentLoader.load(plugin)
    │       │     │     → Register namespaced agents
    │       │     │
    │       │     ├── PluginMCPLoader.load(plugin)
    │       │     │     → Start MCP servers via MCPManager
    │       │     │
    │       │     ├── PluginLSPLoader.load(plugin) [desktop/server only]
    │       │     │     → Start LSP servers
    │       │     │
    │       │     ├── HookDispatcher.register(plugin)
    │       │     │     → Register hook rules for event matching
    │       │     │
    │       │     └── PluginSettingsLoader.apply(plugin)
    │       │           → Apply plugin default settings
    │       │
    │       └── Ready
    │
    └── Normal agent operation with plugin components active
```

### Hook Execution Flow

```
Event Occurs (e.g., PostToolUse)
    │
    ├── TurnManager / Session / Agent emits event
    │
    ├── HookDispatcher.dispatch(event, context)
    │     │
    │     ├── Find matching HookRules for this event
    │     │     (check matcher regex against tool name, etc.)
    │     │
    │     └── For each matching rule:
    │           │
    │           ├── type: "command"
    │           │     └── HookRunner.execCommand(command, stdinJson)
    │           │           ├── Extension: SKIP (sandboxed) or use prompt fallback
    │           │           ├── Desktop: Tauri shell command
    │           │           └── Server: child_process.exec
    │           │
    │           ├── type: "prompt"
    │           │     └── HookRunner.execPrompt(prompt, context)
    │           │           └── Send to current model via ModelClientFactory
    │           │
    │           └── type: "agent"
    │                 └── HookRunner.execAgent(agentName, context)
    │                       └── Invoke named agent with tools
    │
    └── Continue normal flow
```

### Plugin Installation Flow

```
User: /plugin install my-plugin@marketplace --scope project
    │
    ├── MarketplaceClient.resolve("my-plugin", "marketplace")
    │     ├── Load marketplace.json from configured marketplace
    │     ├── Find plugin entry
    │     └── Return { source, version, pluginDir }
    │
    ├── PluginCache.cache(source, pluginDir)
    │     ├── Copy plugin directory to cache
    │     │     Extension: store in IndexedDB
    │     │     Desktop:   ~/.browserx/plugins/cache/my-plugin/
    │     │     Server:    $APPLEPI_DATA_DIR/plugins/cache/my-plugin/
    │     ├── Resolve symlinks during copy
    │     └── Return cached path
    │
    ├── PluginManager.addToSettings("my-plugin", scope: "project")
    │     └── Write to .claude/settings.json: enabledPlugins += "my-plugin@marketplace"
    │
    └── PluginManager.loadPlugin(cachedPath)
          └── (same as loading sequence above)
```

## Integration Points with Existing Code

### SkillRegistry Integration

```
Current:
  SkillRegistry.register(name, skill)        → /skill-name
  SkillRegistry.invoke("/skill-name", args)

With plugins:
  SkillRegistry.register(name, skill, { namespace?: string })
    → namespace ? /namespace:skill-name : /skill-name
  SkillRegistry.invoke("/plugin:skill-name", args)
    → resolves namespace, finds skill, invokes
```

**Files to modify:**
- `src/core/skills/SkillRegistry.ts` — add namespace parameter to register()
- `src/core/skills/SkillParser.ts` — add `$ARGUMENTS` support
- `src/core/skills/types.ts` — add namespace to `Skill` type

### TurnManager Integration (Hooks)

```
Current:
  TurnManager.executeTool(tool, input)
    → ToolRegistry.execute(tool, input)
    → return result

With hooks:
  TurnManager.executeTool(tool, input)
    → HookDispatcher.dispatch('PreToolUse', { tool, input })
    → ToolRegistry.execute(tool, input)
    → if success: HookDispatcher.dispatch('PostToolUse', { tool, input, result })
    → if failure: HookDispatcher.dispatch('PostToolUseFailure', { tool, input, error })
    → return result
```

**Files to modify:**
- `src/core/TurnManager.ts` — add hook dispatch around tool execution
- `src/core/Session.ts` — dispatch SessionStart/SessionEnd hooks
- `src/core/RepublicAgent.ts` — dispatch Stop hook

### MCPManager Integration

```
Current:
  MCPManager.addServer(config)     → manual add
  MCPManager.getServers()          → list all
  MCPManager.callTool(server, tool, args)

With plugins:
  PluginMCPLoader resolves ${CLAUDE_PLUGIN_ROOT} in config
  PluginMCPLoader calls MCPManager.addServer() for each plugin server
  Plugin disable → MCPManager.removeServer() for plugin servers
  Tools namespaced: plugin-name:server-name:tool-name
```

**Files to modify:**
- `src/core/mcp/MCPManager.ts` — add removeServer(), tag servers with plugin source
- `src/core/mcp/MCPConfig.ts` — add `${CLAUDE_PLUGIN_ROOT}` expansion

### ServiceRegistry Integration

```
New service paths:
  plugins.list        → list installed plugins
  plugins.install     → install a plugin
  plugins.uninstall   → uninstall a plugin
  plugins.enable      → enable a plugin
  plugins.disable     → disable a plugin
  plugins.reload      → reload all plugins
```

**Files to modify:**
- `src/core/channels/ServiceRegistry.ts` — register plugin service handlers

### AgentBootstrap Integration

Each platform's bootstrap needs to initialize PluginManager:

- `src/extension/background/service-worker.ts`
- `src/desktop/agent/DesktopAgentBootstrap.ts`
- `src/server/agent/ServerAgentBootstrap.ts`

## Platform-Specific Behavior

### Chrome Extension

| Feature | Support | Notes |
|---|---|---|
| Plugin loading | Yes | From IndexedDB/chrome.storage cache |
| Skills | Yes | Full support with namespacing |
| Agents | Yes | Full support |
| MCP (SSE) | Yes | Via existing MCPClient |
| MCP (stdio) | No | Not available in extension |
| Hooks (command) | No | Sandboxed — no shell access |
| Hooks (prompt) | Yes | Via model client |
| Hooks (agent) | Yes | Via agent infrastructure |
| LSP | No | No filesystem access |
| `--plugin-dir` | No | No CLI in extension |
| Marketplace | Yes | Via UI in settings page |
| Plugin cache | IndexedDB | Or chrome.storage.local |

### Desktop (Tauri)

| Feature | Support | Notes |
|---|---|---|
| Plugin loading | Yes | From `~/.browserx/plugins/` |
| Skills | Yes | Full support |
| Agents | Yes | Full support |
| MCP (SSE) | Yes | Via MCPClient |
| MCP (stdio) | Yes | Via RustMCPBridge |
| Hooks (command) | Yes | Via Tauri shell commands |
| Hooks (prompt) | Yes | Via model client |
| Hooks (agent) | Yes | Via agent infrastructure |
| LSP | Yes | Full support |
| `--plugin-dir` | Yes | Tauri CLI argument |
| Marketplace | Yes | Via UI + CLI |
| Plugin cache | Filesystem | `~/.browserx/plugins/cache/` |

### Server (Node.js)

| Feature | Support | Notes |
|---|---|---|
| Plugin loading | Yes | From `$APPLEPI_DATA_DIR/plugins/` |
| Skills | Yes | Full support |
| Agents | Yes | Full support |
| MCP (SSE) | Yes | Via MCPClient |
| MCP (stdio) | Yes | Via NodeMCPBridge |
| Hooks (command) | Yes | Via child_process |
| Hooks (prompt) | Yes | Via model client |
| Hooks (agent) | Yes | Via agent infrastructure |
| LSP | Yes | Full support |
| `--plugin-dir` | Yes | Node CLI argument |
| Marketplace | Yes | Via CLI |
| Plugin cache | Filesystem | `$APPLEPI_DATA_DIR/plugins/cache/` |

## Settings File Locations

### Plugin-Related Settings

```jsonc
// User scope: ~/.browserx/settings.json (or platform equivalent)
{
  "enabledPlugins": [
    "my-plugin@official",
    "team-tools@company-marketplace"
  ],
  "disabledPlugins": [
    "deprecated-plugin@official"
  ],
  "pluginMarketplaces": [
    "https://github.com/company/browserx-plugins"
  ]
}

// Project scope: .claude/settings.json (committed to git)
{
  "enabledPlugins": [
    "project-linter@company-marketplace"
  ]
}

// Local scope: .claude/settings.local.json (gitignored)
{
  "enabledPlugins": [
    "my-personal-plugin@local"
  ]
}
```

### Compatibility Note

Using `.claude/settings.json` (not `.browserx/`) for project scope ensures
plugins configured in a repo work in both Claude Code and BrowserX.
