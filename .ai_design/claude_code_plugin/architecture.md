# Architecture — Claude Code-Compatible Plugin System for WorkX

This describes the plugin system as implemented in `src/core/plugins/` plus its
per-surface adapters.

## Module Layout

```
src/core/plugins/                    ← shared, platform-agnostic
├── types.ts                         ← LoadedPlugin, scopes, hook/manifest types
├── PluginManifest.ts                ← Zod manifest schema + validation
├── PluginLoader.ts                  ← Parse plugin.json → LoadedPlugin (disabled)
├── PluginRegistry.ts                ← Lifecycle: enable/disable/reload/bootstrap
├── PluginProvider.ts               ← IPluginProvider (platform storage contract)
├── PluginSessionBinder.ts           ← Per-session hook + sub-agent binding
├── PluginInstaller.ts               ← PluginInstaller + PluginUninstaller
├── PluginCache.ts                   ← Versioned cache + orphan GC
├── installedPlugins.ts              ← installed_plugins_v2.json store
├── PluginOptions.ts                 ← Per-plugin userConfig + secrets
├── PluginCommandLoader.ts           ← Global store for plugin prompt commands
├── PluginErrors.ts                  ← Structured PluginError
├── userConfigSubstitution.ts        ← ${CLAUDE_PLUGIN_ROOT}/${user_config.*}
├── policy.ts                        ← Admin policy load + enforcement
├── MarketplaceRegistry.ts           ← marketplace.json fetch + resolve
├── MarketplaceSchema.ts             ← Marketplace + PluginSource schemas
├── PluginInstaller / git.ts / pluginFetch.ts ← git clone + fetch
├── PluginAutoupdate.ts              ← SHA-diff autoupdate
├── dependencyResolver.ts            ← Transitive closure (post-order)
├── BundledPluginRegistry.ts         ← Compile-time bundled plugins
└── loaders/
    ├── SkillSlotLoader.ts           ← skills/  → SkillRegistry (global)
    ├── CommandSlotLoader.ts         ← commands/ → PluginCommandLoader (global)
    ├── McpSlotLoader.ts             ← mcpServers → MCPManager (global)
    ├── HookSlotLoader.ts            ← hooks → HookRegistry (per session)
    └── SubAgentSlotLoader.ts        ← agents/ → SubAgentRunner (per session)

src/server/storage/                  ← server + desktop provider
├── NodePluginProvider.ts            ← filesystem provider (~/.workx/plugins)
└── nodePluginFs.ts

src/extension/storage/               ← extension provider
└── IndexedDBPluginProvider.ts       ← one IndexedDB record per plugin
```

The three slot loaders that target **global** singletons (skills, commands, MCP)
are wired at bootstrap; the two that target **per-session** state (hooks,
sub-agents) are applied by `PluginSessionBinder` when a session is created.

## Core Types

```typescript
// src/core/plugins/types.ts + PluginManifest.ts (abridged)

/** Plugin manifest — loaded from `plugin.json` at the plugin root */
interface PluginManifest {
  name: string;            // required, kebab-case /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 1–64
  version: string;         // required
  description?: string;
  author?: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];

  // Capability slots
  skills?: string | string[];
  commands?: string | string[] | Record<string, CommandMetadata>;
  agents?: string | string[];
  mcpServers?: string | Record<string, Partial<IMCPServerConfig>> | Array<...>;
  hooks?: string | HooksConfig | Array<string | HooksConfig>;

  // Configuration
  settings?: Record<string, unknown>;
  userConfig?: Record<string, PluginUserConfigOption>; // typed, optionally `sensitive`

  // WorkX extensions (ignored by Claude Code)
  workx?: {
    domains?: string[];
    platforms?: ('desktop' | 'extension' | 'server')[];
    toolExposure?: Record<string, { mode?: string; searchHint?: string; displayName?: string }>;
  };
}

/** Installation scope */
type PluginScope = 'managed' | 'user' | 'project' | 'local';

/** Where a plugin came from */
type PluginSource =
  | { type: 'github'; repo: string; ref?: string; sha?: string }
  | { type: 'git'; url: string; ref?: string; sha?: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string }
  | { type: 'path'; path: string }
  | { type: 'bundled' };

/** A loaded plugin with runtime state */
interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;            // on-disk root, or 'bundled'
  scope: PluginScope;
  source: PluginSource;
  state:
    | { status: 'disabled' }
    | { status: 'enabling'; startedAt: number }
    | { status: 'enabled'; enabledAt: number; activeSlots: string[] }
    | { status: 'disabling'; startedAt: number }
    | { status: 'error'; lastError: PluginError; failedAt: number };
  loadErrors: PluginError[];
}

/** Hook config (mirrors Claude Code, plus WorkX events) */
type HookEvent =
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'SessionStart' | 'SessionEnd'
  | 'UserPromptSubmit' | 'Stop'
  | 'PermissionRequest' | 'PermissionDenied'
  | 'TaskCreated' | 'TaskCompleted'
  | 'PreCompact' | 'PostCompact' | 'ConfigChange';

interface HookAction { type: 'command' | 'prompt' | 'http'; /* … */ }
```

