# Design Decisions — Resolved

The original document posed ten open questions. The plugin system has since
shipped, so each entry below records the **decision that was made and how it is
implemented**. Where the resolution differed from the original recommendation,
that is noted.

---

## DD-1: Plugin Manifest Schema — Strict Compatibility vs Extension

**Decision:** Strict, Claude Code-compatible `plugin.json` at the plugin root,
extended with an optional `workx` namespace **inside the same file** (not a
separate `workx.json`).

**As built** (`PluginManifest.ts`): the Zod schema is lenient by default
(unknown top-level keys are stripped for forward-compat) with a `.strict()`
variant for author validation. WorkX-specific config lives under
`manifest.workx` (`domains`, `platforms`, `toolExposure`), which Claude Code
ignores. Per-plugin user configuration uses the `userConfig` field. This keeps
Claude Code plugins working as-is while avoiding a second manifest file — a
refinement of the original "separate file" recommendation.

---

## DD-2: Extension Hook Support

**Decision:** Hooks are per-session and platform-gated. `command` (shell) hooks
run on desktop/server only; `prompt` and `http` hooks run everywhere. The
extension simply does not provide a shell executor, so `command` hooks are
unavailable there rather than erroring.

**As built** (`HookSlotLoader`, `HookRegistry`): hook types are `command`,
`prompt`, and `http`. (Note: in v1 the extension wires the skills slot at boot;
per-session hook binding follows the same `PluginSessionBinder` path used by
server/desktop where sessions are created.)

---

## DD-3: Relationship with the Server Channel System

**Decision:** Keep them separate. There is no `src/server/plugins/` Claude Code
system competing with channels; the plugin system lives entirely in
`src/core/plugins/`, and server messaging adapters live in
`src/server/channels/`. They serve different purposes and do not overlap.

---

## DD-4: Where Plugin Enable-State Lives

**Decision (changed from the original):** plugin enable intent is stored in
`agentConfig.enabledPlugins` (`Record<PluginId, boolean>`), **not** in `.claude/`
or `.workx/` project files.

**As built:**
- Extension → inside the `agent_config` record in `chrome.storage.local`
- Server / desktop → `agent_config` in `<dataDir>/config-storage.json`

A separate `installed_plugins_v2.json` ledger tracks what is materialized on disk
per scope (with `version` + `gitCommitSha`). The `IPluginProvider` only knows
which plugins *exist*; enable-state is config, not provider state. This supersedes
the original "read both `.claude/` and `.workx/`" recommendation.

---

## DD-5: Skill/Command Variable Substitution

**Decision:** Positional substitution (`$@`, `$N`) is implemented for plugin
**commands**; skills do not get a positional scheme. Claude Code's
`${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` path variables and
`${user_config.*}` are supported across skill, command, agent, MCP, and hook
content.

**As built** (`CommandSlotLoader`, `userConfigSubstitution.ts`): command bodies
get `$@` (all args) and `$N` (1-indexed) via a single-pass, injection-safe
replacement. `${user_config.*}` has three modes — content-safe (bodies, sensitive
values masked), strict (MCP/hook runtime, throws on missing), and env-injection
(`CLAUDE_PLUGIN_OPTION_<KEY>` for hooks).

---

## DD-6: Cross-Compatibility Goal

**Decision:** Skill-compatible, with Claude Code-compatible primitives reused
directly — `SKILL.md` skills, `marketplace.json` catalogues, and
`${CLAUDE_PLUGIN_ROOT}` substitution. The manifest filename is `plugin.json` at
the plugin root.

**As built:** Claude Code skills and marketplaces load with no changes; hooks and
sub-agents follow the same shapes with WorkX-specific events/guards. Full
two-way parity is not a goal (WorkX has no file-editing; Claude Code has no
browser automation).

---

## DD-7: Plugin Marketplace

**Decision:** Support multiple git-based marketplaces, governed by admin policy.

**As built** (`MarketplaceRegistry`, `git.ts`, `policy.ts`): marketplaces are git
repos containing `marketplace.json`, fetched with a hardened, non-interactive git
clone. An admin source allow/blocklist is checked **before** any network fetch,
and a reserved-name/homoglyph guard runs after parse. Install sources include
`github`, `git`, `url`, `npm`, `path`, and `bundled`.

---

## DD-8: Hook Execution — Blocking vs Non-Blocking

**Decision:** Hook semantics are owned by `HookRegistry` (the shared hook
subsystem), and plugin hooks inherit them. Pre-events can influence/deny via the
existing approval integration (`PermissionRequest` / `PermissionDenied`); post
events are observational. See the hook subsystem (`src/core/hooks/`) for the
authoritative blocking/timeout behavior.

---

## DD-9: Plugin Tool Contributions

**Decision:** MCP only. Plugins do not register native tools. Browser tools are
core platform capabilities.

**As built:** `McpSlotLoader` is the sole tool-extension path. The
`workx.toolExposure` manifest field tunes how *existing* tools are surfaced
(mode/searchHint/displayName); it does not register new native tools.

---

## DD-10: Plugin Trust & Security Model

**Decision:** Defense-in-depth across install and runtime, with admin policy on
top.

**As built:**
- **Install integrity**: SHA-pinned, fail-closed materialization; dependency
  closure re-checked against policy at every member.
- **Admin governance** (`policy.ts`): plugin allow/block map, marketplace
  allow/blocklists, reserved/official-name protection; the `managed` scope is
  admin-deployed and not user-uninstallable.
- **Secrets**: `userConfig` options marked `sensitive` are stored in the
  credential store and masked in content substitution.
- **Sub-agent boundary**: sensitive frontmatter (`permissionMode`, `hooks`,
  `mcpServers`) is stripped from plugin sub-agents.
- **MCP**: plugin MCP servers still pass through the existing approval gate.
- **Lifecycle safety**: an evicted set blocks re-enabling an uninstalled plugin
  until restart; uninstall orphan-marks files (7-day GC) rather than deleting
  them out from under live sessions.

---

## Summary

| Decision | Outcome |
|---|---|
| DD-1: Manifest schema | Strict `plugin.json` + `workx` namespace + `userConfig` (no separate file) |
| DD-2: Extension hooks | Per-session; `command` desktop/server only, `prompt`/`http` everywhere |
| DD-3: Server channels | Separate system; plugins live in `src/core/plugins/` |
| DD-4: Enable-state | `agentConfig.enabledPlugins` (not `.claude/`/`.workx/`) |
| DD-5: Substitution | Commands `$@`/`$N`; `${CLAUDE_PLUGIN_ROOT}` + `${user_config.*}` everywhere |
| DD-6: Compatibility | Skill-compatible; `plugin.json` at root |
| DD-7: Marketplace | Git-based, multi-source, admin-governed |
| DD-8: Hook blocking | Delegated to the shared `HookRegistry` semantics |
| DD-9: Plugin tools | MCP only |
| DD-10: Trust model | SHA pinning + admin policy + secret store + sub-agent guards |
