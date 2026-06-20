# Claude Code-Compatible Plugin System — Overview

> A Claude Code-compatible plugin system that runs across all WorkX surfaces
> (Chrome extension, desktop app, headless server).

> **Status: implemented.** This document set originally proposed the plugin
> system as a design. The system has since been built and lives in
> `src/core/plugins/`. These documents now describe the system **as it is
> actually implemented** — they double as the architecture reference for the
> shipped code. Where a forward-looking gap remains (e.g. extension marketplace
> wiring), it is called out explicitly.

## Goal

Let WorkX load, run, and distribute plugins that follow the
[Claude Code plugin model](https://code.claude.com/docs/en/plugins-reference),
so that:

1. Plugins authored for Claude Code work in WorkX with minimal or no changes
   (same `SKILL.md` skills, `marketplace.json` catalogues, and
   `${CLAUDE_PLUGIN_ROOT}` path variables).
2. WorkX-specific capabilities can be declared via a `workx` namespace inside
   the standard manifest, without breaking Claude Code compatibility.
3. Teams can share plugins via git-based marketplaces.

## Documents

| File | Contents |
|---|---|
| [overview.md](./overview.md) | This file — goals, scope, current state |
| [gap_analysis.md](./gap_analysis.md) | How WorkX concepts map to Claude Code, and what was added to close the gaps |
| [architecture.md](./architecture.md) | Module layout, core types, data flow, platform behavior matrix |
| [implementation_plan.md](./implementation_plan.md) | Phased build order and current status of each capability |
| [design_decisions.md](./design_decisions.md) | The ten key design questions and how each was resolved in the shipped system |

## Scope

### Implemented

- Plugin manifest loading (`plugin.json` at the plugin root, validated with Zod)
- Plugin lifecycle: install, enable, load, disable, uninstall, reload
- Plugin scopes: `managed`, `user`, `project`, `local`
- Namespaced skills from plugins (`plugin:skill`)
- Namespaced commands from plugins (`plugin:command`) with `$@` / `$N` args
- Namespaced sub-agents from plugins (`plugin:agent`)
- MCP server registration from plugins
- Hooks from plugins (per-session) — `command`, `prompt`, and `http` types
- `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` / `${user_config.*}` substitution
- Per-plugin user config (`userConfig`), including `sensitive` options backed by the credential store
- Git-based marketplaces (`marketplace.json`), dependency resolution, SHA-pinned installs, autoupdate
- Admin policy governance (allow/block plugins and marketplaces, reserved-name guard)
- Versioned plugin cache with orphan-marking and a 7-day GC sweep
- Bundled (compile-time) plugin registry

### Out of Scope / Not Yet Wired

- **Extension marketplace + installer.** The Chrome extension wires plugin
  loading and the skills slot, but the marketplace/installer/autoupdate stack is
  server- and desktop-only in v1.
- **LSP servers.** No `.lsp.json` / Language Server Protocol integration exists.
- **Native (non-MCP) tool registration from plugins.** Plugins extend tooling
  through MCP only; browser tools remain core platform capabilities.
- **Path-referenced hooks and MCP configs.** Hooks and MCP servers are read
  from the inline manifest; resolving them from separate files within a plugin
  is deferred.

## Current State of WorkX

WorkX is a tri-surface AI agent. All three surfaces share `src/core/`, which
contains the platform-agnostic agent (`RepublicAgent` / `RepublicAgentEngine`),
tool registry, skill system, MCP manager, hook registry, sub-agent runner, and
the plugin system.

| Surface | Agent type | Runtime | Build mode |
|---|---|---|---|
| Chrome Extension | `workx` | Service worker + side panel | `extension` |
| Desktop | `workx-desktop` | Tauri (Rust + Web) | `desktop` |
| Server | `workx-server` | Node.js 22+ | `server` |

### Extension Points the Plugin System Builds On

| Mechanism | Location | Description |
|---|---|---|
| Skills | `src/core/skills/` | `SKILL.md` with YAML frontmatter, `SkillRegistry` + `SkillParser` |
| MCP Servers | `src/core/mcp/` | `MCPManager`, SSE + stdio transports, MCP config loader |
| Hooks | `src/core/hooks/` | `HookRegistry`, per-session event hooks |
| Sub-agents | `src/core/subagents/` | `SubAgentRunner`, per-session agent types |
| Commands | `src/core/plugins/PluginCommandLoader.ts` | Prompt commands contributed by plugins |
| Tools | `src/tools/` + `src/extension/tools/` | `ToolRegistry` + browser-focused tools |
| Channels | `src/server/channels/` | Server messaging adapters (separate system) |
