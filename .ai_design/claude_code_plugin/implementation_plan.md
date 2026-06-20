# Implementation Plan & Status — Plugin System for WorkX

This was the phased build plan. The core phases have shipped; this document now
records **what was built and where**, plus the items still outstanding.

## Status Overview

| Area | Status | Primary code |
|---|---|---|
| Foundation (types, loader, registry, cache) | ✅ Done | `PluginLoader`, `PluginRegistry`, `PluginCache`, `installedPlugins` |
| Skills | ✅ Done | `loaders/SkillSlotLoader.ts` |
| Commands | ✅ Done | `loaders/CommandSlotLoader.ts`, `PluginCommandLoader.ts` |
| Hooks | ✅ Done (inline) | `loaders/HookSlotLoader.ts` |
| MCP | ✅ Done (inline) | `loaders/McpSlotLoader.ts` |
| Sub-agents | ✅ Done | `loaders/SubAgentSlotLoader.ts` |
| Marketplace + install + autoupdate | ✅ Done (server/desktop) | `MarketplaceRegistry`, `PluginInstaller`, `PluginAutoupdate` |
| Policy / governance | ✅ Done | `policy.ts` |
| Extension marketplace/installer | ⏳ Not wired | — |
| Path-referenced hook / MCP files | ⏳ Deferred | — |
| LSP servers | ❌ Not started | — |
| Native (non-MCP) plugin tools | ❌ Not planned | MCP is the extension mechanism |

---

## Phase 1 — Foundation ✅

Load a plugin from a directory, validate its manifest, manage enable/disable
state across surfaces.

- **Types** (`types.ts`, `PluginManifest.ts`): `PluginManifest` (Zod),
  `PluginScope`, `PluginSource`, `LoadedPlugin` with discriminated `state`.
- **Loader** (`PluginLoader.loadFromDir`): reads `plugin.json` from the plugin
  root, validates (lenient by default, `.strict()` for author validation),
  returns `{ plugin }` or `{ error }`.
- **Registry** (`PluginRegistry`): `enable`, `disable`, `reload`,
  `bootstrapEnabledPlugins`, `reconcileFromConfig`; per-plugin promise-chain
  serialization; evicted set; atomic 5-slot enable with reverse-order rollback.
- **Provider contract** (`IPluginProvider`): `initialize`, `listMeta`, `load`,
  `exists`, `remove`, `writeFiles`, `getRoot`.
- **Cache** (`PluginCache`): `cache/<marketplace>/<plugin>/<version>/`, orphan
  markers, `gcOrphans()` with a 7-day TTL (`WORKX_PLUGIN_ORPHAN_TTL_MS`).
- **Install ledger** (`installed_plugins_v2.json`).
- **Bootstrap**: wired in `src/extension/background/service-worker.ts`,
  `src/server/agent/ServerAgentBootstrap.ts`, and
  `src/desktop-runtime/WorkXRuntimeBootstrap.ts`.

## Phase 2 — Skills ✅

- `SkillSlotLoader` scans `skills/` (single `SKILL.md` or `<sub>/SKILL.md`),
  parses with the existing `SkillParser`, registers namespaced (`plugin:skill`)
  into the global `SkillRegistry`.
- `${CLAUDE_PLUGIN_ROOT}` / content-safe `${user_config.*}` substitution applied
  to skill bodies.

## Phase 3 — Commands ✅

- `CommandSlotLoader` scans `commands/*.md` (or an inline manifest map),
  registers `plugin:command` into `PluginCommandLoader`.
- Argument substitution: `$@` (all args) and `$N` (1-indexed), single-pass and
  safe against `$$`/`$&`/backreference reinterpretation from untrusted args.

## Phase 4 — Hooks ✅ (inline)

Hooks shipped (they were deferred in the original proposal).

- `HookSlotLoader` reads inline `manifest.hooks` and registers them per session
  via `HookRegistry.registerFromConfig(..., { type: 'plugin', pluginId })`.
- Events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`,
  `SessionEnd`, `UserPromptSubmit`, `Stop`, `PermissionRequest`,
  `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `PreCompact`,
  `PostCompact`, `ConfigChange`.
- Types: `command` (desktop/server only), `prompt` (all surfaces), `http`.
- **Outstanding**: resolving hooks from separate files within a plugin (path
  references) — inline only today.

## Phase 5 — MCP ✅ (inline)

- `McpSlotLoader` reads inline `mcpServers`, expands `${CLAUDE_PLUGIN_ROOT}` and
  strict `${user_config.*}`, calls `MCPManager.addServer({ pluginId })`.
- Duplicate server names suppressed (case-insensitive) with a structured error;
  `removeByPluginId()` on disable.
- **Outstanding**: path-referenced `.mcp.json` inside a plugin.

## Phase 6 — Sub-agents ✅

- `SubAgentSlotLoader` scans `agents/*.md`, registers `plugin:agent` types into
  the per-session `SubAgentRunner`.
- Sensitive frontmatter (`permissionMode`, `hooks`, `mcpServers`) is dropped with
  a warning (trust boundary).

## Phase 7 — Marketplace & Distribution ✅ (server / desktop)

- `MarketplaceRegistry` fetches `marketplace.json` by git clone (`git.ts`,
  hardened against interactive prompts), gated by admin source/name policy.
- Install sources (`PluginSource`): `github`, `git`, `url`, `npm`, `path`,
  `bundled`.
- `dependencyResolver` computes a post-order transitive closure (root never
  skipped; only the root marketplace's allowlist applies).
- `PluginInstaller` materializes fail-closed with SHA verification;
  `PluginAutoupdate` performs SHA-diff updates and honors delisting
  (`forceRemoveDeletedPlugins`) via the safe uninstall path.
- `BundledPluginRegistry` registers compile-time plugins (`<name>@bundled`).
- **Outstanding**: extension-side marketplace/installer wiring.

## Phase 8 — Governance ✅

- `policy.ts` loads admin policy from a platform location separate from user
  config: plugin allow/block (`enabledPlugins` map), marketplace
  allow/blocklists, reserved-name / homoglyph guard for official names.
- `PluginPolicy` predicates (`isBlocked`, `isForceEnabled`) are enforced at
  install and enable time (fail-closed).

## Not Implemented

- **LSP servers** (`.lsp.json` / Language Server Protocol). No client exists.
- **Native (non-MCP) tool registration from plugins.** Browser tools remain core
  platform capabilities; plugins extend tooling through MCP. `workx.toolExposure`
  controls how existing tools are surfaced, not registration of new native tools.

## Cross-Cutting Concerns (as built)

- **Error handling**: slot errors accumulate in `loadErrors` without crashing the
  agent; a thrown error triggers reverse-order rollback. `PluginError` is
  structured (`PluginErrors.ts`).
- **Security**: SHA-pinned fail-closed installs; admin policy gates; sensitive
  `userConfig` backed by the credential store; sub-agent sensitive-field
  stripping; an evicted set blocks re-enable of an uninstalled plugin until
  process restart.
- **Lifecycle safety**: uninstall **orphan-marks** rather than hard-deletes, so
  live sessions keep reading files; a 7-day GC sweep reclaims them. Active-task
  guards refuse destructive reload/uninstall while background sub-agents run.
- **Backward compatibility**: standalone skills, user MCP configs, and server
  channel adapters are unaffected — plugins are additive.
