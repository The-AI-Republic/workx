# Track 10: Plugin System

> **Status (2026-05-13):** Design ready. Active PR: none.
> Layers a claudy-compatible plugin packaging system on top of BrowserX's existing
> skill / hook / MCP / sub-agent registries. Likely splits into **10a (foundation),
> 10b (distribution), 10c (hardening)** at implementation time, mirroring 08's pattern.
>
> Key decisions resolved (see [Validation Notes 2026-05-13](#validation-notes-2026-05-13)):
> - **v1 scope:** Full claudy parity across three phases. Single track folder until
>   first PR; split when 10b begins.
> - **Compatibility:** drop-in compatible with claudy's `plugin.json` schema. A working
>   claudy plugin loads in BrowserX for the slots BrowserX supports (skills, hooks, MCP,
>   subagents); unsupported slots (commands, output-styles, LSP) are silently ignored.
> - **v1 capability slots:** `skills`, `hooks`, `mcpServers`, `agents` (subagents).
> - **Deferred slots:** `commands` (blocked on Track 03), `outputStyles` (subsystem doesn't
>   exist), `lspServers` (not relevant), `channels` (out of scope — keeps existing
>   `src/server/plugins/` loader).
> - **Reference pattern for plugin-scoped lifecycle:** `HookRegistry.unregisterBySource()`
>   from PR #198 — every other registry must grow the same shape.

## Problem

BrowserX has the capability primitives — `SkillRegistry`, `HookRegistry`, `MCPManager`,
`SubAgentRegistry` — but no way to package, distribute, version, install, enable, disable,
or update bundles of capabilities as units. Each primitive is registered through a
different bootstrap path with different lifecycle semantics. There is no shared concept
of "plugin" the user can install once and toggle on/off to add multiple capabilities
simultaneously.

Three directories named `plugins/` exist in `src/` but solve unrelated problems:

| Path | Purpose | Relevance |
|---|---|---|
| `src/extension/tools/dom/plugins/` | Site-specific DOM adapters (e.g. `GoogleDocPlugin`) | Compile-time site behavior; **not** user-extensibility |
| `src/tools/dom/plugins/` | Older path for the same | Same as above |
| `src/server/plugins/` | "OpenClaw" channel adapters (Slack, Telegram, …) | Has its own loader; **not** general-purpose plugins. `OpenClawPluginApi` exposes one method: `registerChannel` |

None of these read a manifest. None aggregate capabilities. None expose a `/plugin` UI.

Claudy's plugin system solves this with a `plugin.json` manifest that declares which
skills/hooks/MCP/agents/commands/output-styles a plugin contributes, plus a marketplace,
installation, autoupdate, and trust pipeline. We adopt that model, drop-in compatible
at the schema layer.

## What Claudy Does

Layered overview, mapped to source paths under `/home/rich/dev/study/claudy/src`:

1. **Manifest** (`utils/plugins/schemas.ts` → `PluginManifestSchema`): `plugin.json`
   declares capability slots. Each slot points at a directory or inline config.
   Required: `name`, `version`. All capability slots optional.
2. **Loader** (`utils/plugins/pluginLoader.ts` + per-slot `loadPlugin*.ts`): reads
   manifest, validates with Zod, dispatches each slot to its specific loader, which
   in turn registers contributions into the relevant runtime registry.
3. **Built-in plugins** (`plugins/builtinPlugins.ts`): in-process plugin registration
   for capabilities that ship with the CLI; user-toggleable.
4. **Marketplace** (`utils/plugins/marketplaceManager.ts`): git-backed catalogue —
   `marketplace.json` listing available plugins. Multiple marketplaces supported.
   Official Anthropic marketplaces are protected from impersonation by reserved-name
   and source-org checks (`schemas.ts` lines 17–169).
5. **Installation** (`services/plugins/PluginInstallationManager.ts`): clones plugin
   repo, SHA-pinned, into per-user cache. Trust prompt on first install.
6. **Autoupdate** (`utils/plugins/pluginAutoupdate.ts`): background SHA check + apply
   for marketplaces with `autoUpdate: true`. Gated on marketplace trust.
7. **Policy** (`utils/plugins/pluginPolicy.ts`, `pluginBlocklist.ts`): admin blocklist
   or version pin support.
8. **UI** (`commands/plugin/*.tsx`): `/plugin` slash command — browse, install, manage,
   options, trust warning, validation.
9. **Reload** (`commands/reload-plugins/`): re-scan without restart. Triggers
   `resetSentSkillNames()` (`utils/attachments.ts:2612`) so newly-installed plugin
   skills get re-announced into the next prompt.

## BrowserX Mapping

### Current State

| Claudy capability | BrowserX equivalent | Gap |
|---|---|---|
| `plugin.json` manifest | — | No manifest concept |
| `pluginLoader.ts` | — | Each subsystem loads independently |
| `SkillRegistry.register()` | `src/core/skills/SkillRegistry.ts` | No `pluginId` field; no `removeByPluginId()` |
| `HookRegistry.register()` | `src/core/hooks/HookRegistry.ts` ✅ | Already has `source` + `unregisterBySource()`. Just needs `'plugin'` source variant. |
| `MCPManager.addServer()` | `src/core/mcp/MCPManager.ts` | No `pluginId` on `IMCPServerConfig`; no bulk removal by plugin |
| Sub-agent type registration | `src/tools/AgentTool/register.ts` | Types registered at bootstrap via `registerSubAgentTool({ subAgentTypes })`. No runtime add/remove. |
| `marketplaceManager` | — | Missing |
| `PluginInstallationManager` | — | Missing |
| `/plugin` UI | — | Missing (note: `/plugin` does not conflict with `src/server/plugins/` channel loaders — those have no slash command) |
| `resetSentSkillNames()` | — | Missing — skill listing has no reinjection trigger |

### Integration Seams

Every registry needs the same three things:

1. A `source: PluginSource` (or `pluginId`) tag on each registration.
2. A `removeByPluginId(pluginId: string): void | Promise<void>` method.
3. A "changed" notification primitive so the agent's next prompt picks up the delta.

**HookRegistry already has shape (1) and (2)** via `HookSource` and
`unregisterBySource(source)` (`src/core/hooks/HookRegistry.ts:91`). Treat this as the
reference shape; every other registry grows to match.

## Design Principles

1. **Drop-in compatible.** A working claudy plugin directory, copied into BrowserX,
   registers correctly for slots BrowserX supports. Unsupported slots produce a
   warning, not an error.
2. **Atomic enable/disable.** Toggling a plugin must register or remove *every*
   capability it contributes in one operation. No partial state.
3. **Plugin source is first-class.** Every primitive registry knows which plugin
   (if any) registered each entry. Plugin disable is a pure scoped removal.
4. **Trust before behavior change.** Plugins from external sources start untrusted.
   Untrusted plugins may be loaded for inspection but their hooks do not fire and
   their skills are not auto-invocable. Trust is a user action.
5. **No silent autoupdate of untrusted code.** Autoupdate is opt-in per marketplace
   and requires the marketplace itself to be trusted.
6. **Platform constraints surface as capability gaps, not load failures.** A hook
   plugin loaded in the Chrome extension cannot shell out; the hook is loaded but
   marked `unsupported_on_platform: extension`, and the plugin is still usable for
   its other slots.

## Phased Plan

### Phase 1 — Foundation (PR 10a)

**Scope:** read manifest, register capabilities into existing registries, enable/disable
atomically, `/plugin` UI for **local** plugins only (no marketplace).

```
src/core/plugins/
├── PluginManifest.ts          # Zod schema, claudy-compatible
├── PluginRegistry.ts          # Tracks loaded plugins + enable/disable state
├── PluginLoader.ts            # Unified loader: reads manifest, dispatches to per-slot loaders
├── BundledPluginRegistry.ts   # Compile-time plugin registration (port of builtinPlugins.ts)
├── PluginErrors.ts            # Discriminated union mirroring claudy/types/plugin.ts
├── types.ts                   # LoadedPlugin, PluginSource
└── loaders/
    ├── SkillSlotLoader.ts     # Walks <plugin>/skills/, registers into SkillRegistry
    ├── HookSlotLoader.ts      # Reads manifest.hooks, registers via HookRegistry.registerFromConfig
    ├── McpSlotLoader.ts       # Reads manifest.mcpServers, registers via MCPManager.addServer
    └── SubAgentSlotLoader.ts  # Walks <plugin>/agents/, registers types into SubAgentRegistry
```

Existing-registry extensions required:

- **`SkillRegistry`**: add optional `pluginId` on `Skill`; add `removeByPluginId()`.
- **`HookRegistry`**: extend `HookSource` to include `{ type: 'plugin'; pluginId: string }`.
  Existing `unregisterBySource()` covers removal.
- **`MCPManager`**: add optional `pluginId` on `IMCPServerConfig`; add `removeByPluginId()`.
- **`src/tools/AgentTool/register.ts`**: expose runtime `registerSubAgentTypes(types, source)`
  and `unregisterTypesByPluginId(pluginId)`. Preserve current bootstrap behavior.

Skill listing reinjection:
- On every plugin enable/disable, `SkillRegistry` emits a `changed` signal. The next prompt
  build re-injects skill listing. Mirrors claudy's `resetSentSkillNames()` semantics.

Discovery roots (local only in v1):

| Platform | Location |
|---|---|
| Desktop (Tauri) | `~/.browserx/plugins/<id>/`, `<cwd>/.browserx/plugins/<id>/`, bundled in app resources |
| Extension (Chrome) | IDB-backed virtual plugin store + bundled in extension assets |
| Server (Node) | Same as desktop |

UI (slash commands):
- `/plugin list` — installed plugins + enabled state
- `/plugin enable <id>` / `/plugin disable <id>`
- `/plugin reload` — re-scan plugin dirs
- `/plugin info <id>` — manifest + capabilities + source

### Phase 2 — Distribution (PR 10b)

**Scope:** git-backed marketplace, install/uninstall, SHA pinning, trust prompt.

```
src/core/plugins/
├── MarketplaceSchema.ts        # Zod schema for marketplace.json
├── MarketplaceRegistry.ts      # Tracks added marketplaces, fetches catalogues
├── PluginInstaller.ts          # Clone repo, SHA-pin, write to plugin dir
└── PluginCache.ts              # On-disk cache + integrity verification
```

Platform constraints:

- **Desktop / Server**: use system `git` for clone/fetch.
- **Extension**: no shell access. Use GitHub API tarball + verify-by-SHA. Limited to
  github.com and other tarball-providing hosts. Acceptable v1 limitation.

Trust prompt: on install, show plugin manifest fields + source URL + commit SHA.
User must confirm before files land.

UI:
- `/plugin marketplace add <url>` / `/plugin marketplace list` / `/plugin marketplace remove <name>`
- `/plugin install <id>@<marketplace>`
- `/plugin uninstall <id>`

### Phase 3 — Hardening (PR 10c)

**Scope:** autoupdate, blocklist, policy, impersonation guards, options dialog.

```
src/core/plugins/
├── PluginAutoupdate.ts          # Background SHA check + apply
├── PluginPolicy.ts              # Admin blocklist + version pin enforcement
├── PluginBlocklist.ts           # Bundled + remote blocklist
├── OfficialMarketplaceGuards.ts # Port of claudy's BLOCKED_OFFICIAL_NAME_PATTERN +
│                                  reserved-name + source-org checks (schemas.ts:17-169)
└── PluginOptions.ts             # Per-plugin userConfig values + validation
```

Trust hardening:
- Per-plugin trust state, persisted.
- Untrusted plugin: skills loaded but `trusted: false` (no auto-invocation); hooks loaded
  but execution disabled; MCP servers loaded but not connected.
- `/plugin trust <id>` action requires explicit user confirmation.

UI:
- `/plugin update <id>` / `/plugin update --all`
- `/plugin options <id>` — interactive options dialog
- `/plugin trust <id>`
- Trust warning dialog on first install of untrusted plugin
- Impersonation warning if a third-party marketplace claims a reserved name

## Manifest Schema (v1)

Mirrors claudy's `PluginManifestSchema` minus slots BrowserX doesn't yet support. All
capability slots optional; only `name` and `version` required:

```json
{
  "name": "gh-workflow",
  "version": "0.3.1",
  "description": "GitHub PR/issue workflow helpers",
  "author": { "name": "...", "email": "...", "url": "..." },
  "skills": "./skills",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo running $TOOL" }] }
    ]
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["@github/mcp"], "env": { "GH_TOKEN": "..." } }
  },
  "agents": "./agents",
  "settings": { },
  "userConfig": { }
}
```

Optional BrowserX-specific extensions (never required for claudy compatibility):

```json
{
  "browserx": {
    "domains": ["example.com", "*.github.com"],
    "platforms": ["extension", "desktop"]
  }
}
```

- `browserx.domains` — limit skill auto-invocation / hook firing to matching tab domains.
- `browserx.platforms` — restrict load by platform.

## Compatibility Analysis

| Claudy slot | BrowserX v1 | Notes |
|---|---|---|
| `commands` | Deferred | Blocked on Track 03 |
| `agents` | ✅ Phase 1 | Loaded into `SubAgentRegistry` via runtime registration API |
| `skills` | ✅ Phase 1 | Existing `SkillRegistry` |
| `hooks` | ✅ Phase 1 | Existing `HookRegistry` from PR #198 |
| `outputStyles` | Deferred | Subsystem doesn't exist in BrowserX |
| `mcpServers` | ✅ Phase 1 | Existing `MCPManager` |
| `lspServers` | Out of scope | Not relevant |
| `channels` | ⚠️ Existing dedicated loader | Keep `src/server/plugins/` separate; do not unify in v1 |
| `settings` | ✅ Phase 1 (allowlisted) | Same allowlist constraint as claudy |
| `userConfig` | Phase 3 | Plugin options dialog |

## Risks & Open Questions

1. **Plugin hooks in extension.** Hook entries are shell commands. Chrome extension
   cannot shell out. Decision: load hook entries but mark them `unsupported_on_platform`
   and skip execution; do not refuse the plugin. **Open:** should we define an
   extension-native hook type (e.g., internal handler reference) so plugins can ship
   extension-safe hooks? Recommend deferring to a separate proposal.

2. **Plugin-contributed sub-agent types at runtime.** `SubAgentRegistry` currently
   registers types at bootstrap via `registerSubAgentTool({ subAgentTypes })`
   (`src/tools/AgentTool/register.ts`). Phase 1 must refactor `register.ts` to expose
   a registration API after bootstrap. Small change, hot path. Behavior parity tests
   required.

3. **Extension git clone.** Extension cannot shell. v1 marketplace install uses GitHub
   tarball API → degrades to "GitHub-only marketplaces in extension." Desktop has no
   constraint.

4. **Skill listing reinjection cost.** Claudy's `resetSentSkillNames()` costs ~600 tokens
   per plugin toggle on the next turn. Acceptable; same trade-off in BrowserX.

5. **Plugin filesystem in extension.** No filesystem available. Need a virtualized
   plugin store backed by IDB. Likely extends the existing `FilesystemSkillProvider`
   extension shim rather than building a parallel layer.

6. **MCP server lifecycle on disable.** Disabling a plugin should disconnect its MCP
   servers cleanly. `MCPManager.removeByPluginId` must `disconnect()` before
   `connections.delete()`.

7. **Bundled vs. user-installed conflict.** What if a user installs a plugin with the
   same `name` as a bundled one? Mirror claudy's behavior — bundled takes precedence
   by source priority (bundled > project > user > marketplace).

## Out of Scope

- LSP servers (not relevant to BrowserX)
- Output styles (subsystem doesn't exist)
- Slash commands (deferred — Track 03 prerequisite)
- DOM site plugins (`src/extension/tools/dom/plugins/`) — these are not user-extensibility
  plugins; they stay compile-time
- OpenClaw channel plugins (`src/server/plugins/`) — keep dedicated loader; do not
  unify in this track
- Plugin developer mode (live-reload while editing) — Phase 4 candidate

## Dependencies

- ✅ **Track 01 (Hook & Event System)** — required, shipped via PR #198
- ✅ **Sub-agent system (PR #191)** — required, shipped
- ✅ **MCPManager** — required, exists
- ✅ **SkillRegistry** — required, exists
- ⚠️ **Track 03 (Command & Skill System)** — blocks only the `commands` slot, which is
  deferred from v1. Track 10 can ship without Track 03.
- 07 (Centralized State) — *not* required; would simplify plugin-state subscription but
  not load-bearing.

## Validation Notes (2026-05-13)

- All four target registries confirmed present in current `agent-improvements` HEAD:
  - `src/core/skills/SkillRegistry.ts:12`
  - `src/core/hooks/HookRegistry.ts:24`
  - `src/core/mcp/MCPManager.ts:58`
  - `src/tools/AgentTool/SubAgentRegistry.ts:46` (runtime registry) +
    `src/tools/AgentTool/register.ts` (type registration)
- `HookRegistry.unregisterBySource()` (`HookRegistry.ts:91`) confirmed as reference
  pattern for plugin-scoped cleanup.
- Three `plugins/`-named BrowserX dirs confirmed unrelated to general agent extensibility:
  `src/extension/tools/dom/plugins/`, `src/tools/dom/plugins/`, `src/server/plugins/`.
- Claudy plugin source paths cross-referenced against `/home/rich/dev/study/claudy/src/`
  (read 2026-05-13): `plugins/`, `services/plugins/`, `utils/plugins/`,
  `commands/plugin/`, `commands/reload-plugins/`, `types/plugin.ts`.
- No naming collision: BrowserX has no `src/core/plugins/` directory.
- `/plugin` slash command name unused.
