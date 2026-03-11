# Gap Analysis — BrowserX vs Claude Code Plugin System

## Already Aligned

### Skills (~80% aligned)

| Claude Code | BrowserX | Gap |
|---|---|---|
| `SKILL.md` with YAML frontmatter | `SkillParser.ts` parses same format | Minor frontmatter field differences |
| `skills/` directory convention | Skills stored in platform-specific providers | Need file-based discovery from plugin dirs |
| `$ARGUMENTS` placeholder | `$0`, `$1` variable substitution | Need to add `$ARGUMENTS` support |
| `commands/` directory (legacy) | Not used | Need to support as alias |
| `disable-model-invocation` frontmatter | `invocationMode: manual` | Semantically similar, map between them |
| Namespaced names (`/plugin:skill`) | Flat names (`/skill`) | Need namespacing layer |

### MCP Servers (~90% aligned)

| Claude Code | BrowserX | Gap |
|---|---|---|
| `.mcp.json` at plugin root | `MCPConfig.ts` loads server configs | Need to load from plugin directory |
| `${CLAUDE_PLUGIN_ROOT}` in paths | Not supported | Need env variable expansion |
| SSE + stdio transports | Both supported (`MCPClient` + `RustMCPBridge`/`NodeMCPBridge`) | Aligned |
| Auto-start on plugin enable | Manual add via `MCPManager.addServer()` | Need auto-start lifecycle |

### Agent Concepts (~50% aligned)

| Claude Code | BrowserX | Gap |
|---|---|---|
| Agent markdown with frontmatter | Agent concepts exist but no markdown loader | Need markdown-based agent definitions |
| `agents/` directory | No convention | Need directory convention |
| Namespaced agents | Not applicable yet | Need namespacing |
| `settings.json` → default agent | `AgentConfig` exists | Need plugin settings → agent activation |

### Event System (~40% aligned for hooks)

| Claude Code | BrowserX | Gap |
|---|---|---|
| `hooks.json` with event matchers | No hook file format | Need hook config parser |
| `PreToolUse`, `PostToolUse` events | Tool execution in `TurnManager` | Need pre/post injection points |
| `SessionStart`, `SessionEnd` | Session lifecycle in `Session.ts` | Need hook dispatch at lifecycle points |
| `UserPromptSubmit` | `Submission` op | Need hook dispatch |
| `command` hook type (shell exec) | Not available in extension | Platform-specific support |
| `prompt` hook type (LLM eval) | Model infrastructure exists | Need prompt hook runner |
| `agent` hook type (agentic verifier) | Agent infra exists | Need agent hook runner |

## Not Present in BrowserX

### Plugin Manifest & Discovery

- No `.claude-plugin/plugin.json` loader
- No plugin directory convention
- No auto-discovery of components from directories
- No manifest validation

### Plugin Lifecycle Management

- No install/uninstall/enable/disable flow
- No plugin scopes (user, project, local)
- No plugin caching (copy to local cache)
- No `--plugin-dir` dev mode flag
- No `/reload-plugins` command

### Hook System

- No `hooks.json` file format
- No event → matcher → hook dispatch pipeline
- No shell command execution as hooks (extension can't do this at all)
- No `prompt` or `agent` hook types

### LSP Servers

- No `.lsp.json` support
- No Language Server Protocol integration
- Not applicable for Chrome extension (no filesystem access)

### Marketplace

- No `marketplace.json` format support
- No marketplace discovery or browsing
- No version-based update checking
- No marketplace UI in settings

### Plugin Settings

- No `settings.json` loading from plugins
- No plugin-level default configuration

## Claude Code Features NOT Applicable to BrowserX

| Feature | Reason |
|---|---|
| File editing hooks (Write/Edit matchers) | BrowserX doesn't do file editing (browser-focused) |
| Git-related hooks | BrowserX doesn't interact with git |
| LSP in extension | Chrome extension has no filesystem or language server access |
| Shell hooks in extension | Chrome extensions are sandboxed |
| `PreCompact` event | BrowserX may handle context differently |

## BrowserX-Specific Considerations

| Concern | Detail |
|---|---|
| Browser tools | BrowserX has browser-specific tools (DOM, navigation, form automation) — plugins may want to provide new browser tools |
| Approval system | BrowserX has a sophisticated approval gate — plugins may need to declare risk levels |
| Multi-model support | BrowserX supports many model providers — plugin `prompt` hooks need model routing |
| Channel adapters | Server mode has OpenClaw plugins for Slack/Telegram — separate from Claude Code plugins |
| Content scripts | Extension injects content scripts — not part of plugin system |
