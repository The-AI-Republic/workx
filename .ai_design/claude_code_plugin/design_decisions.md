# Design Decisions — Open Questions

These questions need team input before implementation begins.
Each question includes context, options, and a recommended default.

---

## DD-1: Plugin Manifest Schema — Strict Compatibility vs Extension

**Context:**
Claude Code's `plugin.json` has a fixed schema (name, version, description,
author, commands, agents, skills, hooks, mcpServers, lspServers, outputStyles).
BrowserX has capabilities Claude Code doesn't (browser tools, approval policies,
multi-model support, channel adapters).

**Question:**
Should we keep `plugin.json` strictly identical to Claude Code's schema, or
extend it with BrowserX-specific fields?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Strict compatibility** | Plugins work in both Claude Code and BrowserX without changes. Simple. | Can't leverage BrowserX-specific features from plugins. |
| **B. Superset schema** | BrowserX plugins can declare browser tools, approval policies, etc. Claude Code ignores unknown keys. | BrowserX-specific plugins won't do anything in Claude Code. Two-tier ecosystem. |
| **C. Separate extension file** | Keep `plugin.json` identical; add optional `browserx.json` for BrowserX-specific config. Clean separation. | Two files to maintain. Slightly more complex loading. |

**Recommendation:** Option C — strict `plugin.json` compatibility with an
optional `browserx.json` for BrowserX extensions. Claude Code plugins work
as-is; BrowserX plugins can optionally declare extra capabilities.

**`browserx.json` could contain:**
```json
{
  "browserTools": ["custom-dom-tool"],
  "approvalPolicy": "on-request",
  "supportedPlatforms": ["extension", "desktop", "server"],
  "channelAdapter": "./adapters/slack.ts"
}
```

---

## DD-2: Extension Hook Support — Skip vs Alternative Mechanism

**Context:**
Chrome extensions are sandboxed — they cannot execute shell commands.
Claude Code hooks primarily use `"type": "command"` (shell execution).
BrowserX's extension platform can't support this.

**Question:**
How should the extension platform handle `command` hooks?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Skip silently** | Simple. No errors. Plugin still loads other components. | User may not realize hooks aren't running. |
| **B. Skip with warning** | User knows hooks are limited on extension. | Warning noise for every plugin with hooks. |
| **C. Add `"type": "function"` hook type** | BrowserX-specific hook type that calls registered JS functions. Works everywhere. | Not Claude Code compatible. Adds complexity. |
| **D. Prompt fallback** | Convert command hooks to prompt hooks automatically (LLM interprets the command intent). | Unpredictable. May not produce same results. |

**Recommendation:** Option B — skip `command` hooks with a one-time warning
per plugin. `prompt` and `agent` hook types work on all platforms. If demand
grows, add `"type": "function"` later (would go in `browserx.json` per DD-1).

---

## DD-3: Relationship with Existing Server Plugin System

**Context:**
BrowserX's server already has an OpenClaw-compatible plugin system
(`src/server/plugins/`) for channel adapters (Slack, Telegram). This serves
a different purpose than Claude Code plugins (skills, hooks, agents).

**Question:**
How should the two plugin systems coexist?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Keep separate** | No risk of breaking existing channel adapters. Clear separation of concerns. | Two "plugin" concepts in the codebase. |
| **B. Merge under Claude Code plugin system** | One plugin system. Channel adapters become a plugin component. | Complex migration. Channel adapters don't map cleanly to Claude Code's model. |
| **C. Nest channel adapters in Claude Code plugins** | A Claude Code plugin can optionally include a `channelAdapter` (via `browserx.json`). Gradual migration. | Still two systems internally, but unified external API. |

**Recommendation:** Option A for now — keep them separate. The existing
channel adapter system works well and serves a fundamentally different purpose
(messaging platform integration vs agent capability extension). Revisit once
the Claude Code plugin system is stable.

**Naming clarification:**
- "Claude Code plugins" / "agent plugins" → skills, hooks, agents, MCP
- "Channel plugins" → Slack, Telegram, etc. (existing system)

---

## DD-4: Plugin Settings File — `.claude/` vs `.browserx/`

**Context:**
Claude Code uses `.claude/settings.json` for project-level plugin config.
BrowserX could use the same path (for compatibility) or its own path.