### Class Responsibilities

| Class | Owns |
|---|---|
| `PluginLoader` | Parse + Zod-validate `plugin.json` → `LoadedPlugin{status:'disabled'}` |
| `PluginRegistry` | In-memory plugin map, enable/disable/reload/bootstrap, per-plugin serialization, evicted set, session-binder fan-out |
| `PluginInstaller` / `PluginUninstaller` | Install (deps → policy → materialize → SHA-verify); uninstall (disable → orphan-mark) |
| `PluginSessionBinder` | Apply each enabled plugin's hook + sub-agent slots to a session; immediate unload on disable |
| `PluginCache` | `cache/<marketplace>/<plugin>/<version>/` layout, orphan markers, GC |
| `InstalledPluginsStore` | `installed_plugins_v2.json` (per-scope install ledger) |
| `PluginOptions` | Per-plugin `userConfig` values + sensitive secrets |
| `MarketplaceRegistry` | Fetch/resolve `marketplace.json`, source/name policy gates |
| `PluginAutoupdate` | SHA-diff update, delisting, fail-closed |
| `PolicyLoader` / `PluginPolicy` | Admin governance (allow/block plugins + marketplaces) |

## Data Flow

### Plugin Loading & Enable

```
Bootstrap (per surface)
    │
    ├── provider.initialize()                    (create plugins root / IDB store)
    ├── provider.listMeta() → load each → registry.register(LoadedPlugin)
    ├── registerBundledPlugin(...) for compile-time plugins
    │
    └── registry.bootstrapEnabledPlugins()
            │   (reads enabledPlugins from agentConfig, sorts, enables each)
            │
            └── registry.enable(id):
                  set state = enabling
                  resolve userConfig
                  ── ATOMIC 5-slot load (order: skills → hooks → mcp → agents → commands)
                  │     skillSlot.load    → SkillRegistry (namespaced, global)
                  │     hookSlot.load     → HookRegistry  (per session, via binders)
                  │     mcpSlot.load      → MCPManager    (global)
                  │     subAgentSlot.load → SubAgentRunner (per session, via binders)
                  │     commandSlot.load  → PluginCommandLoader (global)
                  ── on any thrown error: reverse-order rollback of completed slots
                  set state = enabled { activeSlots } ; persistEnabled(id,true)
```

Per-session slots (hooks, sub-agents) are applied to each live session by
`PluginSessionBinder.applyEnabledPlugins()` at session creation. Skills and MCP
are globally reachable, so they are loaded once into their singletons.

### Disable

`registry.disable(id)` unloads slots in reverse order (commands → agents → mcp →
hooks → skills), prunes the contribution from **every live session binder
immediately**, sets state `disabled`, and `persistEnabled(id, false)`. Newly
*enabled* plugins are not retro-injected into existing sessions; new sessions
pick them up.

### Install (server / desktop)

```
/plugin install <name>@<marketplace> [--scope ...]
    │
    ├── reject managed scope; policy.isBlockedByPolicy(id)
    ├── resolveDependencyClosure(id)            (post-order; root never skipped)
    ├── re-check every closure member vs policy (fail-closed)
    ├── setEnabled(closure, true)               (single atomic config write)
    └── materialize loop (deps before dependents):
          fetchPlugin(id)                        (git clone via git.ts)
          verify gitCommitSha == catalogue SHA   (fail-closed if pinned)
          provider.writeFiles(id, files)         (staging + rename / IDB txn)
          installed.addEntry(id, {scope, version, installPath, gitCommitSha})
          registry.register(await provider.load(id))
```

