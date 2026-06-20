# Gap Analysis — WorkX vs Claude Code Plugin System

This was originally a forward-looking gap analysis. The gaps it identified have
since been closed by the implementation in `src/core/plugins/`. Each table below
shows how a Claude Code concept maps to WorkX and **how the gap was closed**.

## Skills

| Claude Code | WorkX | Resolution |
|---|---|---|
| `SKILL.md` with YAML frontmatter | `SkillParser` parses the same format | Aligned; `SkillSlotLoader` reuses the parser |
| `skills/` directory convention | `SkillSlotLoader` scans `skills/` (single `SKILL.md` or `<sub>/SKILL.md`) | Closed — file-based discovery from plugin dirs |
| Namespaced names (`/plugin:skill`) | Plugin skills registered as `pluginName:bareName` | Closed (`SkillSlotLoader.ts`) |
| `${CLAUDE_PLUGIN_ROOT}` in skill bodies | Substituted at load via `substituteContent()` | Closed (`userConfigSubstitution.ts`) |

> Note: WorkX skills do not implement Claude Code's `$ARGUMENTS` placeholder.
> Positional argument substitution (`$@`, `$N`) is implemented for plugin
> **commands**, not skills (see below).

## Commands

| Claude Code | WorkX | Resolution |
|---|---|---|
| `commands/` directory of `.md` files | `CommandSlotLoader` scans `commands/` (or inline manifest map) | Closed |
| Namespaced commands | Registered as `pluginName:bareName` | Closed |
| `$ARGUMENTS` / positional args | `$@` (all args) and `$N` (1-indexed positional) | Closed, single-pass safe substitution |

## MCP Servers

| Claude Code | WorkX | Resolution |
|---|---|---|
| `.mcp.json` / inline `mcpServers` | `McpSlotLoader` reads inline `mcpServers` from the manifest | Closed (inline); path-referenced configs deferred |
| `${CLAUDE_PLUGIN_ROOT}` in configs | Expanded via `substituteRuntime()` (plugin vars + strict user-config) | Closed |
| SSE + stdio transports | Both supported via existing `MCPManager` bridges | Aligned |
| Auto-register on enable | `McpSlotLoader` calls `MCPManager.addServer({ pluginId })`; removed on disable | Closed |

## Sub-agents

| Claude Code | WorkX | Resolution |
|---|---|---|
| Agent markdown with frontmatter | `SubAgentSlotLoader` parses `agents/*.md` frontmatter | Closed |
| `agents/` directory | Scanned per `manifest.agents` | Closed |
| Namespaced agents | Registered as `pluginName:agentName` in `SubAgentRunner` (per session) | Closed |
| Trust boundary | Sensitive frontmatter (`permissionMode`, `hooks`, `mcpServers`) is dropped with a warning | Hardened beyond Claude Code |

## Hooks

Hooks are **implemented** (the original design had deferred them). They are
registered per session by `HookSlotLoader` into the `HookRegistry`.

| Claude Code | WorkX | Resolution |
|---|---|---|
| `hooks` with event matchers | Inline `manifest.hooks` (object/array) | Closed (inline); path-referenced hook files deferred |
| `PreToolUse`, `PostToolUse` | Supported, plus `PostToolUseFailure` | Closed |
| `SessionStart`, `SessionEnd` | Supported | Closed |
| `UserPromptSubmit`, `Stop` | Supported | Closed |
| `PreCompact` | Supported, plus `PostCompact` | Closed |
| `command` hook type (shell) | Supported on desktop/server | Closed |
| `prompt` hook type (LLM) | Supported on all surfaces | Closed |
| (n/a) | `http` hook type, `PermissionRequest`/`PermissionDenied`, `TaskCreated`/`TaskCompleted`, `ConfigChange` | WorkX additions |

## Plugin Manifest & Discovery

- `plugin.json` at the plugin root, validated by `PluginManifestSchema` (Zod).
- Lenient by default (unknown keys stripped for forward-compat); a `.strict()`
  variant powers author validation.
- `PluginLoader.loadFromDir()` parses the manifest; slot loaders discover
  components at enable time.

## Plugin Lifecycle Management

- `PluginRegistry` owns enable/disable/reload/bootstrap with per-plugin
  serialization and rollback.
- `PluginInstaller` / `PluginUninstaller` own install (deps → policy →
  materialize → SHA-verify) and uninstall (disable → orphan-mark).
- Scopes: `managed`, `user`, `project`, `local`.
- `PluginCache` provides a versioned cache and 7-day orphan GC.

## Marketplace

- `marketplace.json` catalogues, fetched by git clone (`git.ts`,
  `MarketplaceRegistry`).
- Dependency closure resolution (`dependencyResolver.ts`, post-order).
- SHA-pinned, fail-closed installs and `PluginAutoupdate`.

## Still Not Present in WorkX

| Feature | Status |
|---|---|
| LSP servers (`.lsp.json`) | Not implemented |
| Native (non-MCP) tool registration from plugins | Not implemented (MCP only) |
| Extension-side marketplace/installer | Not wired (server + desktop only in v1) |
| Path-referenced hook / MCP config files | Deferred (inline only today) |

## Claude Code Features Not Applicable to WorkX

| Feature | Reason |
|---|---|
| File-editing hooks (Write/Edit matchers) | WorkX is browser/automation-focused |
| LSP in the extension | Chrome extensions have no filesystem or language-server access |
| Shell (`command`) hooks in the extension | Chrome extensions are sandboxed |

## WorkX-Specific Considerations

| Concern | Detail |
|---|---|
| `workx` manifest namespace | `domains`, `platforms`, `toolExposure` declared without breaking Claude Code compatibility |
| User config | `userConfig` options (typed, optionally `sensitive`) resolved via the credential store |
| Approval system | Plugin MCP servers still flow through the existing approval gate |
| Multi-model support | Plugin `prompt` hooks route through `ModelClientFactory` |
| Channel adapters | Server messaging adapters (`src/server/channels/`) are a separate system |