**Question:**
Should BrowserX read/write plugin settings from `.claude/` or `.browserx/`?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Use `.claude/` only** | Full compatibility. Plugins enabled in Claude Code are also enabled in BrowserX. | BrowserX appears as a Claude Code dependency/extension. |
| **B. Use `.browserx/` only** | Clean branding. Independent. | No cross-tool compatibility. Plugins must be configured twice. |
| **C. Read from both, write to `.browserx/`** | BrowserX picks up Claude Code configs automatically. BrowserX-specific settings go to `.browserx/`. | Merge logic can be confusing. Precedence rules needed. |
| **D. Read from both, write to `.claude/`** | Maximum compatibility. Changes made in BrowserX also visible in Claude Code. | BrowserX writes to "someone else's" config directory. |

**Recommendation:** Option C — read from both `.claude/` and `.browserx/`,
write to `.browserx/`. This means:
- Plugins installed via Claude Code are automatically available in BrowserX
- BrowserX-specific plugin settings don't pollute `.claude/`
- Precedence: `.browserx/` overrides `.claude/` for conflicting settings

**For user-level settings:**
- Claude Code: `~/.claude/settings.json`
- BrowserX: `~/.browserx/settings.json`
- BrowserX reads both, writes to its own

---

## DD-5: Skill Variable Substitution — Merge or Dual Support

**Context:**
- Claude Code uses `$ARGUMENTS` (all args as one string)
- BrowserX uses `$0`, `$1`, `$2` (positional args)

**Question:**
How should we handle the two variable systems?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Support both** | Full backward compatibility + Claude Code compat. | Two systems to maintain. Potential confusion. |
| **B. Migrate to `$ARGUMENTS` only** | Consistent with Claude Code. Simple. | Breaking change for existing BrowserX skills. |
| **C. Support both, deprecate `$0`/`$1`** | Gradual migration path. | Deprecation period adds complexity. |

**Recommendation:** Option A — support both. `$ARGUMENTS` gets the full
argument string (Claude Code style). `$0`, `$1`, etc. get positional args
(BrowserX style). No conflicts since the patterns are distinct. Document
that new skills should prefer `$ARGUMENTS` for Claude Code compatibility.

---

## DD-6: Cross-Compatibility Goal

**Context:**
The stated goal is "Claude Code-compatible plugin system." But there's a
spectrum of compatibility.

**Question:**
What level of cross-compatibility should we target?

**Options:**

| Level | Description | Effort |
|---|---|---|
| **A. Format compatible** | Same `plugin.json` format. Plugins may need platform-specific skills/hooks. | Low |
| **B. Skill compatible** | Skills and commands work identically in both. Hooks/agents may differ. | Medium |
| **C. Fully compatible** | Any Claude Code plugin works in BrowserX (where platform allows). Any BrowserX plugin works in Claude Code (minus BrowserX extensions). | High |

**Recommendation:** Level B — skill compatible. This gives the most practical
value:
- Skills are the most commonly shared plugin component
- Hooks often reference project-specific tooling (formatters, linters) that
  may not apply in a browser context
- MCP servers are already protocol-standard
- Full compatibility (Level C) would require feature parity that may not make
  sense (BrowserX doesn't do file editing; Claude Code doesn't do browser automation)

---

## DD-7: Plugin Marketplace — Official vs Bring Your Own

**Context:**
Claude Code supports an official Anthropic marketplace plus custom team
marketplaces (git repos with `marketplace.json`). BrowserX needs to decide
its marketplace strategy.

**Question:**
Should BrowserX support the official Claude Code marketplace, its own
marketplace, or both?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Claude Code official marketplace only** | Largest plugin ecosystem. No hosting cost. | BrowserX-specific plugins can't be listed there. |
| **B. BrowserX marketplace only** | Full control. Can list BrowserX-specific plugins. | Smaller ecosystem. Needs hosting. |
| **C. Both + custom team marketplaces** | Maximum flexibility. Users choose. | More complexity in marketplace resolution. |

**Recommendation:** Option C — support all marketplace sources. Priority order:
1. Project-level team marketplaces (`.claude/settings.json`)
2. User-configured custom marketplaces
3. Official Claude Code marketplace (read-only, for compatible plugins)
4. BrowserX marketplace (if/when created)

---

## DD-8: Hook Execution — Blocking vs Non-Blocking