### Substitution

`userConfigSubstitution.ts` performs single-pass substitution:

- `${CLAUDE_PLUGIN_ROOT}` → plugin root (`provider.getRoot(id)`)
- `${CLAUDE_PLUGIN_DATA}` → plugin data dir
- `${user_config.KEY}` → resolved user config, with three modes:
  - **content-safe** (skill/agent/command bodies): sensitive keys become a
    `[sensitive option '…' not available in skill content]` placeholder
  - **strict** (MCP `env`/`command`/`args`, hook command strings): throws on
    missing key; sensitive values *are* substituted
  - **env injection** (hooks): `CLAUDE_PLUGIN_OPTION_<KEY>` env vars

## Integration Points with Existing Code

| System | Plugin integration |
|---|---|
| `SkillRegistry` (`src/core/skills/`) | `SkillSlotLoader` registers namespaced skills; `removeByPluginId()` on unload |
| `MCPManager` (`src/core/mcp/`) | `McpSlotLoader` calls `addServer({ pluginId })`; `removeByPluginId()` on unload; duplicate names suppressed |
| `HookRegistry` (`src/core/hooks/`) | `HookSlotLoader` registers per session via `registerFromConfig(..., {type:'plugin', pluginId})` |
| `SubAgentRunner` (`src/core/subagents/`) | `SubAgentSlotLoader` adds namespaced types per session; sensitive frontmatter dropped |
| `PluginCommandLoader` | `CommandSlotLoader` stores namespaced prompt commands globally |
| `agentConfig` | `enabledPlugins: Record<PluginId, boolean>` is the source of truth for enable intent |

## Platform-Specific Behavior

### Chrome Extension (`workx`)

| Feature | Support | Notes |
|---|---|---|
| Plugin storage | Yes | `IndexedDBPluginProvider` — one record per plugin (`idb://` virtual paths) |
| Skills | Yes | Global slot wired at boot |
| MCP (SSE) | Yes | Via `MCPManager` |
| MCP (stdio) | No | Not available in the extension |
| Hooks (`command`) | No | Sandboxed — no shell |
| Hooks (`prompt`/`http`) | Yes | Per session |
| Sub-agents | Yes | Per session |
| Marketplace / installer | No | Not wired in v1 |
| Settings store | `chrome.storage.local` | `agent_config` blob (`enabledPlugins`) |

### Desktop (`workx-desktop`) & Server (`workx-server`)

Desktop runs the server stack via `WorkXRuntimeBootstrap` (a thin specialization
of `ServerAgentBootstrap`), so their plugin behavior is identical aside from data
locations.

| Feature | Support | Notes |
|---|---|---|
| Plugin storage | Yes | `NodePluginProvider` — files under the plugins root |
| Skills / commands / sub-agents / MCP | Yes | Global (skills/MCP/commands) + per session (hooks/agents) |
| MCP (stdio) | Yes | Native process bridge |
| Hooks (`command`/`prompt`/`http`) | Yes | Full support |
| Marketplace + installer + autoupdate | Yes | Git-based |
| Plugins root | Filesystem | `~/.workx/plugins/` (overridable via `WORKX_DATA_DIR`) |
| Cache | Filesystem | `<root>/cache/<marketplace>/<plugin>/<version>/` |
| Settings store | `config-storage.json` | `agent_config` (`enabledPlugins`) under the data dir |

## Settings & State Locations

Plugin **enable intent** lives in `agentConfig.enabledPlugins`
(`Record<PluginId, boolean>`) — **not** in `.claude/` or `.workx/` project files:

- Extension: inside the `agent_config` record in `chrome.storage.local`
- Server / desktop: inside `agent_config` in `<dataDir>/config-storage.json`

Other state files (server/desktop):

- `<root>/installed_plugins_v2.json` — what is materialized on disk, per scope,
  with version + `gitCommitSha`
- Admin **policy** is loaded from a platform-specific location separate from user
  config (e.g. an OS policy file or `chrome.storage.managed`), never from
  `agentConfig`.
