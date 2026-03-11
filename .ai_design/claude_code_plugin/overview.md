# Claude Code Plugin System Adoption — Design Overview

> Adopt a Claude Code-compatible plugin system across all BrowserX agents
> (Chrome extension, desktop app, headless server).

## Goal

Enable BrowserX to load, run, and distribute plugins that follow the
[Claude Code plugin specification](https://code.claude.com/docs/en/plugins-reference),
so that:

1. Plugins authored for Claude Code work in BrowserX with minimal or no changes.
2. Plugins authored for BrowserX can optionally work in Claude Code.
3. Teams can share plugins via the same marketplace format.

## Documents

| File | Contents |
|---|---|
| [overview.md](./overview.md) | This file — goals, scope, current state |
| [gap_analysis.md](./gap_analysis.md) | What aligns today and what's missing |
| [architecture.md](./architecture.md) | Proposed module layout, data flow, platform considerations |
| [implementation_plan.md](./implementation_plan.md) | Phased implementation order with deliverables |
| [design_decisions.md](./design_decisions.md) | Open questions requiring team input |

## Scope

### In Scope

- Plugin manifest loading (`.claude-plugin/plugin.json`)
- Plugin lifecycle management (install, enable, load, disable, uninstall)
- Namespaced skills from plugins
- Hook system (pre/post tool use, session events, etc.)
- Agent definitions from plugins
- MCP server auto-start from plugins
- Plugin caching and file resolution
- Marketplace discovery and installation
- LSP server support (desktop + server only)
- `--plugin-dir` dev mode
- `/reload-plugins` hot-reload

### Out of Scope (for now)

- Modifying the existing OpenClaw `ChannelPlugin` system (server channel adapters)
- Building a BrowserX-hosted marketplace registry service
- Plugin signing or verification beyond what Claude Code specifies
- Browser-specific tool plugins (BrowserX's tool system remains separate)

## Current State of BrowserX

BrowserX is a tri-platform AI agent:

| Platform | Product | Runtime | Build Mode |
|---|---|---|---|
| Chrome Extension | BrowserX | Service worker + content scripts | `extension` |
| Desktop | Apple Pi | Tauri (Rust + Web) | `desktop` |
| Server | Apple Pi Server | Node.js 22+ | `server` |

All three share `src/core/` which contains the platform-agnostic agent,
tool registry, skill system, MCP manager, and event infrastructure.

### Existing Extension Points

| Mechanism | Location | Description |
|---|---|---|
| Skills | `src/core/skills/` | `SKILL.md` with YAML frontmatter, `SkillRegistry` + `SkillParser` |
| MCP Servers | `src/core/mcp/` | `MCPManager`, SSE + stdio transports, `MCPConfig` loader |
| A2A | `src/core/a2a/` | Agent-to-agent communication |
| Server Plugins | `src/server/plugins/` | OpenClaw-compatible channel adapters (Slack, Telegram) |
| Tools | `src/tools/` + `src/core/tools/` | `ToolRegistry` + `BaseTool`, browser-focused |
| Events | `src/core/protocol/events.ts` | `EventMsg` types dispatched via `ChannelManager` |