**Context:**
Claude Code hooks can block tool execution (PreToolUse can prevent a tool
from running). BrowserX needs to decide if hooks should be blocking.

**Question:**
Should hooks be able to block or modify agent behavior?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. All hooks non-blocking** | Simple. Hooks are observers only. Agent behavior unchanged. | Can't implement pre-validation or gatekeeping. |
| **B. Pre hooks blocking, post hooks non-blocking** | PreToolUse can prevent dangerous actions. PostToolUse is observational. | Slow hooks block the agent. Risk of deadlocks. |
| **C. Configurable per hook** | Maximum flexibility. `"blocking": true/false` per hook. | More complex. Users must understand implications. |

**Recommendation:** Option B — `PreToolUse` hooks are blocking (can return
`{ "decision": "deny", "reason": "..." }`), all post hooks are non-blocking
(fire-and-forget). This matches Claude Code behavior and integrates naturally
with BrowserX's existing `ApprovalGate`.

**Timeout:** Blocking hooks should have a configurable timeout (default 10s).
If a hook times out, the tool execution proceeds with a warning.

---

## DD-9: Plugin Tool Contributions

**Context:**
Claude Code plugins extend capabilities via skills, agents, hooks, and MCP
servers. BrowserX also has a native `ToolRegistry` with browser-specific tools.
Should plugins be able to contribute native tools?

**Question:**
Should the plugin system support registering new native tools (beyond MCP)?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. MCP only** | Consistent with Claude Code. MCP is the standard for external tools. | MCP overhead for simple tools. Can't access browser APIs directly. |
| **B. Allow native tool registration** | Full power. Plugins can provide browser tools that access DOM, tabs, etc. | Security risk. Not Claude Code compatible. Complex sandboxing needed. |
| **C. MCP for now, native later** | Start simple. Evaluate need based on plugin ecosystem. | May need to redesign later if native is needed. |

**Recommendation:** Option A — MCP only for now. MCP is the standard protocol
and works well for most use cases. BrowserX's browser-specific tools are
core platform capabilities, not plugin territory. If a plugin needs browser
access, it should work through the agent's existing tools.

---

## DD-10: Plugin Trust and Security Model

**Context:**
Plugins can execute arbitrary code (hooks), connect to external services (MCP),
and modify agent behavior (agents, settings). BrowserX already has an approval
system for tool execution.

**Question:**
What trust model should plugins follow?

**Options:**

| Option | Pros | Cons |
|---|---|---|
| **A. Trust on install** | Simple UX. User consents once at install time. | Users may not understand what they're consenting to. |
| **B. Progressive trust** | Plugins start untrusted. Hooks need individual approval. Skills default to manual mode. | More friction. Matches BrowserX's existing skill trust model. |
| **C. Marketplace-based trust** | Official marketplace plugins are trusted. Custom marketplace plugins need approval. | Trust by proxy. Marketplace curation becomes critical. |

**Recommendation:** Option B — progressive trust, consistent with BrowserX's
existing skill trust model:
- Plugin skills default to `invocationMode: manual` (user must invoke)
- Plugin hooks require one-time consent per hook type
- Plugin MCP servers go through existing MCP approval flow
- Plugin agents require explicit invocation (not auto-invoked) initially
- Users can trust a plugin to elevate all its components

---

## Summary — Recommended Defaults

| Decision | Recommendation |
|---|---|
| DD-1: Manifest schema | Strict + optional `browserx.json` |
| DD-2: Extension hooks | Skip command hooks with warning |
| DD-3: Server plugins | Keep separate from channel adapters |
| DD-4: Settings path | Read both `.claude/` + `.browserx/`, write to `.browserx/` |
| DD-5: Variable substitution | Support both `$ARGUMENTS` and `$0`/`$1` |
| DD-6: Compatibility level | Skill compatible (Level B) |
| DD-7: Marketplace | Support all sources (official + custom + team) |
| DD-8: Hook blocking | Pre hooks blocking, post hooks non-blocking |
| DD-9: Plugin tools | MCP only (no native tool registration) |
| DD-10: Trust model | Progressive trust (matches existing skill model) |

---

## Action Required

Please review each decision and mark your choice. Decisions DD-1, DD-4, and
DD-6 have the broadest architectural impact and should be resolved before
Phase 1 implementation begins.
