# Implementation Plan — Claude Code Plugin System for BrowserX

## Phase Overview

| Phase | Name | Dependencies | Deliverables |
|---|---|---|---|
| 1 | Foundation | None | Types, manifest loader, plugin manager, cache |
| 2 | Skills | Phase 1 | Namespaced skill loading from plugins |
| 3 | ~~Hooks~~ | ~~Phase 1~~ | **Deferred — separate branch** |
| 4 | MCP | Phase 1 | Auto-start plugin MCP servers |
| 5 | Agents | Phase 1 | Markdown agent definitions from plugins |
| 6 | Marketplace | Phase 1 | Discovery, install, update from marketplace repos |
| 7 | LSP | Phase 1 | LSP server configs (desktop + server only) |

> **Note:** Phase 3 (Hooks) has been moved out of scope for this implementation.
> The hook system (HookDispatcher, HookRunner, platform adapters, TurnManager/Session
> injection points) will be designed and implemented on a separate branch ahead of
> this work. The plugin manifest schema retains the `hooks` field for forward
> compatibility, but `PluginManager` will skip hook loading until the hook system
> is available.

---

## Phase 1 — Foundation

### Goal
Load a plugin from a directory, parse its manifest, discover its components,
and manage enable/disable state across platforms.

### Deliverables

#### 1.1 Core Types (`src/core/plugins/types.ts`)
- `PluginManifest` interface (matching Claude Code schema)
- `PluginScope` type
- `ResolvedPlugin` interface
- `HookConfig`, `HookEvent`, `HookRule`, `HookAction` types
- `PluginSettings` interface
- `PluginState` (installed, enabled, disabled, error)

#### 1.2 Manifest Loader (`src/core/plugins/PluginManifestLoader.ts`)
- `load(pluginDir: string): ResolvedPlugin`
- Parse `.claude-plugin/plugin.json` if present
- Derive name from directory name if no manifest
- Auto-discover default directories: `skills/`, `commands/`, `agents/`, `hooks/`, `.mcp.json`, `.lsp.json`, `settings.json`
- Resolve custom paths from manifest (supplement, don't replace defaults)
- Expand `${CLAUDE_PLUGIN_ROOT}` in all string values
- Validate: name required, paths relative with `./`, valid JSON

#### 1.3 Plugin Manager (`src/core/plugins/PluginManager.ts`)
- Singleton, initialized during agent bootstrap
- `initialize(options: { pluginDirs?: string[] })` — load all plugins
- `loadPlugin(dir: string, scope: PluginScope): ResolvedPlugin`
- `enablePlugin(name: string, scope: PluginScope)`
- `disablePlugin(name: string, scope: PluginScope)`
- `uninstallPlugin(name: string, scope: PluginScope)`
- `reloadPlugins()` — hot-reload all plugins
- `getPlugins(): ResolvedPlugin[]`
- `getPlugin(name: string): ResolvedPlugin | null`
- Read/write `enabledPlugins` from settings per scope
- Platform-specific storage via `PluginStorageProvider` interface

#### 1.4 Plugin Cache (`src/core/plugins/PluginCache.ts`)
- `cache(source: string, pluginDir: string): string` — returns cached path
- Copy plugin directory to local cache
- Resolve symlinks during copy
- Version-based invalidation
- Platform-specific cache locations:
  - Extension: IndexedDB
  - Desktop: `~/.browserx/plugins/cache/`
  - Server: `$APPLEPI_DATA_DIR/plugins/cache/`

#### 1.5 Platform Storage Adapters
- `src/extension/plugins/ExtensionPluginStorage.ts`
- `src/desktop/plugins/TauriPluginStorage.ts`
- `src/server/plugins/ServerPluginStorage.ts`
- Each implements `PluginStorageProvider` for reading/writing plugin state

#### 1.6 Bootstrap Integration
- Add `PluginManager.initialize()` to each platform's bootstrap:
  - `src/extension/background/service-worker.ts`
  - `src/desktop/agent/DesktopAgentBootstrap.ts`
  - `src/server/agent/ServerAgentBootstrap.ts`
- Desktop + server: support `--plugin-dir` CLI argument

#### 1.7 Service Registry
- Register `plugins.*` service handlers in `ServiceRegistry.ts`
- `plugins.list`, `plugins.install`, `plugins.uninstall`, `plugins.enable`, `plugins.disable`, `plugins.reload`

### Testing
- Unit tests for manifest parsing (valid, missing, malformed)
- Unit tests for path resolution and `${CLAUDE_PLUGIN_ROOT}` expansion
- Unit tests for plugin lifecycle state transitions
- Integration test: load a minimal plugin directory

---

## Phase 2 — Skills

### Goal
Load skills from plugin directories with namespace prefixing.

### Deliverables

#### 2.1 Plugin Skill Loader (`src/core/plugins/PluginSkillLoader.ts`)
- `load(plugin: ResolvedPlugin): void`
- Scan `skills/` for `<name>/SKILL.md` directories
- Scan `commands/` for `<name>.md` files (legacy format)
- Parse each with `SkillParser`
- Register in `SkillRegistry` with namespace = plugin name

#### 2.2 SkillRegistry Namespacing
- Modify `SkillRegistry.register()` to accept optional `namespace` parameter
- Skill lookup: `/namespace:name` for plugin skills, `/name` for standalone
- `listSkills()` returns skills with their full namespaced names
- Handle conflicts: plugin skills never shadow standalone skills

#### 2.3 `$ARGUMENTS` Support
- Modify `SkillParser.ts` to recognize `$ARGUMENTS` placeholder
- `$ARGUMENTS` captures all text after the skill name (same as Claude Code)
- Keep existing `$0`, `$1` support for backward compatibility

#### 2.4 UI Updates
- Update skill picker in `src/webfront/` to show namespaced names
- Update `/help` listing to group skills by plugin
- Show plugin source for each skill

### Testing
- Unit test: skill loaded from plugin gets correct namespace
- Unit test: `$ARGUMENTS` substitution
- Unit test: namespace collision handling
- Integration test: invoke `/my-plugin:my-skill arg1 arg2`

---

## Phase 3 — Hooks (DEFERRED)

> **This phase has been moved out of scope.** The hook system will be designed
> and implemented on a separate branch ahead of the plugin system implementation.
> See the original design below for reference.
>
> When the hook system is ready, `PluginManager` will integrate with it by
> calling `HookDispatcher.register(plugin)` during plugin loading — the same
> pattern used for skills, MCP, and agents.

<details>
<summary>Original Phase 3 design (for reference)</summary>

### Goal
Execute shell commands, LLM prompts, or agent verifiers in response to
agent lifecycle events, driven by plugin `hooks.json` configuration.

### Deliverables

#### 3.1 Hook Dispatcher (`src/core/plugins/HookDispatcher.ts`)
- `register(plugin: ResolvedPlugin): void` — register a plugin's hooks
- `dispatch(event: HookEvent, context: HookContext): Promise<HookResult[]>`
- Match event against registered rules (check `matcher` regex)
- Dispatch to appropriate hook runner by type
- Collect and return results

#### 3.2 Hook Runner (`src/core/plugins/HookRunner.ts`)
- `execCommand(command: string, stdin: object): Promise<HookResult>`
  - Platform-specific: uses `HookCommandAdapter` interface
  - Extension: reject or fallback to prompt type
  - Desktop: Tauri shell command execution
  - Server: `child_process.exec`
- `execPrompt(prompt: string, context: object): Promise<HookResult>`
  - Substitute `$ARGUMENTS` with context
  - Send to model via `ModelClientFactory`
- `execAgent(agentName: string, context: object): Promise<HookResult>`
  - Invoke named agent with tool access

#### 3.3 Platform Hook Adapters
- `HookCommandAdapter` interface: `exec(command: string, stdin: string): Promise<{ stdout: string; exitCode: number }>`
- `src/extension/plugins/ExtensionHookAdapter.ts` — limited (prompt hooks only)
- `src/desktop/plugins/TauriHookAdapter.ts` — full shell support
- `src/server/plugins/ServerHookAdapter.ts` — full shell support

#### 3.4 TurnManager Integration
- Inject hook dispatch points in `TurnManager.ts`:
  - Before tool execution → `PreToolUse`
  - After successful execution → `PostToolUse`
  - After failed execution → `PostToolUseFailure`
- Hook context includes: tool name, tool input, tool result (for post hooks)

#### 3.5 Session/Agent Integration
- `Session.ts` → dispatch `SessionStart` on creation, `SessionEnd` on teardown
- `RepublicAgent.ts` → dispatch `Stop` on interrupt
- Submission handler → dispatch `UserPromptSubmit`
- Notification system → dispatch `Notification`

### Testing
- Unit test: hook config parsing and event matching
- Unit test: matcher regex against tool names
- Unit test: command hook execution (mock adapter)
- Unit test: prompt hook execution (mock model)
- Integration test: PostToolUse hook fires after tool execution
- Platform test: verify extension skips command hooks gracefully

</details>

---

## Phase 4 — MCP

### Goal
Auto-start MCP servers defined in plugin `.mcp.json` when the plugin is enabled.

### Deliverables

#### 4.1 Plugin MCP Loader (`src/core/plugins/PluginMCPLoader.ts`)
- `load(plugin: ResolvedPlugin): void`
- Parse `.mcp.json` from plugin root (or inline from manifest)
- Expand `${CLAUDE_PLUGIN_ROOT}` in command, args, env, cwd
- Call `MCPManager.addServer()` for each server config
- Tag servers with plugin name for lifecycle management

#### 4.2 MCPManager Extensions
- `addServer(config, { source?: string })` — tag with plugin source
- `removeServersBySource(source: string)` — remove all servers from a plugin
- On plugin disable → `removeServersBySource(pluginName)`
- On plugin enable → re-add servers

#### 4.3 Tool Namespacing
- Plugin MCP tools: `plugin-name:server-name:tool-name`
- Or simpler: `plugin-name:tool-name` (if server name not needed)
- Configurable in plugin manifest

### Testing
- Unit test: MCP config parsing with variable expansion
- Unit test: server lifecycle (add on enable, remove on disable)
- Integration test: plugin MCP server connects and provides tools

---

## Phase 5 — Agents

### Goal
Load agent definitions from plugin `agents/` directory.

### Deliverables

#### 5.1 Plugin Agent Loader (`src/core/plugins/PluginAgentLoader.ts`)
- `load(plugin: ResolvedPlugin): void`
- Scan `agents/` directory for `.md` files
- Parse frontmatter: `name`, `description`, system prompt body
- Register as namespaced agents: `plugin-name:agent-name`

#### 5.2 Agent Integration
- Surface plugin agents in `/agents` UI
- Allow Claude to invoke plugin agents based on task context
- Support manual invocation by users

#### 5.3 Plugin Settings → Default Agent
- `PluginSettingsLoader.ts` reads `settings.json`
- If `{ "agent": "agent-name" }`, activate that agent as main thread
- Apply system prompt, tool restrictions, model from agent definition

### Testing
- Unit test: agent markdown parsing
- Unit test: agent namespacing
- Integration test: plugin agent appears in /agents and is invocable

---

## Phase 6 — Marketplace

### Goal
Discover, install, and update plugins from marketplace repositories.

### Deliverables

#### 6.1 Marketplace Client (`src/core/plugins/MarketplaceClient.ts`)
- `resolveMarketplace(url: string): MarketplaceConfig`
- `listPlugins(marketplace: string): PluginListing[]`
- `resolvePlugin(name: string, marketplace: string): PluginSource`
- `checkForUpdates(installed: ResolvedPlugin[]): PluginUpdate[]`
- Support git-based marketplaces (clone/fetch marketplace repo)
- Parse `marketplace.json` format (compatible with Claude Code)

#### 6.2 Marketplace Configuration
- `pluginMarketplaces` array in settings (per scope)
- Project-level marketplace in `.claude/settings.json` for team plugins
- User-level marketplace in user settings for personal plugins

#### 6.3 UI
- Plugin browser in settings page (`src/webfront/settings/`)
- Browse available plugins by marketplace
- Install/uninstall/enable/disable buttons
- Update available indicator
- Plugin details (description, version, author)

#### 6.4 CLI Support (Server)
- `browserx plugin install <name>@<marketplace> [--scope <scope>]`
- `browserx plugin uninstall <name> [--scope <scope>]`
- `browserx plugin update <name> [--scope <scope>]`
- `browserx plugin list`

### Testing
- Unit test: marketplace.json parsing
- Unit test: version comparison for updates
- Integration test: install plugin from local marketplace directory
- UI test: plugin browser renders correctly

---

## Phase 7 — LSP

### Goal
Support `.lsp.json` for language server integration (desktop + server only).

### Deliverables

#### 7.1 Plugin LSP Loader (`src/core/plugins/PluginLSPLoader.ts`)
- `load(plugin: ResolvedPlugin): void`
- Parse `.lsp.json` from plugin root
- Validate: command required, extensionToLanguage required
- Start LSP servers with configured transport (stdio/socket)

#### 7.2 LSP Client
- New `src/core/lsp/LSPClient.ts` — Language Server Protocol client
- Connect via stdio or socket
- Handle initialize/initialized handshake
- Support: diagnostics, go-to-definition, find-references, hover
- Expose diagnostics to agent for code intelligence

#### 7.3 Platform Guards
- Extension: skip LSP loading entirely
- Desktop + server: full support

### Testing
- Unit test: LSP config parsing
- Integration test: connect to a test LSP server
- Platform test: verify extension gracefully skips LSP

---

## Estimated Complexity

| Phase | New Files | Modified Files | Complexity |
|---|---|---|---|
| 1 — Foundation | ~10 | ~5 | Medium-High |
| 2 — Skills | ~2 | ~4 | Medium |
| 3 — ~~Hooks~~ | — | — | **Deferred** |
| 4 — MCP | ~1 | ~2 | Medium-Low |
| 5 — Agents | ~2 | ~2 | Medium-Low |
| 6 — Marketplace | ~3 | ~3 | Medium |
| 7 — LSP | ~3 | ~1 | High (new protocol) |

---

## Cross-Cutting Concerns

### Error Handling
- Plugin loading failures should not crash the agent
- Log warnings for malformed manifests, missing files, invalid hooks
- Provide `/plugin validate` command for debugging
- Surface errors in UI (plugin status indicators)

### Security
- MCP servers from plugins should go through existing approval gate
- Plugin cache integrity — detect tampering via version/hash checks
- Hook security (arbitrary code execution, user consent) deferred to hook system design

### Performance
- Lazy-load plugin components (don't parse all skills on startup if not needed)
- Cache parsed manifests
- MCP servers: connect on first use, not on plugin load (option)
- Hook performance considerations deferred to hook system design

### Backward Compatibility
- Existing standalone `.claude/` skills continue to work unchanged
- Existing MCP server configs in user settings continue to work
- Existing OpenClaw server plugins (`src/server/plugins/`) are unaffected
- No migration required — plugins are purely additive
