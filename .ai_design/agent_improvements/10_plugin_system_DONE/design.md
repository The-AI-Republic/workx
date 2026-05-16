# Track 10: Plugin System

> **Status: DONE** — merged to `agent-improvements` via PRs #222/#224/#226/#227 (Track 10 a1/a2/b/c). All 10 design decisions confirmed (see [Resolved Design Decisions](#resolved-design-decisions) below). Q7 rename landed: the prior `src/server/plugins/PluginRegistry` was renamed/moved to `src/server/channel-connectors/connector-registry.ts:ConnectorRegistry`; Track 10 takes the unqualified `PluginRegistry` name under `src/core/plugins/`.
>
> Layers a claudy-compatible plugin packaging system on top of BrowserX's existing skill / hook / MCP / sub-agent / command registries. **Splits at implementation time into 10a-1 (registry refactor) / 10a-2 (manifest + loader + UI) / 10b (distribution) / 10c (hardening)** (see [Phasing](#phased-plan)).
>
> Deep-research validated 2026-05-14 against claudy source (`/home/rich/dev/study/claudy/src`) and BrowserX `agent-improvements@c44d9505`. All file:line references verified at that snapshot.

## Resolved Design Decisions

All 10 decisions confirmed 2026-05-14. The Q-numbered sections below capture the final choice, the reasoning, and any implementation specifics that flow from it. Decisions adopt the claudy pattern unless noted.

### Q1 — Trust model

**Decision: Mirror claudy.** Enabling a plugin IS the trust signal. No separate per-plugin trust state. Disable = revoke. Org policy (`policySettings.enabledPlugins[id] === false` blocks; `=== true` force-enables) is the only enforcement layer beyond explicit user enable.

Claudy has no per-plugin trust boolean — `PluginTrustWarning` (`claudy/commands/plugin/PluginTrustWarning.tsx:6-31`) is a static banner shown on every Browse screen. The only persisted trust signal is `settings.enabledPlugins[id]`. We mirror this — a two-state UX (enabled+untrusted vs enabled+trusted) would double-prompt and confuse without adding meaningful safety.

### Q2 — `HookSource` shape

**Decision: Widen the union** to `'config' | 'session' | { type: 'plugin'; pluginId: string }`.

This is claudy's pattern adapted to BrowserX's unified registry. Claudy bakes plugin identity into each `PluginHookMatcher` record directly (`claudy/utils/plugins/loadPluginHooks.ts:91-157`); since BrowserX's `HookRegistry` is shared across `config`/`session`/`plugin`, we put the identity on the source tag instead. Same effect: per-plugin disable is type-safe and unambiguous. Touches 3 fns in `HookRegistry.ts` (`register`, `registerFromConfig`, `unregisterBySource`) plus the `RegisteredHook.source` field type — small, contained refactor.

### Q3 — Sub-agent runtime registration

**Decision: Runtime APIs.** Add `SubAgentRunner.addType(config, source)` and `SubAgentRunner.removeByPluginId(pluginId)`, plus `ToolRegistry.replace(name, def)` for `sub_agent` tool definition rebuild. Validation reuses existing `validateSubAgentTypeConfig` (`src/tools/AgentTool/register.ts:148-172`).

Bootstrap path adapts: `registerSubAgentTool({ subAgentTypes })` calls `runner.addType(t, { type: 'config' })` per type instead of building the tool def directly. Behavior parity preserved for non-plugin types. Avoids the "please restart your session" UX for an interactive plugin toggle.

### Q4 — Skill provenance

**Decision: Add `pluginId?: string` field to `Skill`.** Keep `Skill.source: 'user' | 'imported'` (authorship semantics). `SkillCommandLoader` reads `pluginId` and stamps `Command.loadedFrom = 'plugin'` when present.

`pluginId` round-trips via the Zod schema (`src/core/skills/types.ts:169-194`) and is persisted by each `ISkillProvider`. Plugin-supplied skills are identifiable in `/help` listings without conflating with the existing authorship-meaning `source` field.

### Q5 — Storage layer

**Decision: `StorageProvider` layer.** New `IPluginProvider` interface (`src/core/plugins/PluginProvider.ts`) with `FilesystemPluginProvider` (desktop), `IndexedDBPluginProvider` (extension), `NodePluginProvider` (server). Mirrors `ISkillProvider` shape.

No `DB_VERSION` bump. No three-adapter sync of `STORE_KEY_PATHS` / `IndexedDBAdapter` / `NodeSQLiteAdapter` / `db_storage.rs`. Plugin lookups are by-id and by-marketplace-name — map operations, no SQL indexes needed. Persisted *state* (`enabledPlugins`, marketplace registry) lives in existing settings/config; the `IPluginProvider` covers on-disk plugin files.

### Q6 — Skill listing reinjection

**Decision: Rely on natural re-render.** `PromptLoader.loadPrompt()` re-runs on every turn (`src/core/PromptLoader.ts:78`); `appendExtensions` (line 104) invokes registered fns fresh each time. Plugin enable/disable takes effect on the next user message without any cache invalidation.

Claudy needed `resetSentSkillNames()` because claudy *caches* the "skills already announced" list per session (`claudy/utils/attachments.ts:2607`). BrowserX has no equivalent cache. If we add one later (e.g. to save ~4K tokens/turn), we'll need to add `SkillRegistry.onChanged(listener)` then — but YAGNI for now.

### Q7 — Naming collision (resolved — rename landed)

**Decision: Out of scope for Track 10.** The prior `src/server/plugins/PluginRegistry` was renamed and **moved** to `src/server/channel-connectors/connector-registry.ts:ConnectorRegistry` in a standalone PR (merged into `agent-improvements`). The whole directory shifted: `src/server/plugins/` → `src/server/channel-connectors/`; class `PluginRegistry` → `ConnectorRegistry`; `OpenClawPluginApi` → `OpenClawConnectorApi`; `plugin-{registry,loader,bridge}.ts` → `connector-{registry,loader,bridge}.ts`.

The unqualified `PluginRegistry` name is now free. Track 10 takes it for `src/core/plugins/PluginRegistry`.

Going forward, "plugin" in BrowserX means consistent with claudy (manifest-based, user-installable capability bundle). The legacy OpenClaw channel adapter system is the `ConnectorRegistry` under `src/server/channel-connectors/`.

### Q8 — MCP server cap

**Decision: Raise `MAX_SERVERS` from 5 to 100 globally.** No `pluginId`-aware exemption — simpler. The conservative original cap was unnecessarily tight; 100 is plenty for any reasonable user-plus-plugin combination.

Implementation: a one-line constant change in `src/core/mcp/MCPManager.ts:34`. Plugin-installed MCP servers still carry `pluginId` for ownership tracking (needed for `removeByPluginId`), but the cap check itself doesn't branch on it. If we ever hit 100 servers in practice that's a separate conversation about per-source quotas — not a problem to anticipate now.

### Q9 — Hook atomic-replace

**Decision: Claudy's atomic clear-then-register inside `HookSlotLoader`,** with the additional asymmetric prune helper that claudy added (gh-36995 fix):

```ts
// Inside HookSlotLoader.load(plugin) — full swap for a single plugin
hookRegistry.unregisterBySource({ type: 'plugin', pluginId });
hookRegistry.registerFromConfig(manifest.hooks, { type: 'plugin', pluginId });
```

Claudy explicitly cites the bug this prevents (gh-29767: stale hooks leak between reload attempts). Synchronous block; no window where neither set is active.

**Plus the prune-only sibling** mirroring claudy's `pruneRemovedPluginHooks` (`claudy/utils/plugins/loadPluginHooks.ts:179-207`):

```ts
// HookSlotLoader.pruneRemovedPlugins(enabledPluginIds: Set<PluginId>)
// Removes hooks whose source.pluginId is not in the set. Adds nothing.
```

**Why two methods, not one:**
- `load(plugin)`: full swap with newly-enabled hooks added. Called from `PluginRegistry.enable` and `/plugin reload`.
- `pruneRemovedPlugins`: removal-only. Called from any "settings changed elsewhere" path (agent-config event subscriber, post-uninstall sweep). **Does not add hooks from newly-enabled plugins** — those wait for the explicit reload signal.

Asymmetric design is intentional (claudy: gh-36995): removals must be immediate (correctness), additions wait for reload (predictability — a user toggling an unrelated plugin in settings shouldn't suddenly fire hooks from a third plugin that's now enabled-but-not-loaded).

### Q10 — Extension command-type hooks

**Decision: Load + skip at executor.** `HookExecutor.executeCommand` (`src/core/hooks/HookExecutor.ts:140-150`) already returns `non_blocking_error` for command hooks in extension mode via the `__BUILD_MODE__` check. Plugin command hooks inherit this behavior automatically.

The `/plugin info <id>` UI surfaces "X hooks unsupported on this platform" as informational. Same plugin source works cross-platform — capabilities degrade gracefully rather than refusing the entire plugin. Mirrors the pattern other slot loaders use (MCP `stdio` transports on platforms without stdio: load entry, don't auto-connect).

---

## Problem

BrowserX has the capability primitives — `SkillRegistry`, `HookRegistry`, `MCPManager`, sub-agent type registration via `SubAgentRunner`, and Track 03's `CommandLoader` — but no way to **package, distribute, version, install, enable, disable, or update** bundles of capabilities as units. Each primitive is registered through a different bootstrap path with different lifecycle semantics. There is no shared concept of "plugin" the user can install once and toggle on/off to add multiple capabilities simultaneously.

**The `plugins/` namespace is now clear** — three rename/cleanup PRs landed in May 2026 to remove pre-existing collisions:

| Original path | Now | Cleared by |
|---|---|---|
| `src/server/plugins/` (OpenClaw channel adapters; `PluginRegistry`, `OpenClawPluginApi`) | `src/server/channel-connectors/` (`ConnectorRegistry`, `OpenClawConnectorApi`) | PR #217 (Q7 rename) |
| `src/extension/tools/dom/plugins/` (site-specific DOM adapters: `DomPlugin`, `GoogleDocPlugin`) | `src/extension/tools/dom/addons/` (`DomAddon`, `GoogleDocAddon`) | PR #218 (DOM addons rename) |
| `src/tools/dom/plugins/` (dead duplicate of the above) | *(deleted)* | PR #216 (dead-code removal) |

None of these renamed/removed systems read a manifest. None aggregate capabilities. None expose a `/plugin` UI. Track 10 takes the unqualified `PluginRegistry` name under `src/core/plugins/` for the new user-facing system.

Claudy's plugin system solves this with a `plugin.json` manifest declaring which skills/hooks/MCP/agents/commands/output-styles a plugin contributes, plus a marketplace, installation, autoupdate, and trust pipeline. We adopt that model, **drop-in compatible at the schema layer** for slots we support.

## What Claudy Does

Layered overview, mapped to source paths under `claudy/src/`:

### Manifest

`utils/plugins/schemas.ts` — `PluginManifestSchema` (lines 884–898). Required: `name` (kebab-case), `version`. Every capability slot is optional. Unknown top-level fields are stripped (zod default), enabling forward-compat as claudy adds new slots.

Each capability slot accepts a **discriminated union**: single path string, array of paths, or inline object/record. Example: `PluginManifestHooksSchema` (lines 348–373) accepts JSON path | inline `HooksSchema` | array. `PluginManifestMcpServerSchema` (lines 543–572) also accepts MCPB `.mcpb`/`.dxt` paths.

`PluginManifestUserConfigSchema` (lines 632–654) — record of identifier-keyed options, each `{ type: 'string'|'number'|'boolean'|'directory'|'file', title, description, required, default, multiple, sensitive, min, max }`. Keys must match `/^[A-Za-z_]\w*$/` because they become `CLAUDE_PLUGIN_OPTION_<KEY>` env vars in hook commands and `${user_config.KEY}` substitutions.

### Marketplace and reserved-name guards

`PluginMarketplaceSchema` (`schemas.ts:1293–1326`) defines the catalogue shape. `PluginMarketplaceEntrySchema` (lines 1254–1285) extends `PluginManifestSchema().partial()` plus `name`, `source: PluginSourceSchema`, `category`, `tags`, `strict?: boolean`.

`PluginSourceSchema` (lines 1062–1161) discriminates on `source`: `'npm' | 'pip' | 'url' | 'github' | 'git-subdir'` plus a relative-path arm. `sha` field is `gitSha()` — strict 40-char lowercase hex (lines 1046–1054).

**Reserved-name enforcement** (lines 17–169):
- `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` (19–28): hard list (`claude-code-marketplace`, `agent-skills`, etc.).
- `BLOCKED_OFFICIAL_NAME_PATTERN` (71–72): regex catching `official` adjacent to `anthropic`/`claude`.
- `isBlockedOfficialName` (87–101): blocks non-ASCII (homograph guard via `NON_ASCII_PATTERN`) and names matching the regex.
- `validateOfficialNameSource` (119–157): reserved names must come from `github` repo prefixed `anthropics/` OR `git` URL `github.com/anthropics/`. All other source types rejected.

`MarketplaceNameSchema` (216–246) rejects names containing spaces, path separators, `..`, `.`, and reserved tokens `inline` / `builtin`.

### `PluginError` discriminated union

`claudy/types/plugin.ts:101–283`. 26 variants including `path-not-found`, `git-auth-failed`, `git-timeout`, `network-error`, `manifest-parse-error`, `manifest-validation-error`, `plugin-not-found`, `marketplace-not-found`, `marketplace-load-failed`, `mcp-config-invalid`, `hook-load-failed`, `component-load-failed`, `marketplace-blocked-by-policy`, `dependency-unsatisfied`, `plugin-cache-miss`, `generic-error`.

Comment at lines 86–99 notes: in production only `generic-error` and `plugin-not-found` are widely emitted; rest is aspirational scaffolding.

### Loader pipeline

`utils/plugins/pluginLoader.ts:3096–3108` — `loadAllPlugins` (memoized) returns `Promise<PluginLoadResult>` = `{ enabled: LoadedPlugin[], disabled: LoadedPlugin[], errors: PluginError[] }` (type at `claudy/types/plugin.ts:285–289`).

`assemblePluginLoadResult` (`pluginLoader.ts:3155–3211`):
1. Parallel: `loadPluginsFromMarketplaces` and `loadSessionOnlyPlugins(getInlinePlugins())`.
2. `getBuiltinPlugins()` (sync).
3. `mergePluginSources` (3009–3064) — order **session > marketplace > builtin**; session collisions drop the marketplace copy *unless* `managedNames` (admin policy) claims the name (admin wins, session rejected).
4. `verifyAndDemote` (3192) — flips `enabled=false` on plugins whose dependency closure is unsatisfied. Session-local; not written to settings.
5. `cachePluginSettings` (3281–3295) — merges `LoadedPlugin.settings` records into the settings cascade base layer.

**Fail-closed policy guard** at `pluginLoader.ts:1922–2020`: if enterprise policy is configured AND `knownMarketplaces[marketplaceName]` cannot be resolved, the plugin is blocked with `marketplace-blocked-by-policy`. Otherwise the source is checked against `isSourceAllowedByPolicy`.

### Per-slot loaders (atomic clear-then-register pattern)

All slot loaders are memoized with `clear*Cache` companions.

- **Hooks** — `utils/plugins/loadPluginHooks.ts:91–157`. The critical pattern: `clearRegisteredPluginHooks()` followed by `registerHookCallbacks()` **in one synchronous block** (lines 138–148). Documented as the fix for gh-29767. Distinct from `pruneRemovedPluginHooks` (lines 179–207) which is called from `clearAllCaches` — prune-only, doesn't re-register newly-enabled hooks (those wait for full reload). Hot-reload subscription at lines 255–287 snapshot-hashes `enabledPlugins + extraKnownMarketplaces + strictKnownMarketplaces + blockedMarketplaces`.

- **Agents** — `loadPluginAgents.ts:231–344`. Recursive `.md` scan. **Sensitive frontmatter fields explicitly ignored** for plugin agents — `permissionMode`, `hooks`, `mcpServers` are dropped with a warning (lines 153–168). Plugin agents are deliberately weaker than user-defined.

- **Commands & Skills** — `loadPluginCommands.ts`. Two exports: `getPluginCommands` (414–677) and `getPluginSkills` (840–942). Skills are subdirectories containing `SKILL.md`; `loadSkillsFromDirectory` (687–838) first probes `<path>/SKILL.md` (single-skill mode), otherwise scans subdirs.

- **Output styles** — `loadPluginOutputStyles.ts:87–174`. Namespace: `pluginName:styleName`. Not relevant to BrowserX (no output-styles subsystem).

- **MCP** — `mcpPluginIntegration.ts`. Errors push as `mcp-config-invalid` / `mcp-server-suppressed-duplicate`.

### Built-in plugins

`plugins/builtinPlugins.ts:1–160`. Module-scoped `Map<string, BuiltinPluginDefinition>` registered via `registerBuiltinPlugin`. Sentinel marketplace `BUILTIN_MARKETPLACE_NAME = 'builtin'`; IDs are `name@builtin`. **Path field is the literal string `'builtin'`** — not a filesystem path. Persistence via `settings.enabledPlugins[id]` boolean; default from `defaultEnabled` field. `isAvailable: () => boolean` lets a builtin self-disable (e.g. by platform).

### Marketplace state model

Three-layer model: intent (settings) → materialization (`~/.claude/plugins/`) → active session state.

`utils/plugins/marketplaceManager.ts`:
- `~/.claude/plugins/known_marketplaces.json` — `Record<name, { source, installLocation, lastUpdated, autoUpdate? }>`. Schema at `schemas.ts:1592–1629`.
- Per-marketplace cache under `~/.claude/plugins/marketplaces/<name>/`.
- `getDeclaredMarketplaces()` (161–192) merges implicit (official marketplace if any `@claude-plugins-official` plugin is enabled) < `--add-dir` < settings (`extraKnownMarketplaces`).

Fetch:
- `github` / `git` sources → `cacheMarketplaceFromGit` (1084) → `gitClone` (803) running `git clone --depth 1` with strict SSH options. Sparse-checkout when `sparsePaths` set.
- `url` sources → `cacheMarketplaceFromUrl` (1256) HTTP-fetch.
- Refresh path uses `git pull` via `gitPull` (528).

**No per-marketplace "trusted" flag.** Marketplace-scoped gates are only org-policy allowlist / blocklist and reserved-name source check.

### Installer

Split across `services/plugins/pluginOperations.ts` (entry) and `utils/plugins/pluginInstallationHelpers.ts` (core). `services/plugins/PluginInstallationManager.ts` is the background marketplace-reconciliation manager (not the installer itself).

`installResolvedPlugin` (`pluginInstallationHelpers.ts:348–`):
1. Parse `plugin@marketplace`; resolve entry via `getPluginById`.
2. Policy guard (`isPluginBlockedByPolicy`).
3. Resolve transitive dependency closure (`resolveDependencyClosure`).
4. Re-check every closure member against policy.
5. Write entire closure to `enabledPlugins` in **one** `updateSettingsForSource` call.
6. Per-member, `cacheAndRegisterPlugin` downloads/copies and records in `installed_plugins_v2.json`.

**On-disk install layout**: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` — sanitized via `[^a-zA-Z0-9\-_]→-`. See `getVersionedCachePathIn` (`pluginLoader.ts:139–162`). External sources land in temp first then `copyPluginToVersionedCache` (2326–2363) atomically moves into place. ZIP cache mode stores `.zip` alongside the version dir.

### Trust prompt

**There is no per-install per-plugin trust prompt.** Every install/browse UI shows the static `PluginTrustWarning` component (`commands/plugin/PluginTrustWarning.tsx:6–31`) — "Make sure you trust a plugin before installing, updating, or using it…" with an org-customizable suffix from `policySettings.pluginTrustMessage`. Enabling a plugin IS the trust signal. (Reflected in Q1 above.)

### Autoupdate

`utils/plugins/pluginAutoupdate.ts`:
- `autoUpdateMarketplacesAndPluginsInBackground()` (227–284) called once from `main.tsx` startup, fire-and-forget. **Not a recurring timer.**
- Gated by `getAutoUpdateEnabledMarketplaces()` (84–102). Default: `true` for `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` minus `NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES`; `false` for third parties unless settings opt in.
- Flow: `refreshMarketplace` per autoUpdate marketplace → `updatePluginsForMarketplaces` (161–200) per installed plugin → `pluginUpdateCallback` (REPL restart notification).
- Updates **non-in-place** — write new version dir, leave old to be GC'd via `.orphaned_at` (7-day grace, `cacheUtils.ts:74–116`). User must `/reload-plugins` or restart to apply.

### Policy + blocklist

`utils/plugins/pluginPolicy.ts:1–21`:
```ts
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
```

Convention: `policySettings.enabledPlugins[id] === false` blocks; `=== true` force-enables and locks.

`utils/plugins/pluginBlocklist.ts:1–128` is the **delisting detector**, not a generic blocklist. Enumerates marketplaces with `forceRemoveDeletedPlugins: true`, computes `installed - marketplace.plugins`, auto-uninstalls (user/project/local scopes; not managed).

`utils/plugins/marketplaceHelpers.ts`:
- `getStrictKnownMarketplaces()` — allowlist (null = no allowlist; `[]` = deny-all).
- `getBlockedMarketplaces()` — blocklist (non-empty = active).
- `isSourceAllowedByPolicy(source)` — allowlist AND not in blocklist.

**Policy is enforced at load time, not runtime.** Once a plugin loads, its capabilities fire normally.

### Reload + skill reinjection

`/reload-plugins` (`commands/reload-plugins/reload-plugins.ts:1–63`) calls `refreshActivePlugins` (`utils/plugins/refresh.ts:72–191`):
1. `clearAllCaches()` (`cacheUtils.ts:44–50`): in order, `clearAllPluginCaches → clearCommandsCache → clearAgentDefinitionsCache → clearPromptCache → resetSentSkillNames`.
2. Sequenced load to avoid cache-only-vs-full race: `await loadAllPlugins()` first (warms cache-only memoize via `pluginLoader.ts:3106`), then parallel `getPluginCommands()` / `getAgentDefinitionsWithOverrides()`.
3. Push to AppState.
4. `await loadPluginHooks()` (full clear-then-register swap).

The "already-sent skill names" cache lives at `utils/attachments.ts:2607`:
```ts
const sentSkillNames = new Map<string, Set<string>>()
```
Cleared by `resetSentSkillNames()` (line 2612). **NOT called from `postCompactCleanup.ts:65`** — re-injecting full skill listing post-compact costs ~4K tokens per event for marginal benefit.

### Slash commands

`commands/plugin/plugin.tsx` renders `<PluginSettings>` which uses `parsePluginArgs` (`commands/plugin/parseArgs.ts:17–103`) — discriminated union: `menu | help | install | manage | uninstall | enable | disable | validate | marketplace`. Subviews: `ManagePlugins`, `BrowseMarketplace`, `ManageMarketplaces`, `AddMarketplace`, `DiscoverPlugins`, `ValidatePlugin`, `PluginOptionsFlow`. Separate `commands/reload-plugins/index.ts` for `/reload-plugins`. CLI handler `cli/handlers/plugins.ts` for non-interactive.

## BrowserX Mapping

### Verified current state (2026-05-14)

Every capability registry has been mapped to current line numbers in `agent-improvements@c44d9505`. The "Gap" column lists work required for the plugin port.

| Claudy capability | BrowserX equivalent | Gap |
|---|---|---|
| `plugin.json` manifest | — | No manifest concept |
| `pluginLoader.ts` | — | Each subsystem loads independently |
| `SkillRegistry.register()` | `src/core/skills/SkillRegistry.ts:125` (`save`) | Add `pluginId?: string` to `Skill` (Q4); add `removeByPluginId()`; **no change-notification primitive** today |
| `HookRegistry.register()` | `src/core/hooks/HookRegistry.ts:36` | `'plugin'` literal already in `HookSource` (`src/core/hooks/types.ts:88`); widen to `{ type: 'plugin'; pluginId }` (Q2). `unregisterBySource()` (line 96) becomes plugin-id-aware. |
| `MCPManager.addServer()` | `src/core/mcp/MCPManager.ts:128` | Add `pluginId?: string` to `IMCPServerConfig` (`src/core/mcp/types.ts:38–83`). Add `removeByPluginId()` that loops `removeServer()` (line 197) — already disconnects. Raise `MAX_SERVERS` constant from 5 to 100 (Q8). |
| Sub-agent type registration | `src/tools/AgentTool/register.ts:29–117` | Types currently frozen at bootstrap. Add `SubAgentRunner.addType/removeType` (Q3) + `ToolRegistry.replace()` for `sub_agent` definition rebuild. |
| Command registration | `src/core/commands/CommandLoader.ts` (Track 03, PR #204) | `CommandLoadedFrom: 'plugin'` already in `src/core/commands/types.ts:17`; `SOURCE_PRECEDENCE` includes it at `src/core/commands/precedence.ts:12`. Add `plugin?: PluginCommandLoader` to `CommandLoaderDeps`. |
| `marketplaceManager` | — | Phase 2 (10b). |
| `PluginInstallationManager` | — | Phase 2 (10b). |
| `/plugin` UI | — | Phase 1 (10a). No existing `/plugin` registration; webfront `commandRegistry.register` throws on duplicate (`src/webfront/commands/CommandRegistry.ts:66`). |
| `resetSentSkillNames()` | — | Not needed — `PromptLoader.loadPrompt()` re-runs every turn (Q6). |

### Architectural surprises discovered in research

These are **not** present in the prior design's assumptions and must be addressed in implementation:

1. **No central change-bus.** Five of the six relevant registries (`SkillRegistry`, `HookRegistry`, `SubAgentRegistry`, `ToolRegistry`, webfront `commandRegistry`) have zero change-notification primitive. Only `MCPManager` has one (`MCPManager.on('event', handler)` at `src/core/mcp/MCPManager.ts:494`). Per Q6, we rely on natural prompt re-render and direct calls from `PluginRegistry.enable/disable`.

2. **Sub-agent types are frozen at registration.** `registerSubAgentTool(engine, options)` runs once per session inside `agentFactory` (`src/desktop/agent/DesktopAgentBootstrap.ts:142`, `src/server/agent/ServerAgentBootstrap.ts:183`). The merged type set produces a single `sub_agent` tool definition installed in `ToolRegistry`. Runtime mutation requires Q3's new APIs.

3. **`Skill.source` only allows `'user' | 'imported'`** (`src/core/skills/types.ts:38`). Plugin provenance threads via new `pluginId?: string` field (Q4); the existing `Skill.source` Zod stays untouched.

4. **`HookSource` is a closed string union.** `unregisterBySource('plugin')` would un-register *every* plugin's hooks indiscriminately. Q2 fix is non-negotiable for per-plugin disable.

5. **`MCPManager.MAX_SERVERS = 5`** (`src/core/mcp/MCPManager.ts:34`). Raised to 100 per Q8 (no per-source exemption — simpler).

6. **Skills storage is at a different layer than `task_output_chunks`.** `IndexedDBSkillProvider` uses the `StorageProvider` abstraction; `task_output_chunks` uses `StorageAdapter`. Q5 picks the `StorageProvider` route for plugins (mirroring skills).

7. **`MCPManager` is a true singleton.** `MCPManager.getInstance()` (line 81) caches globally. Plugin enable/disable affects all sessions. Consistent with current model.

8. **Naming collision** with the prior `src/server/plugins/PluginRegistry` (OpenClaw channels). **Resolved** — the rename PR landed: directory `src/server/plugins/` → `src/server/channel-connectors/`, class `PluginRegistry` → `ConnectorRegistry`. Track 10 takes the unqualified `PluginRegistry` name.

9. **Webfront `commandRegistry.register` throws on duplicate.** Plugin reload that re-registers `/plugin` must `unregister` first or use try/catch. There's no upsert (`src/webfront/commands/CommandRegistry.ts:66`).

10. **`PromptLoader.loadPrompt()` re-runs on every turn.** No invalidation hook exists, but none is needed — extensions registered via `registerPromptExtension` (line 57) are invoked fresh per turn. Plugin-supplied prompt content takes effect next message.

11. **`Skill.source` reserved-names list is hardcoded** at `src/core/skills/SkillRegistry.ts:7` (`'new'|'help'|'settings'`). Add `'plugin'` to prevent skills shadowing the `/plugin` command.

12. **`SkillRegistry` has no `loadedFrom` on `Skill`.** All skills are tagged `loadedFrom: 'skill'` by `SkillCommandLoader.ts:28`. Q4 fix is to thread `pluginId` through `SkillCommandLoader` so it stamps `loadedFrom: 'plugin'` when present.

## Design Principles

1. **Drop-in compatible.** A working claudy plugin directory copied into BrowserX registers correctly for slots BrowserX supports. Unsupported slots produce a warning, not an error.
2. **Atomic enable/disable.** Toggling a plugin must register or remove *every* capability it contributes in one operation. No partial state visible to the user.
3. **Plugin source is first-class.** Every primitive registry knows which plugin (if any) registered each entry. Plugin disable is a pure scoped removal.
4. **Enabling = trusting.** Per Q1, no separate trust state. Org policy is the only enforcement layer beyond explicit user enable.
5. **No silent autoupdate of untrusted code.** Autoupdate opt-in per marketplace; marketplace itself must be trusted (per claudy's reserved-name + policy guards).
6. **Platform constraints surface as capability gaps, not load failures.** A plugin that ships command-type hooks in the extension is loaded; the hooks are no-op'd at executor (Q10). Plugin info UI surfaces this as informational.

## Phased Plan

| Phase | PR title | Scope | Effort |
|---|---|---|---|
| **10a-1** | Plugin registry refactor | Extend five existing registries with `pluginId` + `removeByPluginId` + Q-resolved shape changes. No plugin manifest code yet. | Medium |
| **10a-2** | Plugin manifest + loader + `/plugin` UI | `PluginManifest`, `PluginLoader`, `PluginRegistry`, per-slot loaders, `BundledPluginRegistry`, `IPluginProvider` + 3 platform adapters, `/plugin` slash command. Local plugins only. | Large |
| **10b** | Marketplace + installer | Git-backed marketplace, SHA pinning, install/uninstall, trust prompt UI banner. | Medium |
| **10c** | Hardening | Autoupdate, blocklist, policy, impersonation guards, per-plugin options dialog. | Medium |

Splitting 10a into 10a-1 and 10a-2 is **strongly recommended** based on diff-size projections — 10a-1 alone touches every existing registry (small per-file, broad reach) and benefits from independent review.

## Type Model

```ts
// src/core/plugins/types.ts

import type { HooksConfig } from '@/core/hooks/types';
import type { IMCPServerConfig } from '@/core/mcp/types';
import type { Skill } from '@/core/skills/types';
import type { Command } from '@/core/commands/types';
import type { SubAgentTypeConfig } from '@/tools/AgentTool/types';

export type PluginId = string; // kebab-case, may be qualified as `name@marketplace`
export type PluginScope = 'managed' | 'user' | 'project' | 'local';
export type PluginPlatform = 'desktop' | 'extension' | 'server';

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  name: string;                   // required, kebab-case
  version: string;                // required
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];

  // Capability slots — each accepts string | string[] | inline
  skills?: string | string[];              // path(s) to skills dir(s)
  hooks?: string | HooksConfig | Array<string | HooksConfig>;
  mcpServers?: string | Record<string, IMCPServerConfig> | Array<string | Record<string, IMCPServerConfig>>;
  agents?: string | string[];              // path(s) to agents dir(s) of .md files
  commands?: string | string[] | Record<string, CommandMetadata>;

  settings?: Record<string, unknown>;      // allowlisted at load time (currently only `agent`)
  userConfig?: Record<string, PluginUserConfigOption>;

  // BrowserX-specific extensions (never required for claudy compat)
  browserx?: {
    domains?: string[];          // limit auto-invoke to these tab domains
    platforms?: PluginPlatform[]; // restrict load by platform
  };
}

export interface CommandMetadata {
  source?: string;     // relative path
  content?: string;    // inline body (exactly one of source/content)
  description?: string;
  argumentHint?: string;
  // ... mirrors Track 03 `Command` shape minus loadedFrom
}

export interface PluginUserConfigOption {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title: string;
  description: string;
  required?: boolean;
  default?: unknown;
  multiple?: boolean;
  sensitive?: boolean;        // sensitive values resolve to placeholders in agent/skill content
  min?: number;
  max?: number;
}

export type PluginSource =
  | { type: 'github'; repo: string; ref?: string; sha?: string }
  | { type: 'git'; url: string; ref?: string; sha?: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string }
  | { type: 'file'; path: string }            // local file/dir
  | { type: 'directory'; path: string }
  | { type: 'relative'; path: string }
  | { type: 'builtin' };                       // sentinel for bundled plugins

export interface LoadedPlugin {
  id: PluginId;
  manifest: PluginManifest;
  path: string;                  // on-disk root, or 'bundled' sentinel
  source: PluginSource;
  scope: PluginScope;
  isBuiltin?: boolean;
  sha?: string;                  // present for git-backed sources

  // Lifecycle state — mirrors Track 04's TaskState pattern (typed discriminated union)
  state: PluginState;

  // Slot artifacts (populated by loaders post-discovery)
  resolvedSkillPaths?: string[];
  resolvedAgentPaths?: string[];
  resolvedCommandPaths?: string[];
  resolvedMcpServers?: Record<string, IMCPServerConfig>;
  resolvedHooks?: HooksConfig;

  // Diagnostic surface for /plugin info <id>
  loadErrors?: PluginError[];
}

// Mirrors Track 04's TaskStateBase pattern (src/core/tasks/types.ts:53-73)
export type PluginState =
  | { status: 'disabled' }
  | { status: 'enabling'; startedAt: number }
  | { status: 'enabled'; enabledAt: number; activeSlots: PluginSlot[] }
  | { status: 'disabling'; startedAt: number }
  | { status: 'error'; lastError: PluginError; failedAt: number };

export function isStablePluginStatus(s: PluginState['status']): boolean {
  return s === 'disabled' || s === 'enabled' || s === 'error';
}

// Convenience: derived enabled getter for backwards-compat
export function isPluginEnabled(p: LoadedPlugin): boolean {
  return p.state.status === 'enabled';
}

export type PluginError =
  | { type: 'generic-error'; message: string; pluginId?: PluginId }
  | { type: 'plugin-not-found'; pluginId: PluginId }
  | { type: 'path-not-found'; pluginId: PluginId; path: string }
  | { type: 'manifest-parse-error'; pluginId?: PluginId; path: string; cause: string }
  | { type: 'manifest-validation-error'; pluginId?: PluginId; path: string; issues: string[] }
  | { type: 'component-load-failed'; pluginId: PluginId; slot: PluginSlot; cause: string }
  | { type: 'marketplace-blocked-by-policy'; pluginId: PluginId; blockedByBlocklist: boolean };

// Start with the ~6 variants above. The 26-variant claudy union (claudy/types/plugin.ts:101-283)
// is mostly aspirational scaffolding; grow incrementally.

export type PluginSlot = 'skills' | 'hooks' | 'mcpServers' | 'agents' | 'commands';

export interface PluginLoadResult {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
  errors: PluginError[];
}

// HookSource widening (Q2)
export type HookSource =
  | 'config'
  | 'session'
  | { type: 'plugin'; pluginId: PluginId };
```

## Registry Refactor Patches (Phase 10a-1)

Each subsection below is an implementation-ready patch sketch with current line numbers and the shape change required.

### SkillRegistry

**File:** `src/core/skills/SkillRegistry.ts`, `src/core/skills/types.ts`, `src/core/skills/SkillProvider.ts`.

**Add to `Skill` (`types.ts:32–60`):**
```ts
export interface Skill {
  // ... existing fields ...
  pluginId?: string;            // NEW — plugin owner if any
}
```
Update `skillSchema` Zod (line 169) to add `pluginId: z.string().optional()`. Update `SkillMeta` (lines 67–81) to mirror — round-trip via providers.

**Add to `SkillRegistry`:**
```ts
async removeByPluginId(pluginId: string): Promise<void> {
  const toRemove = this.metas.filter(m => m.pluginId === pluginId);
  for (const meta of toRemove) {
    await this.provider.delete(meta.name);
  }
  this.metas = this.metas.filter(m => m.pluginId !== pluginId);
}
```
No `onChanged` subscription primitive (Q6). `metas` mutation is direct.

**Add to reserved-names list (line 7):** `'plugin'` (prevents skills shadowing `/plugin`).

**`ISkillProvider`:** no signature changes. Existing `save(skill: Skill)` round-trips `pluginId` because it's already part of `Skill`. Each provider (`FilesystemSkillProvider`, `IndexedDBSkillProvider`, `NodeSkillProvider`) must persist the new field — Zod schema in `types.ts` is the round-trip contract.

### HookRegistry

**File:** `src/core/hooks/HookRegistry.ts`, `src/core/hooks/types.ts`.

**Widen `HookSource` (`types.ts:88`):**
```ts
export type HookSource =
  | 'config'
  | 'session'
  | { type: 'plugin'; pluginId: string };
```

**Update `HookRegistry.register` (line 36), `.registerFromConfig` (line 60), `.unregisterBySource` (line 96):** all accept the widened union. Equality checks become discriminated-union deep-equal. Existing call sites pass `'config'` / `'session'` and remain valid.

`RegisteredHook.source` typed as `HookSource`. Filtering for plugin: `r.source !== 'config' && r.source !== 'session' && r.source.type === 'plugin' && r.source.pluginId === target`.

### MCPManager

**File:** `src/core/mcp/MCPManager.ts`, `src/core/mcp/types.ts`.

**Add to `IMCPServerConfig` (`types.ts:38–83`):**
```ts
export interface IMCPServerConfig {
  // ... existing fields ...
  pluginId?: string;       // NEW — plugin owner if any
}
```

**Cap change (Q8) at `MCPManager.ts:34`:** bump constant `MAX_SERVERS` from `5` to `100`. The existing `addServer` cap check (line 128) keeps its current shape — no `pluginId` branching needed.

```ts
const MAX_SERVERS = 100;   // was 5
```

**Add `removeByPluginId`:**
```ts
async removeByPluginId(pluginId: string): Promise<void> {
  const targets = this.configs.filter(c => c.pluginId === pluginId);
  for (const config of targets) {
    await this.removeServer(config.id);   // already disconnects per line 197-227
  }
}
```

`MCPManager.on('config-added' | 'config-removed' | 'tools-updated')` already exists (line 494) — existing extension/desktop subscribers (`service-worker.ts:784–841`, `DesktopAgentBootstrap.ts:339–365`) re-register tools onto sessions automatically. No new wiring.

### SubAgentRunner (sub-agent types)

**File:** `src/tools/AgentTool/register.ts`, `src/tools/AgentTool/SubAgentRunner.ts`, `src/tools/AgentTool/types.ts`.

**Current state:** `SubAgentRunner.customTypes` (`SubAgentRunner.ts:31`) is private, read-only post-construction. `register.ts:122–142` does the three-way merge (builtins < config < custom) and builds the `sub_agent` tool definition once.

**Per Q3, add to `SubAgentRunner`:**
```ts
private types = new Map<string, SubAgentTypeConfig>();
private pluginTypeIndex = new Map<string, Set<string>>();   // pluginId → type ids

addType(config: SubAgentTypeConfig, source: { type: 'plugin'; pluginId: string } | { type: 'config' }): void {
  validateSubAgentTypeConfig(config);    // reuse register.ts:148-172
  this.types.set(config.id, config);
  if (source.type === 'plugin') {
    if (!this.pluginTypeIndex.has(source.pluginId)) this.pluginTypeIndex.set(source.pluginId, new Set());
    this.pluginTypeIndex.get(source.pluginId)!.add(config.id);
  }
  this.rebuildSubAgentTool();
}

removeByPluginId(pluginId: string): void {
  const ids = this.pluginTypeIndex.get(pluginId);
  if (!ids) return;
  for (const id of ids) this.types.delete(id);
  this.pluginTypeIndex.delete(pluginId);
  this.rebuildSubAgentTool();
}

private rebuildSubAgentTool(): void {
  const types = Array.from(this.types.values());
  this.toolRegistry.replace('sub_agent', buildSubAgentToolDef(types));
}
```

**Needs `ToolRegistry.replace(name, def)`** — currently `register` throws on duplicate. Add `replace(name, def)` that overwrites if present, otherwise registers.

**Bootstrap path adapts:** existing `registerSubAgentTool({ subAgentTypes })` (`register.ts:29–117`) sets each type via `runner.addType(t, { type: 'config' })` instead of constructing the tool def directly.

### CommandLoader

**File:** `src/core/commands/CommandLoader.ts`, `src/core/commands/types.ts`, `src/core/commands/precedence.ts`.

**Extend `CommandLoaderDeps` (`CommandLoader.ts:14–17`):**
```ts
export interface CommandLoaderDeps {
  builtin?: BuiltinCommandLoader;
  skill?: SkillCommandLoader;
  plugin?: PluginCommandLoader;   // NEW
}
```

**Extend `loadAll()` (lines 22–27):** add `if (this.deps.plugin) commands.push(...await this.deps.plugin.load());`.

**`'plugin'` already in `CommandLoadedFrom`** (`types.ts:17`) and `SOURCE_PRECEDENCE` (`precedence.ts:12`). Zero type changes.

**Add `PluginCommandLoader`** at `src/core/commands/loaders/PluginCommandLoader.ts`:
```ts
export class PluginCommandLoader {
  private byPluginId = new Map<string, Command[]>();

  add(pluginId: string, commands: Command[]): void {
    this.byPluginId.set(pluginId, commands);
  }

  removeByPluginId(pluginId: string): void {
    this.byPluginId.delete(pluginId);
  }

  async load(): Promise<Command[]> {
    return Array.from(this.byPluginId.values()).flat();
  }
}
```

`PluginCommandLoader` is fed by `CommandSlotLoader` (Phase 10a-2). Commands stamped `loadedFrom: 'plugin'` by `CommandSlotLoader` at construction time.

## PluginRegistry Algorithm

**File:** `src/core/plugins/PluginRegistry.ts` (Phase 10a-2). Mirrors Track 04's `TaskOutputStore` lifecycle patterns (`src/core/tasks/TaskOutputStore.ts:55, 213-248`).

```ts
class PluginRegistry {
  private plugins = new Map<PluginId, LoadedPlugin>();
  private tails = new Map<PluginId, Promise<void>>();    // per-plugin promise chain (Track 04 pattern)
  private evicted = new Set<PluginId>();                  // post-uninstall block (mirrors TaskOutputStore.evicted)

  async enable(id: PluginId): Promise<void> {
    if (this.evicted.has(id)) throw new Error(`plugin ${id} has been uninstalled`);
    return this.serialize(id, async () => {
      const plugin = this.plugins.get(id);
      if (!plugin) throw new Error(`plugin not found: ${id}`);
      if (plugin.state.status === 'enabled') return;

      // Policy check (Phase 10c — empty in Phase 10a)
      if (isPluginBlockedByPolicy(id)) {
        plugin.state = { status: 'error', lastError: { type: 'marketplace-blocked-by-policy', pluginId: id, blockedByBlocklist: false }, failedAt: Date.now() };
        throw new Error('blocked by org policy');
      }

      plugin.state = { status: 'enabling', startedAt: Date.now() };

      // Atomic 5-slot load. On failure, rollback completed slots (log-only on rollback failure).
      const completed: PluginSlot[] = [];
      try {
        if (plugin.manifest.skills) {
          await this.deps.skillSlot.load(plugin); completed.push('skills');
        }
        if (plugin.manifest.hooks) {
          await this.deps.hookSlot.load(plugin); completed.push('hooks');
        }
        if (plugin.manifest.mcpServers) {
          await this.deps.mcpSlot.load(plugin); completed.push('mcpServers');
        }
        if (plugin.manifest.agents) {
          await this.deps.subAgentSlot.load(plugin); completed.push('agents');
        }
        if (plugin.manifest.commands) {
          await this.deps.commandSlot.load(plugin); completed.push('commands');
        }

        plugin.state = { status: 'enabled', enabledAt: Date.now(), activeSlots: completed };
        await this.persistEnabledState(id, true);
      } catch (e) {
        // Reverse-order rollback. Rollback failures are LOGGED, NOT re-thrown —
        // surfacing the original error is more important than rollback completeness.
        // Inconsistent state is bounded: pluginId-scoped removal sweeps fix it on
        // next /plugin disable or /plugin reload.
        for (const slot of completed.reverse()) {
          await this.unloadSlot(plugin, slot).catch(rollbackErr => {
            console.error(`[PluginRegistry] rollback ${id}/${slot} failed:`, rollbackErr);
            plugin.loadErrors = plugin.loadErrors ?? [];
            plugin.loadErrors.push({
              type: 'component-load-failed',
              pluginId: id,
              slot,
              cause: `rollback failed: ${String(rollbackErr)}`,
            });
          });
        }
        plugin.state = { status: 'error', lastError: this.toPluginError(e, id), failedAt: Date.now() };
        throw e;
      }
    });
  }

  async disable(id: PluginId): Promise<void> {
    return this.serialize(id, async () => {
      const plugin = this.plugins.get(id);
      if (!plugin || plugin.state.status !== 'enabled') return;

      plugin.state = { status: 'disabling', startedAt: Date.now() };
      // Disable order is reverse of enable; per-slot errors logged but don't halt.
      const slots: PluginSlot[] = ['commands', 'agents', 'mcpServers', 'hooks', 'skills'];
      for (const slot of slots) {
        await this.unloadSlot(plugin, slot).catch(e => this.logError(slot, e));
      }
      plugin.state = { status: 'disabled' };
      await this.persistEnabledState(id, false);
    });
  }

  private async unloadSlot(plugin: LoadedPlugin, slot: PluginSlot): Promise<void> {
    switch (slot) {
      case 'skills':     await this.deps.skillRegistry.removeByPluginId(plugin.id); break;
      case 'hooks':      this.deps.hookRegistry.unregisterBySource({ type: 'plugin', pluginId: plugin.id }); break;
      case 'mcpServers': await this.deps.mcpManager.removeByPluginId(plugin.id); break;
      case 'agents':     this.deps.subAgentRunner.removeByPluginId(plugin.id); break;
      case 'commands':   this.deps.pluginCommandLoader.removeByPluginId(plugin.id); break;
    }
  }

  // Per-key promise chain — Track 04 TaskOutputStore.tails pattern.
  // `.then(() => undefined, () => undefined)` ensures a failed prior op doesn't poison the chain.
  private async serialize(id: PluginId, fn: () => Promise<void>): Promise<void> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const tail = prev.then(fn, fn);
    this.tails.set(id, tail.then(() => undefined, () => undefined));
    return tail;
  }
}
```

**Serialization:** per-plugin promise chain. `enable` + `disable` on the same id serialize naturally; different ids run concurrently.

**Idempotence:** `enable` on already-`enabled` plugin returns no-op. `disable` on non-`enabled` returns no-op.

**Rollback failure policy:** rollback errors are **logged to `plugin.loadErrors` and surfaced via `/plugin info <id>`** but never re-thrown. Rationale: the user needs the *original* enable failure surfaced, not a rollback failure that masks it. Inconsistent state is bounded (pluginId-scoped), and the next `/plugin disable` or `/plugin reload` sweeps it.

**Uninstall safety:** `evicted: Set<PluginId>` blocks `enable` after `uninstall` (Phase 10b) — mirrors `TaskOutputStore.evicted` (`src/core/tasks/TaskOutputStore.ts:59`).

**Persistence:** `enabledPlugins[id]` boolean in `agentConfig` (see [Storage and Config Wiring](#storage-and-config-wiring)). Read on bootstrap, write on every toggle.

**Bootstrap re-enable algorithm** (`PluginRegistry.bootstrapEnabledPlugins`):
```ts
async bootstrapEnabledPlugins(): Promise<void> {
  const cfg = agentConfig.getConfig().enabledPlugins ?? {};
  const manifests = await this.provider.listMeta();
  for (const m of manifests) {
    const loaded = await this.provider.load(m.name).catch(() => null);
    if (loaded) this.plugins.set(loaded.id, { ...loaded, state: { status: 'disabled' } });
  }
  const toEnable = Object.entries(cfg)
    .filter(([, v]) => v === true)
    .map(([id]) => id)
    .filter(id => this.plugins.has(id))
    .sort();   // deterministic for debugging
  for (const id of toEnable) {
    await this.enable(id).catch(e => console.warn(`[bootstrap] enable ${id} failed:`, e));
  }
}
```

**Sequential, not parallel.** Two reasons: (a) `HookSlotLoader`'s clear-then-register is non-reentrant *per plugin* (fine across plugins, but sequential gives clearer error attribution); (b) `MCPManager.addServer` is async + emits events that other subscribers handle — parallel races the handlers. Cross-plugin dependencies are deliberately NOT modeled here; Phase 10b's dependency closure handles install-time ordering.

## Skill Listing Reinjection Mechanism

Per Q6, no explicit invalidation. The system relies on `PromptLoader.loadPrompt()` re-running on every turn:

```
User message N+1
  → PromptLoader.loadPrompt()
    → appendExtensions()
      → registered 'skills' extension fn invoked fresh
        → SkillRegistry.buildSkillsSystemPrompt() reads current this.metas[]
```

Plugin enable in turn N:
- `PluginRegistry.enable(id)` calls `skillSlotLoader.load()` which calls `skillRegistry.save({ ..., pluginId: id })` repeatedly.
- `save()` (`SkillRegistry.ts:125`) pushes into `metas[]`.
- Next turn's `loadPrompt()` automatically includes the new skill names.

Cost: zero. No bus, no cache, no invalidation.

**Caveat:** If a future change introduces a per-session "skills already announced" cache (analogous to claudy's `sentSkillNames`), we MUST add a `SkillRegistry.onChanged(listener)` subscription primitive and have the cache subscribe. Document this as a forward-compat note in the code.

## Persistence Model

**Storage layer:** `StorageProvider` (Q5), mirroring `ISkillProvider`.

### `IPluginProvider` interface

```ts
// src/core/plugins/PluginProvider.ts

export interface IPluginProvider {
  initialize(): Promise<void>;
  listMeta(): Promise<PluginManifest[]>;          // all known on-disk plugins
  load(id: PluginId): Promise<LoadedPlugin>;
  exists(id: PluginId): Promise<boolean>;
  remove(id: PluginId): Promise<void>;            // delete plugin files

  // For installer (Phase 2)
  writeFiles(id: PluginId, files: Array<{ path: string; content: Buffer }>): Promise<void>;
  getRoot(id: PluginId): string;                  // on-disk root path (or virtual sentinel)
}
```

### Persisted state (separate from `IPluginProvider`)

`enabledPlugins: Record<PluginId, boolean>` lives in existing settings via `agentConfig` (`src/config/types.ts`). One new field on the config schema. Read by `PluginRegistry` on bootstrap to determine which plugins to auto-enable.

`installedPlugins: Record<PluginId, PluginInstallEntry[]>` lives in storage (Phase 2 only — Phase 1 reads plugins directly from disk).

### Platform adapters

| Platform | Adapter | Location | Storage |
|---|---|---|---|
| Desktop | `FilesystemPluginProvider` | `src/desktop/storage/FilesystemPluginProvider.ts` | `~/.airepublic-pi/plugins/<id>/` (mirrors skills) |
| Extension | `IndexedDBPluginProvider` | `src/extension/storage/IndexedDBPluginProvider.ts` | New `StorageProvider` collection `plugins` (similar to `skills`) |
| Server | `NodePluginProvider` | `src/server/storage/NodePluginProvider.ts` | `<workspace>/.browserx/plugins/<id>/` |

No `STORE_KEY_PATHS` / `IndexedDBAdapter` / `NodeSQLiteAdapter` / `db_storage.rs` changes (Q5). The `plugins` collection at the `StorageProvider` layer doesn't require an `IndexedDBAdapter` store — it goes through `StorageProvider.list('plugins')` which abstracts collection access.

### Bundled-plugin registry

`src/core/plugins/BundledPluginRegistry.ts` — module-scoped `Map<PluginId, BundledPluginDefinition>` populated via `registerBundledPlugin`. Mirrors claudy's `plugins/builtinPlugins.ts:1–160`. `BUNDLED_MARKETPLACE_NAME = 'bundled'`; IDs are `<name>@bundled`. Path field is the literal `'bundled'` sentinel.

Initial bundled set: empty (just the scaffold). Future bundled plugins register through `initBundledPlugins()` called from each platform bootstrap.

## Manifest Schema (v1)

Mirrors claudy's `PluginManifestSchema` minus slots BrowserX doesn't support:

```json
{
  "name": "gh-workflow",
  "version": "0.3.1",
  "description": "GitHub PR/issue workflow helpers",
  "author": { "name": "...", "email": "...", "url": "..." },
  "homepage": "https://...",
  "repository": "https://github.com/...",
  "license": "MIT",
  "keywords": ["github", "workflow"],

  "skills": "./skills",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo running $TOOL" }] }
    ]
  },
  "mcpServers": {
    "github": { "command": "npx", "args": ["@github/mcp"], "env": { "GH_TOKEN": "${user_config.GH_TOKEN}" } }
  },
  "agents": "./agents",
  "commands": "./commands",

  "settings": { "agent": "..." },
  "userConfig": {
    "GH_TOKEN": { "type": "string", "title": "GitHub token", "description": "...", "sensitive": true, "required": true }
  },

  "browserx": {
    "domains": ["github.com"],
    "platforms": ["desktop", "extension"]
  }
}
```

**Required:** `name` (kebab-case), `version`. All capability slots optional. Unknown top-level fields **stripped**, not rejected — forward-compatible with future claudy additions like `outputStyles` / `lspServers` / `channels`.

**BrowserX-specific extensions** (never required for claudy compat):
- `browserx.domains` — limit skill auto-invocation / hook firing to matching tab domains.
- `browserx.platforms` — restrict load by platform.

**Zod schema:** `src/core/plugins/PluginManifest.ts`. Built from partial sub-schemas via `.shape` spreading — mirror claudy's pattern verbatim (`claudy/utils/plugins/schemas.ts:884-898`):

```ts
import { lazySchema } from './util';
import { z } from 'zod';

const PluginManifestMetadataSchema = lazySchema(() => z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/),
  version: z.string(),
  description: z.string().optional(),
  author: PluginAuthorSchema.optional(),
  homepage: z.string().url().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
}));

const PluginManifestHooksSchema = lazySchema(() => z.object({
  hooks: z.union([z.string(), HooksSchema, z.array(z.union([z.string(), HooksSchema]))]),
}));

// ...one Schema per slot, single top-level key each...

export const PluginManifestSchema = lazySchema(() => z.object({
  ...PluginManifestMetadataSchema().shape,
  ...PluginManifestHooksSchema().partial().shape,
  ...PluginManifestMcpServersSchema().partial().shape,
  ...PluginManifestAgentsSchema().partial().shape,
  ...PluginManifestSkillsSchema().partial().shape,
  ...PluginManifestCommandsSchema().partial().shape,
  ...PluginManifestSettingsSchema().partial().shape,
  ...PluginManifestUserConfigSchema().partial().shape,
  ...PluginManifestBrowserxSchema().partial().shape,   // BrowserX-specific
}));
```

**Key mechanics:**
- `lazySchema(() => ...)` thunk defers construction (necessary for forward refs and self-reference).
- Each sub-schema is `z.object({ <oneTopLevelKey>: z.union(...) })` — one slot per schema, colocated with its loader.
- `.partial().shape` makes the slot key optional and spreads its underlying record into the parent.
- Metadata is NOT `.partial()` — `name` is required.
- Top-level is **lenient by default** (zod's default `.strip`) — unknown top-level keys silently dropped, so older BrowserX versions silently ignore future claudy slots (forward-compat).
- `.strict()` is used ONLY in the `/plugin validate` command for plugin-author feedback. Load path stays lenient.

This pattern is why claudy plugins with `outputStyles`/`lspServers`/`channels` slots load in BrowserX without modification — those keys get stripped silently.

## Loader-by-slot Wiring (Phase 10a-2)

```
src/core/plugins/
├── PluginManifest.ts             # Zod schema
├── PluginRegistry.ts             # Tracks plugins + enable/disable orchestration
├── PluginLoader.ts               # Reads manifest, dispatches slots
├── BundledPluginRegistry.ts      # Compile-time plugin registration
├── PluginProvider.ts             # IPluginProvider interface
├── PluginErrors.ts               # ~6-variant union (start small)
├── types.ts                      # LoadedPlugin, PluginSource, etc.
└── loaders/
    ├── SkillSlotLoader.ts        # Walks <plugin>/skills/, calls SkillRegistry.save({...pluginId})
    ├── HookSlotLoader.ts         # Reads manifest.hooks, unregister-then-register atomically (Q9)
    ├── McpSlotLoader.ts          # Reads manifest.mcpServers, MCPManager.addServer({...pluginId})
    ├── SubAgentSlotLoader.ts     # Walks <plugin>/agents/, runner.addType(types, {type:'plugin',pluginId})
    └── CommandSlotLoader.ts      # Walks <plugin>/commands/, PluginCommandLoader.add(pluginId, cmds)
```

### Per-slot specifics

**`SkillSlotLoader`:**
- Walks `<plugin>/skills/` recursively for SKILL.md files (mirror claudy `loadSkillsFromDirectory`).
- Parses via existing `SkillParser`.
- Calls `skillRegistry.save({ ...skill, pluginId })` per skill.
- Each skill defaults `trusted: true` (per Q1, enabling the plugin grants trust).

**`HookSlotLoader`:**
- Reads inline `manifest.hooks` or referenced `.hooks.json`.
- **Atomic clear-then-register (Q9):**
  ```ts
  hookRegistry.unregisterBySource({ type: 'plugin', pluginId });
  const ids = hookRegistry.registerFromConfig(hooksConfig, { type: 'plugin', pluginId });
  ```
- Platform gating delegated to `HookExecutor` (Q10).

**`McpSlotLoader`:**
- Reads inline `manifest.mcpServers` or `.mcp.json`.
- Calls `mcpManager.addServer({ ...config, pluginId })` per entry.
- Auto-connect: only if plugin is enabled (it is during load) AND `MCPManager`'s default policy permits.
- On disable: `mcpManager.removeByPluginId(pluginId)` invokes `removeServer` which calls `disconnect()` first.

**`SubAgentSlotLoader`:**
- Walks `<plugin>/agents/` for `.md` files (mirror claudy `loadAgentFromFile` at `loadPluginAgents.ts:65–229`).
- Parses frontmatter into `SubAgentTypeConfig`. **Per claudy, drop sensitive fields** (`permissionMode`, `hooks`, `mcpServers`) with a warning — plugin agents are deliberately weaker than user-defined.
- Calls `subAgentRunner.addType(config, { type: 'plugin', pluginId })`.
- Type-id namespace: `<pluginName>:<typeName>` (mirror claudy convention).

**`CommandSlotLoader`:**
- Walks `<plugin>/commands/` for `.md` files (reuse Track 03 parser).
- Constructs typed `Command` with `loadedFrom: 'plugin'`.
- Calls `pluginCommandLoader.add(pluginId, commands)`.
- On disable: `pluginCommandLoader.removeByPluginId(pluginId)`.

### Userconfig substitution

See dedicated section [User Config Substitution](#user-config-substitution) below for the three-function model, per-slot firing patterns, and the literal placeholder string for sensitive values.

## User Config Substitution

Plugins can declare `userConfig` options (e.g. `GH_TOKEN`, `MAX_RETRIES`). These need to flow into hook commands, MCP server env, and skill/agent body content via `${user_config.KEY}` substitution. Claudy ships **three** substitution functions with **different semantics** — BrowserX mirrors all three (`src/core/plugins/userConfigSubstitution.ts`):

### Function 1: `substitutePluginVariables(value, plugin)` — root/data only

```ts
// Substitutes ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_DATA}.
// Always single-pass, non-recursive. On Windows, normalizes \ → /.
// ROOT is always substituted; DATA only if plugin.source is present.
```

Regex pair: `/\$\{CLAUDE_PLUGIN_ROOT\}/g` and `/\$\{CLAUDE_PLUGIN_DATA\}/g`. Uses **function-form** `.replace((match, key) => value)` so paths containing `$$`, `$'`, `$\``, `$&` don't get reinterpreted as replacement patterns.

### Function 2: `substituteUserConfigVariables(value, userConfig)` — strict (throws)

```ts
// Single-pass /\$\{user_config\.([^}]+)\}/g.
// Throws on missing keys (manifest/userConfig mismatch is a plugin author bug).
// Sensitive values DO substitute — they flow to stdio/stdin, not model context.
```

**Use sites:** MCP server `env`/`command`/`args`, LSP server config, hook `command` strings, hook env vars. The throw is intentional — these targets get the actual sensitive value, so a missing key means the plugin manifest is malformed.

### Function 3: `substituteUserConfigInContent(content, options, schema)` — content-safe

```ts
// Same regex, soft semantics:
// - If schema[key].sensitive === true → substitute literal placeholder
//   "[sensitive option 'KEY' not available in skill content]"
// - If value undefined → leave the ${user_config.KEY} literal intact
//   (matches ${VAR} env behavior for unset vars)
```

**Use sites:** skill body content, agent body content, command body content. **Sensitive values never reach model context** — they resolve to the literal placeholder string (which is the canonical fingerprint plugins authored for claudy expect — keep it verbatim).

### Per-slot firing pattern (mirror claudy exactly)

| Slot | Functions called | Order |
|---|---|---|
| Skill content | `substitutePluginVariables` → `substituteUserConfigInContent` | Plugin vars first, then user-config |
| Agent content | `substitutePluginVariables` → `substituteUserConfigInContent` | Same |
| Command content | `substitutePluginVariables` → `substituteUserConfigInContent` | Same |
| Hook `command` string | `substituteUserConfigVariables` (strict) | Sensitive flows OK |
| Hook env vars | `substituteUserConfigVariables` (strict) + `CLAUDE_PLUGIN_OPTION_<KEY>` env injection | See below |
| MCP `env` / `command` / `args` | `substitutePluginVariables` → `substituteUserConfigVariables` (strict) | Plugin vars then user-config |

### `CLAUDE_PLUGIN_OPTION_<KEY>` env var injection (hooks only)

When invoking a hook command, the executor injects env vars for every userConfig option:

```ts
for (const [key, value] of Object.entries(pluginOpts)) {
  const envKey = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  envVars[`CLAUDE_PLUGIN_OPTION_${envKey}`] = String(value);
}
```

**Sensitive values INCLUDED** in env (claudy `utils/hooks.ts:895-906`) — rationale: hooks run user-controlled scripts, same trust boundary as reading the credential store directly. Schema-side enforcement (`/^[A-Za-z_]\w*$/` regex on userConfig keys at the manifest layer) makes the sanitization belt-and-suspenders.

### Loading options (`loadPluginOptions(pluginId)`)

Memoized per `pluginId`. Reads from two sources:
- `settings.pluginConfigs[pluginId].options` — non-sensitive values
- `credentialStore.read().pluginSecrets[pluginId]` — sensitive values

Merge with credential store winning on key collision. Memoize is essential because the keychain read can be ~50-100ms on macOS (spawns `security find-generic-password`).

### Substitution is NOT recursive

A substituted value containing `${...}` is **not re-scanned**. This is intentional: schema-driven sensitivity differentiation makes recursion fragile (a sensitive value containing `${other_sensitive_key}` would resolve to a non-sensitive placeholder in the re-scan). Tests must cover this — `expect(result).toBe('${nested}')` for a value `'${user_config.K}'` where `K = '${nested}'`.

## Naming and Collision Resolution

Plugin-supplied resources can collide with each other or with built-in resources. Resolution mirrors claudy:

| Resource | Namespace | Notes |
|---|---|---|
| Plugin ID | `<name>@<marketplace>` | `gh-workflow@official` and `gh-workflow@thirdparty` coexist as distinct plugins. Bundled plugins use sentinel marketplace `'bundled'`. |
| Bundled vs marketplace same name | Different IDs (`name@bundled` vs `name@<mkt>`) | Merge order: session > marketplace > bundled. Marketplace version wins when both are enabled. |
| Sub-agent type | `<pluginName>:<typeName>` | Plugin A's `reviewer` and plugin B's `reviewer` register as `pluginA:reviewer` and `pluginB:reviewer`. |
| Command (between plugins) | `<pluginName>:<commandName>` | Both invocable side-by-side. |
| Command (cross-source: builtin/skill/plugin) | First-match by `SOURCE_PRECEDENCE` | `builtin > skill > plugin` (`src/core/commands/precedence.ts:12`). Plugin can never shadow a builtin or skill command. |
| Skill (between plugins) | `<pluginName>:<skillName>` | Plugin skills invocable **only by qualified name** in v1 — prevents accidental shadowing of user skills. User skills keep bare names. |
| MCP server key | Last-write-loses with error | Second plugin's entry emits `mcp-server-suppressed-duplicate` error and is skipped. Rest of plugin still loads. |

**Reserved skill names** (per `SkillRegistry.ts:7` after the Phase 10a-1 addition): `'new' | 'help' | 'settings' | 'plugin'`. Plugin skills with these bare names fail registration; namespaced (`<pluginName>:plugin`) is fine.

The "qualified-name-only" rule for plugin skills is the safety mechanism that lets us load arbitrary plugin skills without worrying about clobbering user-installed ones. A user typing a bare skill name only ever hits their own skills; plugin skills require the `<plugin>:` prefix. Future enhancement (post-v1): a per-user "favorite plugin" preference could allow bare-name invocation of one plugin's skills, but that's not v1 work.

## Discovery and Platform Adapters

Per Q5, plugin discovery is platform-shaped via `IPluginProvider`.

| Platform | Discovery roots |
|---|---|
| **Desktop (Tauri)** | `~/.airepublic-pi/plugins/<id>/`, `<cwd>/.browserx/plugins/<id>/`, bundled in app resources |
| **Extension (Chrome)** | IDB-backed virtual plugin store (extends storage abstraction) + bundled in extension assets |
| **Server (Node)** | Same as desktop with `<workspace>/.browserx/plugins/` |

Each adapter implements `listMeta()` (returns all manifests) and `load(id)` (returns full `LoadedPlugin`). Bootstrap wires the appropriate adapter into `PluginRegistry` at platform-init time.

### Bootstrap wiring sketch

**Desktop** (`src/desktop/agent/DesktopAgentBootstrap.ts`):
```ts
// after skillRegistry init (line 400+)
const pluginProvider = new FilesystemPluginProvider({
  roots: [path.join(homeDir, '.airepublic-pi/plugins')],
});
await pluginProvider.initialize();

this.pluginRegistry = new PluginRegistry({
  provider: pluginProvider,
  deps: {
    skillRegistry: this.skillRegistry!,
    hookRegistry: agent.getHookRegistry(),
    mcpManager: this.mcpManager!,
    subAgentRunner,                          // attached to agent
    pluginCommandLoader: new PluginCommandLoader(),
    skillSlot: new SkillSlotLoader({ skillRegistry: this.skillRegistry! }),
    hookSlot: new HookSlotLoader({ hookRegistry: agent.getHookRegistry() }),
    mcpSlot: new McpSlotLoader({ mcpManager: this.mcpManager! }),
    subAgentSlot: new SubAgentSlotLoader({ subAgentRunner }),
    commandSlot: new CommandSlotLoader({ pluginCommandLoader: ... }),
  },
});

await this.pluginRegistry.bootstrapEnabledPlugins();   // reads settings.enabledPlugins
```

**Extension** (`src/extension/background/service-worker.ts`): same shape, `IndexedDBPluginProvider`.

**Server** (`src/server/agent/ServerAgentBootstrap.ts`): same shape, `NodePluginProvider`. The existing channel-connector registry (`getConnectorRegistry()` returning `ConnectorRegistry`, at `ServerAgentBootstrap.ts:752`) is untouched — Track 10's `PluginRegistry` is a new, separate field on `ServerAgentBootstrap`.

## Active-Session Semantics

Plugin enable/disable interacts with in-flight agent turns. Three timing rules govern correctness:

### Rule 1: Turn-boundary visibility (skill listing, tools list)

`TurnManager.runTurn()` (`src/core/TurnManager.ts:159`) calls `PromptLoader.loadPrompt()` **once at turn start** before `model.run(prompt)`. The prompt and tools list are then frozen for the duration of the turn (potentially many model rounds and tool calls).

**Implication:** if `PluginRegistry.enable(id)` completes *during* a turn, the new plugin's skills/tools/agent-types are NOT visible to that turn's model. They appear in the **next** user turn's `loadPrompt()` call.

Add this doc comment to `PluginRegistry.enable`/`disable`:

```ts
/**
 * Effect on the conversation:
 *   Enabled plugin contributions (skills in system prompt, MCP tools in tools list,
 *   sub-agent types in `sub_agent` schema) take effect on the NEXT user turn, not
 *   the in-flight one. The in-flight model call's prompt and tool list are frozen
 *   at turn start (TurnManager.ts:159).
 */
```

### Rule 2: Deferred `sub_agent` tool-def rebuild

`SubAgentRunner.rebuildSubAgentTool()` replaces the `sub_agent` tool definition in `ToolRegistry`. If a plugin enables mid-turn, the model has already received the *old* `sub_agent` schema; subsequent tool calls in that turn must continue using it. But `ToolRegistry.replace('sub_agent', newDef)` swaps the handler, so an in-flight call lands on the new schema — the LLM sees inconsistent shapes within one turn.

**Fix: defer rebuild to next turn boundary.** Mirror Track 04's pattern of refusing destructive ops while a turn is active.

```ts
// SubAgentRunner additions
private pendingRebuild = false;

addType(config, source) {
  this.types.set(config.id, config);
  this.scheduleRebuild();
}

removeByPluginId(pluginId) {
  // ... remove from types + pluginTypeIndex ...
  this.scheduleRebuild();
}

private scheduleRebuild(): void {
  if (this.session?.hasRunningTask()) {
    this.pendingRebuild = true;
    // Subscribe in constructor: hookDispatcher.fire('TaskCompleted', ...) flushes here.
  } else {
    this.rebuildSubAgentTool();
  }
}
```

Hook into `TaskCompleted` event so the pending rebuild fires at the next safe boundary. Other slots (skills, hooks, MCP, commands) don't share this hazard — the LLM doesn't cache their schemas the same way, so eager mutation is fine.

### Rule 3: `/plugin reload` refuses with active background tasks

`/plugin reload` calls `disable` on every enabled plugin, then re-enables. If any background task (Track 04 `BackgroundAgentTaskState`) is active, the reload risks ripping out sub-agent types or MCP tools mid-execution.

**Mirror Track 04 pattern** (Session.ts active-task guard): refuse reload when `session.listActiveTasks().some(t => t.type === 'background_agent')` is true. Surface error: `Cannot reload: N background agents running. /task list to inspect, /task stop <id> to abort.`

### `/plugin reload` precise flow

```ts
async reload(): Promise<PluginLoadResult> {
  // (1) Active-task guard — Rule 3
  const activeBackground = this.session.listActiveTasks().filter(t => t.type === 'background_agent');
  if (activeBackground.length > 0) {
    throw new Error(`Cannot reload: ${activeBackground.length} background agents running.`);
  }

  // (2) Drain per-plugin serialization locks so reload doesn't race mid-toggle
  await Promise.all(Array.from(this.tails.values()));

  // (3) Snapshot previously-enabled for restore
  const previouslyEnabled = [...this.plugins.values()]
    .filter(p => p.state.status === 'enabled')
    .map(p => p.id);

  // (4) Sequential disable — error-tolerant
  for (const id of previouslyEnabled) {
    await this.disable(id).catch(e => console.warn(`[reload] disable ${id}:`, e));
  }
  // After this point: every registry is plugin-clean. MCP disconnected, hooks gone,
  // sub-agent types removed, plugin commands cleared, plugin skills removed.

  // (5) Re-scan discovery roots
  this.plugins.clear();
  const manifests = await this.provider.listMeta();
  for (const m of manifests) {
    const loaded = await this.provider.load(m.name).catch(() => null);
    if (loaded) this.plugins.set(loaded.id, { ...loaded, state: { status: 'disabled' } });
  }

  // (6) Re-enable previously-enabled set
  const errors: PluginError[] = [];
  for (const id of previouslyEnabled) {
    try { await this.enable(id); }
    catch (e) { errors.push(this.toPluginError(e, id)); }
  }

  // (7) Run the asymmetric prune: anything that was previously enabled but no longer
  //     in the registry (manifest disappeared) gets its hooks pruned via the
  //     pruneRemovedPlugins helper. Other registries already cleaned in step 4.
  this.deps.hookSlot.pruneRemovedPlugins(new Set([...this.plugins.keys()]));

  return { enabled: [...this.plugins.values()].filter(isPluginEnabled),
           disabled: [...this.plugins.values()].filter(p => !isPluginEnabled(p)),
           errors };
}
```

## Storage and Config Wiring

### `agentConfig.enabledPlugins` (the persisted toggle state)

Plugin enable-state lives in the existing `agentConfig` settings cascade — NOT in a new IDB collection (Q5). Required additions:

**`src/config/types.ts`** — extend both `IAgentConfig` and `IStoredConfig`:
```ts
interface IAgentConfig {
  // ... existing fields ...
  enabledPlugins?: Record<PluginId, boolean>;
}
```

**`src/config/defaults.ts`** — `getDefaultAgentConfig()` returns `enabledPlugins: {}`.

**Round-trip:** `extractStoredConfig` (`AgentConfig.ts` ~line 446) and `buildRuntimeConfig` (~line 348) must both include the new field.

### Subscribing to external `enabledPlugins` changes

`agentConfig.on('config-changed', handler)` already exists. **Widen the `IConfigChangeEvent.section` literal union** to include `'enabledPlugins'`:

```ts
// src/config/types.ts (search for IConfigChangeEvent)
section: 'model' | 'provider' | 'profile' | 'preferences' | 'cache' | 'extension'
       | 'security' | 'approval' | 'hooks' | 'enabledPlugins';   // NEW
```

`PluginRegistry` subscribes in its constructor and reconciles when an external source (settings UI, admin policy push, file-watcher) flips a plugin:

```ts
constructor(...) {
  // ...
  agentConfig.on('config-changed', (e) => {
    if (e.section === 'enabledPlugins') this.reconcileFromConfig().catch(/* log */);
  });
}

private async reconcileFromConfig(): Promise<void> {
  const cfg = agentConfig.getConfig().enabledPlugins ?? {};
  for (const [id, want] of Object.entries(cfg)) {
    const plugin = this.plugins.get(id);
    if (!plugin) continue;
    const isEnabled = plugin.state.status === 'enabled';
    if (want === true && !isEnabled) await this.enable(id);
    else if (want === false && isEnabled) await this.disable(id);
  }
}
```

### `policySettings` (Phase 10c)

`policySettings.*` is **not yet present** in `IAgentConfig` — must be added in Phase 10c. Document as a Phase 10c precondition: the policy schema (`enabledPlugins`, `strictKnownMarketplaces`, `blockedMarketplaces`, `pluginTrustMessage`) lands with the policy implementation, not in Phase 10a.

### `IPluginProvider.writeFiles` atomicity per platform

The `writeFiles(id, files)` method is the Phase 10b install seam. "Atomic" means: either all files land or none. Per-platform implementation:

| Platform | Strategy |
|---|---|
| **Desktop (Tauri)** | Write to `<plugins-root>/.staging-<uuid>/<id>/...`, fsync, then `fs::rename(staging, final)`. POSIX `rename` is atomic on same filesystem. Add a Tauri command `plugins_install_atomic(stagingPath, finalPath)` that does the rename in Rust. |
| **Server (Node)** | Same pattern via `fs.promises.rename`. Cross-platform on Node ≥10. |
| **Extension (IDB)** | No rename primitive. Wrap all writes in a single IDB transaction (`db.transaction(['plugins'], 'readwrite')`). IDB auto-aborts the txn on uncaught error — rollback is free. Per-file record shape `{ pluginId, path, content: Uint8Array }` keyed by compound `[pluginId, path]`. |

Interface contract (JSDoc on `IPluginProvider.writeFiles`):
> "Atomic install: either all files land or none. On failure, the plugin root MUST be in the same state as before the call. Implementations: filesystem providers use staging-dir + rename; IDB providers wrap in a single transaction."

### Bundled plugin self-registration

Two patterns compared (claudy uses module-import side effect at `plugins/builtinPlugins.ts`). BrowserX recommendation: **explicit `initBundledPlugins()` per platform**, NOT module-import side effect.

```ts
// src/core/plugins/BundledPluginRegistry.ts
const bundled = new Map<PluginId, BundledPluginDefinition>();
export function registerBundledPlugin(def: BundledPluginDefinition) {
  bundled.set(`${def.name}@bundled`, def);
}
export function getBundledPlugins(): BundledPluginDefinition[] {
  return [...bundled.values()];
}

// src/desktop/agent/initBundledPlugins.ts
import { registerBundledPlugin } from '@/core/plugins/BundledPluginRegistry';
export function initBundledPlugins() {
  // registerBundledPlugin(somePlugin);  // empty for v1
}
```

Each platform bootstrap calls `initBundledPlugins()` **before** `new PluginRegistry(...)`. Pro: explicit, debuggable, tree-shake-safe, platform-customizable (extension can bundle different defaults than desktop). Con: must remember to call — mitigation: `PluginRegistry.constructor` logs a warning if `getBundledPlugins().length === 0`, prompting "did you forget to call initBundledPlugins()?".

Initial v1 set: empty (just the scaffold). Future bundled plugins register via `initBundledPlugins()` per platform.

## Slash Command UI

`/plugin` registered in `src/webfront/commands/builtinCommands.ts` alongside `/new`, `/help`, `/settings`. Single command with subcommand parsing inside the action.

**Phase 10a-2 subcommands:**
- `/plugin list` — installed plugins + enabled state + load errors.
- `/plugin enable <id>` / `/plugin disable <id>`.
- `/plugin reload` — clear `PluginRegistry`, re-scan discovery roots, re-enable previously-enabled.
- `/plugin info <id>` — manifest + capabilities + source.

**Phase 10b additions:**
- `/plugin install <id>@<marketplace>` / `/plugin uninstall <id>`.
- `/plugin marketplace add <url>` / `/plugin marketplace list` / `/plugin marketplace remove <name>`.

**Phase 10c additions:**
- `/plugin update <id>` / `/plugin update --all`.
- `/plugin options <id>` — interactive options dialog.

### Implementation notes

- Webfront `commandRegistry.register` throws on duplicate. Reload must call `unregister('plugin')` first or wrap in try/catch.
- Subcommand parsing is the action's responsibility — webfront splits only on first space (`parseCommandInput` at `CommandRegistry.ts:134`).
- Pattern: one root command, internal switch by `args.split(' ')[0]`.

## Trust Model

Per Q1, **enabling = trusting.** No separate per-plugin trust state.

**Enforcement points:**
1. **Install** (Phase 10b): `PluginInstaller.install(id)` checks `isPluginBlockedByPolicy(id)` before any filesystem write. Refusal returns `marketplace-blocked-by-policy` error.
2. **Enable**: `PluginRegistry.enable(id)` checks `isPluginBlockedByPolicy(id)`. Refusal blocks enable.
3. **Reserved-name marketplace validation** (Phase 10b): port `validateOfficialNameSource` from claudy `schemas.ts:119–157`. Reserved names start empty for BrowserX (no official marketplaces yet); structure ready.
4. **Marketplace allow/blocklist** (Phase 10c): `policySettings.strictKnownMarketplaces` (allowlist) and `policySettings.blockedMarketplaces` (blocklist) gates.

**No runtime gate.** Once a plugin is enabled (= trusted), all its capabilities fire normally. Disabling a plugin removes them.

**Trust warning UI**: `PluginTrustWarning` Svelte component renders the static "Make sure you trust a plugin before installing, updating, or using it..." banner. Org-customizable suffix from `policySettings.pluginTrustMessage`.

## Marketplace (Phase 10b)

Three-layer state model (mirrors claudy):
- **Intent** — `settings.extraKnownMarketplaces` + bundled official marketplaces.
- **Materialization** — `<plugin-root>/marketplaces/<name>/marketplace.json` cached on disk.
- **Active** — `MarketplaceRegistry` in-memory after `addMarketplaceSource`.

### Fetch

- **Desktop / Server**: `git clone --depth 1` via system `git`. Refresh via `git pull`. SHA pinning via `git checkout <sha>` after clone.
- **Extension**: GitHub Tarball API. Limited to `github.com` hosts. Other tarball providers as v2 extension.

### Installer

`PluginInstaller.install(pluginId@marketplace)` — exact step order (mirror claudy `pluginInstallationHelpers.ts:348-481`):

1. **Validate scope** (`'user' | 'project' | 'local'`; never `'managed'`).
2. **Root policy guard** — `isPluginBlockedByPolicy(pluginId)` BEFORE any filesystem write.
3. **Local-source guard** — reject local-source installs without `marketplaceInstallLocation` (avoids the "success but nothing materialized" UX).
4. **Compute cross-marketplace allowlist** — only the **root** marketplace's `allowCrossMarketplaceDependenciesOn` applies; no transitive trust.
5. **Resolve dep closure** via `resolveDependencyClosure` (see algorithm below).
6. **Re-check every closure member** against `isPluginBlockedByPolicy`. Fail-closed: a non-blocked root can't pull in a blocked dependency.
7. **Single atomic settings write** — ONE call updating `enabledPlugins` with the entire closure spread in:
   ```ts
   agentConfig.update({ enabledPlugins: { ...current, ...closureEnabled } });
   ```
   Atomic by the settings layer's lock/transaction. **No partial writes possible** — either all closure entries land or none do.
8. **Materialize loop** (fire-and-forget): for each closure id in post-order (deps first, root last), `cacheAndRegisterPlugin(id, entry, scope)`:
   - Download (git clone / tarball) to a temp path.
   - SHA-verify against entry's `gitSha` field (40-char lowercase hex).
   - Atomic rename into `<plugins-root>/cache/<marketplace>/<plugin>/<version>/`.
   - Record in `installed_plugins_v2.json`.
   - Call `pluginRegistry.register(loadedPlugin)`.
9. **Clear caches** to force re-read on next access.

**Failure recovery semantics:** if step 8 fails for member 3 of 5, members 1–2 remain materialized + registered, settings still claims all 5 enabled. Next `loadAllPlugins()` returns `plugin-cache-miss` for members 3–5; `verifyAndDemote` demotes them **session-locally** (doesn't rewrite settings). User reruns `/plugin install <id>` → idempotent retry fills the gap. Do NOT attempt to roll back the settings write or delete partial materializations — the rollback cost (other sessions may be reading) isn't worth it.

### Dependency closure resolution algorithm

`resolveDependencyClosure(rootId, lookup, alreadyEnabled, allowedCrossMarketplaces)` — pure function, no I/O (lookup injected). DFS with cycle-detection stack and visited set:

```
walk(id, requiredBy):
  if (id !== rootId && alreadyEnabled.has(id)) return null     // skip enabled deps
  if (idMarketplace !== rootMarketplace
      && !allowedCrossMarketplaces.has(idMarketplace))         // cross-mkt block
    return { error: 'cross-marketplace' }
  if (stack.includes(id)) return { error: 'cycle', chain: [...stack, id] }
  if (visited.has(id)) return null
  visited.add(id)
  entry = await lookup(id)
  if (!entry) return { error: 'not-found' }
  stack.push(id)
  for (rawDep of entry.dependencies ?? []):
    dep = qualifyDependency(rawDep, id)   // bare names inherit declaring plugin's marketplace
    err = await walk(dep, id)
    if (err) return err
  stack.pop()
  closure.push(id)                                              // POST-ORDER
```

**Key invariants:**
- Output is **post-order** (topological): deps appear before the plugin that depends on them. Materialize loop processes them in this order so deps are cached before dependents.
- Cycle detection is via the in-flight `stack` (not the `visited` set). Cycles return a human-readable chain `[a → b → c → a]`.
- Cross-marketplace runs AFTER `alreadyEnabled` check (manually-pre-installed cross-mkt deps work).
- Only root marketplace's allowlist applies — **no transitive trust**.
- Root is never skipped even if already enabled (re-install after cleared cache must re-materialize).

Port verbatim from claudy `utils/plugins/dependencyResolver.ts:95-159` — ~60 lines, no claudy infrastructure dependencies.

### Git command specifics (desktop/server)

`gitClone(url, targetPath, ref, sparsePaths)` — exact args:

```ts
const args = [
  '-c', 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes',
  'clone',
  '--depth', '1',
];
if (sparsePaths.length > 0) {
  args.push('--filter=blob:none', '--no-checkout');
} else {
  args.push('--recurse-submodules', '--shallow-submodules');
}
if (ref) args.push('--branch', ref);
args.push(url, targetPath);
```

Environment (always):
```ts
env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '' }
stdin: 'ignore'
```

**Do not relax these.** `BatchMode=yes + StrictHostKeyChecking=yes + GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=''` is the fail-closed-but-don't-block-tooling stance. `StrictHostKeyChecking=yes` (NOT `accept-new`) so unknown SSH hosts fail closed.

**Credential helpers are NOT disabled by default** — users' existing `gh auth`, keychain, `git-credential-store` setups work natively for private repos. Phase 10c autoupdate path passes `disableCredentialHelper: true` for fully-non-interactive background ops.

After sparse clone succeeds:
```ts
git -C <target> sparse-checkout set --cone -- <sparsePaths>
git -C <target> checkout HEAD
```

Submodules: skip `git submodule update` entirely when `.gitmodules` doesn't exist (stat first). Saves ~35ms per pull.

Timeout: default 120s, override via `BROWSERX_PLUGIN_GIT_TIMEOUT_MS` env. Redact credentials in error messages before logging (URLs may contain auth).

Port the stderr-pattern → user-friendly-hint table from claudy `marketplaceManager.ts:649-770+` (host-key-changed warning, "Connect once manually" instruction, SSH auth hints, timeout hint).

### Versioned cache layout

`<plugins-root>/cache/<marketplace>/<plugin>/<version>/` — version sanitized via `/[^a-zA-Z0-9\-_]/→'-'`. Mirrors claudy `getVersionedCachePathIn` (`pluginLoader.ts:139–162`).

Non-in-place updates: new version dir written; old dir tagged `.orphaned_at` for delayed GC. TTL: **7 days** (mirrors claudy `cacheUtils.ts:24`). Pick a separate constant: `BROWSERX_PLUGIN_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000`.

### SHA verification (extension tarball path)

The desktop/server git path verifies SHA implicitly: cloning at a specific commit IS the verification. The extension's GitHub Tarball API needs a different model.

**Model**: marketplace catalogue records `source.sha` (40-hex). Extension fetches:
```
GET https://api.github.com/repos/{owner}/{repo}/tarball/{sha}
```
**The URL itself is SHA-pinned.** GitHub serves the tarball as it existed at that exact commit — no separate content-hash verification needed. Transport-level integrity is via TLS.

```ts
async function fetchPluginTarballExtension(entry: PluginMarketplaceEntry): Promise<Uint8Array> {
  if (entry.source.type !== 'github' || !entry.source.sha) {
    throw new Error('Extension marketplace install requires github source with sha');
  }
  const [owner, repo] = entry.source.repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${entry.source.sha}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Tarball fetch failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
```

**v1 limitation**: extension marketplace installs require `source.type === 'github'` with `source.sha` present. Marketplaces serving plugins as `url`/`npm`/`pip` sources fail in extension; desktop handles them via system git. Surface this as a clear error: `"This plugin requires git-based source resolution and isn't installable in the Chrome extension. Use the desktop or server runtime."`

### `installed_plugins_v2.json` schema

Lives at `<plugins-root>/installed_plugins_v2.json` on disk (filesystem providers) or as a `StorageProvider` record (extension).

```ts
// src/core/plugins/types.ts additions
export type InstalledPluginScope = 'managed' | 'user' | 'project' | 'local';

export interface InstalledPluginEntry {
  scope: InstalledPluginScope;
  version: string;                  // resolved version (manifest.version, or short sha)
  installedAt: number;              // ms epoch
  lastUpdated: number;
  installPath: string;              // absolute path to versioned cache dir
  gitCommitSha?: string;            // 40-hex; absent for inline/bundled sources
  projectPath?: string;             // only for project/local scope
}

export interface InstalledPluginsFileV2 {
  version: 2;
  plugins: Record<PluginId, { entries: InstalledPluginEntry[] }>;
}
```

Zod schema in `src/core/plugins/installedPluginsSchema.ts`. Atomic-write pattern: write to `<file>.tmp`, fsync, rename. On read, fall back to empty `{ version: 2, plugins: {} }` if file missing or unparseable (log warning; don't crash bootstrap).

### Uninstall + active-task guard (matching `/plugin reload` Rule 3)

Before step 1 of the 9-step flow, check for active sub-agent tasks using this plugin's types:

```ts
async uninstall(pluginId: PluginId, scope: InstalledPluginScope): Promise<void> {
  const pluginName = pluginId.split('@')[0];
  const activeTasksUsingPlugin = this.session.listActiveTasks().filter(t =>
    t.type === 'background_agent' &&
    t.subAgentTypeId?.startsWith(`${pluginName}:`)
  );
  if (activeTasksUsingPlugin.length > 0) {
    throw new Error(
      `Cannot uninstall ${pluginId}: ${activeTasksUsingPlugin.length} background tasks ` +
      `running with this plugin's sub-agent types. /task list to inspect, /task stop <id>.`
    );
  }
  // ... proceed with 9-step uninstall
}
```

Same rationale as `/plugin reload` Rule 3 — refuse rather than orphan the type def in memory. Simpler than tracking "orphaned plugin types still in use."

### Uninstall flow

Mirror claudy's **9-step order** (`services/plugins/pluginOperations.ts:427-558`). Implementing fewer steps creates leak paths.

1. **Validate scope** (`'user' | 'project' | 'local'`).
2. **Load all plugins** (both enabled and disabled — uninstall must work for disabled plugins too).
3. **Find plugin** — first via marketplace, fall back to `installed_plugins_v2.json` if delisted. Uninstall must work for plugins whose marketplace dropped them.
4. **Verify installation in this scope.** Rich diagnostics: "installed at X scope, use --scope X"; for project scope specifically: ".claude/settings.json is shared with your team — use --scope local".
5. **Remove from settings** — `enabledPlugins[id] = undefined` (signals deletion via mergeWith).
6. **Clear all caches** — memoize layer + hook prune (gh-36995 — disabled-plugin hooks stop firing immediately).
7. **Remove from `installed_plugins_v2.json`.**
8. **Orphan-mark** if this was the last-scope installation: write `<versionPath>/.orphaned_at` with `Date.now()`. **Do NOT delete files synchronously** — running sessions may still be reading.
9. **Last-scope cleanup**: `deletePluginOptions(id)` wipes both `settings.pluginConfigs[id]` AND `credentialStore.pluginSecrets[id]`; then optionally `deletePluginDataDir(id)`.

**Background GC** (`cleanupOrphanedPluginVersionsInBackground`, runs at startup fire-and-forget):
- Pass 1: for each currently-installed version, unlink any stale `.orphaned_at` marker (handles reinstall-after-orphan).
- Pass 2: walk all cached versions. Not in installed set + no `.orphaned_at` → create one (grace start for old/manual edits). Has `.orphaned_at` + age > 7 days → `rm -rf`. Clean up empty plugin dirs and marketplace dirs after.

Constant: `BROWSERX_PLUGIN_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000`. Same as claudy.

**Failure recovery (process dies mid-uninstall):**
- After step 5 (settings) before step 7 (v2 file): settings says disabled but v2 still has the entry. Next load: plugin doesn't appear enabled (settings is source of truth); GC won't sweep (still in v2) → **leak.** Document and accept; recovery is manual via `/plugin reload` + reinstall.
- After step 7 before step 8: install path exists, not in v2, no marker. Next startup's GC Pass 2 creates the marker → 7-day delayed GC works.
- After step 8 before step 9: keychain entries leak. No recovery. Document.

## Hardening (Phase 10c)

### policySettings — schema and storage

Policy is admin-owned, **separate from `agentConfig`** (which is user-owned). Stored in a separate file the user cannot edit directly:

```ts
// src/core/plugins/types.ts additions
export interface PolicySettings {
  enabledPlugins?: Record<PluginId, boolean>;
  strictKnownMarketplaces?: MarketplaceSource[] | null;  // null = no allowlist active
  blockedMarketplaces?: MarketplaceSource[];             // empty array = no active blocklist
  pluginTrustMessage?: string;                            // appended to PluginTrustWarning banner
}

export type MarketplaceSource =
  | { type: 'github'; repo: string }                      // 'owner/repo'
  | { type: 'host'; hostPattern: string }                 // e.g. '*.corp.example.com'
  | { type: 'path'; pathPattern: string };                // e.g. '/corp/plugins/**'
```

**Platform storage locations:**

| Platform | Path | Read mechanism |
|---|---|---|
| Desktop (Linux/Mac) | `/etc/browserx/policy.json` | `fs.readFile` |
| Desktop (Windows) | `%ProgramData%\BrowserX\policy.json` | `fs.readFile` |
| Server | `<workspace>/.browserx/policy.json` | `fs.readFile` |
| Extension | `chrome.storage.managed.get('policy')` | Chrome managed-storage API (MDM-deployed) |

**Read pattern**: `src/core/plugins/policyLoader.ts` exposes `getPolicySettings(): PolicySettings`. Caches in-memory on first call, refreshed on platform-specific change signal (Chrome `chrome.storage.onChanged`; desktop/server: poll every 5 minutes OR no refresh in v1 — restart to apply). Falls back to `{}` on read failure.

**Where it's consumed:** `PluginPolicy.ts` (next subsection).

### Policy enforcement — `PluginPolicy.ts`

Single function, leaf module (mirror claudy's `pluginPolicy.ts:1-21`):

```ts
// src/core/plugins/PluginPolicy.ts
import { getPolicySettings } from './policyLoader';

export function isPluginBlockedByPolicy(id: PluginId): boolean {
  return getPolicySettings().enabledPlugins?.[id] === false;
}

export function isPluginPolicyForceEnabled(id: PluginId): boolean {
  return getPolicySettings().enabledPlugins?.[id] === true;
}
```

**Enforcement points (verified against claudy's audit):**
1. `PluginRegistry.enable(id)` — check before slot-load loop.
2. `PluginInstaller.install(...)` — root check + every transitive dep.
3. `MarketplaceRegistry.add(source)` — check source against `isSourceAllowedByPolicy` BEFORE any network call.
4. `PluginRegistry.bootstrapEnabledPlugins` — filter out blocked plugins; force-enable `=== true` ones even if user toggled disabled.

### Marketplace source guards — `marketplaceHelpers.ts`

```ts
// src/core/plugins/marketplaceHelpers.ts
import { getPolicySettings } from './policyLoader';

export function isSourceAllowedByPolicy(source: MarketplaceSource): boolean {
  const policy = getPolicySettings();
  // Allowlist active when array (even empty)
  if (Array.isArray(policy.strictKnownMarketplaces)) {
    if (!matchesAny(source, policy.strictKnownMarketplaces)) return false;
  }
  // Blocklist only counts when non-empty
  if (policy.blockedMarketplaces && policy.blockedMarketplaces.length > 0) {
    if (matchesAny(source, policy.blockedMarketplaces)) return false;
  }
  return true;
}

export function isSourceInBlocklist(source: MarketplaceSource): boolean {
  const list = getPolicySettings().blockedMarketplaces ?? [];
  return list.length > 0 && matchesAny(source, list);
}

function matchesAny(source: MarketplaceSource, list: MarketplaceSource[]): boolean {
  return list.some(pattern => matches(source, pattern));
}

function matches(source: MarketplaceSource, pattern: MarketplaceSource): boolean {
  // github vs github: repo equality
  // host vs anything: extract host from source.url, glob-match pattern.hostPattern
  // path vs anything: extract path, glob-match pattern.pathPattern
  // ...
}
```

Glob matching via the existing `minimatch` dep or platform equivalent. Tests cover: exact match, wildcard, blocklist-trumps-allowlist (empty allowlist = deny all), null allowlist = no restriction.

### Impersonation guards — `MarketplaceGuards.ts`

```ts
// src/core/plugins/MarketplaceGuards.ts
// BrowserX-specific reserved names — start empty. Populate when BrowserX has
// official marketplaces. Schema stays ready.
const ALLOWED_OFFICIAL_MARKETPLACE_NAMES: readonly string[] = [];

const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(official.*\b(browserx|airepublic)\b|\b(browserx|airepublic)\b.*official|^(browserx|airepublic)[-_](marketplace|plugins|official))/i;

const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const OFFICIAL_GITHUB_ORG = 'browserx';   // when BrowserX claims an org

export function isBlockedOfficialName(name: string): boolean {
  if (NON_ASCII_PATTERN.test(name)) return true;   // homograph guard
  if (BLOCKED_OFFICIAL_NAME_PATTERN.test(name)) {
    return !ALLOWED_OFFICIAL_MARKETPLACE_NAMES.includes(name);
  }
  return false;
}

export function validateOfficialNameSource(name: string, source: MarketplaceSource):
  { ok: true } | { ok: false; reason: 'reserved-name-non-authoritative' } {
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.includes(name)) return { ok: true };
  // Reserved names must come from BrowserX-controlled sources
  if (source.type === 'github' && source.repo.startsWith(`${OFFICIAL_GITHUB_ORG}/`)) {
    return { ok: true };
  }
  return { ok: false, reason: 'reserved-name-non-authoritative' };
}
```

Called from `MarketplaceRegistry.add(...)` before any network operation. Rejected with `marketplace-blocked-by-policy` error variant carrying `blockedByBlocklist: false` to distinguish impersonation from blocklist.

### Blocklist / delisting — `PluginBlocklist.ts`

Mirrors claudy's `pluginBlocklist.ts:1-128`. **NOT** a generic blocklist — it's the **delisting detector** for marketplaces with `forceRemoveDeletedPlugins: true`.

```ts
// src/core/plugins/PluginBlocklist.ts
export async function detectAndUninstallDelistedPlugins(
  marketplaces: MarketplaceCatalogue[],
  installed: InstalledPluginsFileV2,
): Promise<PluginId[]> {
  const uninstalled: PluginId[] = [];
  for (const mkt of marketplaces) {
    if (!mkt.forceRemoveDeletedPlugins) continue;
    const mktPluginNames = new Set(mkt.plugins.map(p => p.name));
    for (const [pluginId, { entries }] of Object.entries(installed.plugins)) {
      const [name, mktName] = pluginId.split('@');
      if (mktName !== mkt.name) continue;
      if (mktPluginNames.has(name)) continue;
      // Plugin is installed from this marketplace but no longer in catalogue
      for (const entry of entries) {
        if (entry.scope === 'managed') continue;   // leave for admin
        await uninstallSilent(pluginId, entry.scope);
        uninstalled.push(pluginId);
      }
    }
  }
  return uninstalled;
}
```

Called from autoupdate flow. Surfaces a notification to user: `N plugins were removed because their marketplace delisted them: <list>`.

### Autoupdate — full mechanics

**Trigger:** Background fire-and-forget from each platform's bootstrap. Not a recurring timer.

**Algorithm:**

```ts
// src/core/plugins/PluginAutoupdate.ts
export async function autoUpdatePluginsInBackground(): Promise<UpdateResult> {
  if (shouldSkipAutoupdate()) return { updated: [], skipped: true };

  // (1) Refresh autoUpdate-enabled marketplaces (git pull or tarball fetch)
  const mktNames = await getAutoUpdateMarketplaces();
  for (const name of mktNames) {
    await refreshMarketplace(name, { disableCredentialHelper: true }).catch(/* log */);
  }

  // (2) Compute updates by SHA diff
  const installed = await readInstalledPluginsV2();
  const updated: PluginId[] = [];
  for (const [pluginId, { entries }] of Object.entries(installed.plugins)) {
    const [, mktName] = pluginId.split('@');
    if (!mktNames.includes(mktName)) continue;

    const catalogueEntry = await marketplaceRegistry.lookup(pluginId);
    if (!catalogueEntry?.source.sha) continue;

    for (const entry of entries) {
      if (!isInstallationRelevant(entry)) continue;     // skip wrong-project entries
      if (entry.gitCommitSha === catalogueEntry.source.sha) continue;  // up-to-date

      // (3) Fetch new version into a NEW versioned cache path
      const newPath = await fetchToVersionedCache(catalogueEntry);
      markOrphaned(entry.installPath);                  // delayed GC of old version

      // (4) Update entry in-place; old version stays on disk until orphan GC
      entry.installPath = newPath;
      entry.gitCommitSha = catalogueEntry.source.sha;
      entry.lastUpdated = Date.now();
      entry.version = catalogueEntry.version ?? catalogueEntry.source.sha.substring(0, 7);
      updated.push(pluginId);
    }
  }
  await writeInstalledPluginsV2(installed);

  // (5) Detect + handle delisted plugins (PluginBlocklist)
  const delisted = await detectAndUninstallDelistedPlugins(...);

  return { updated, delisted, requiresReload: updated.length > 0 };
}
```

**Marketplace autoUpdate flag** comes from `known_marketplaces.json[name].autoUpdate`. Default: `true` for `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` (currently empty, so effectively `false` everywhere); `false` for third parties. Settings can opt-in third parties.

**Non-in-place semantics**: updates write to new `<cache>/<mkt>/<plugin>/<newVersion>/`, leaving old version on disk with `.orphaned_at` marker. User must `/plugin reload` or restart to apply — running session continues with old version until then.

**User notification** via webfront banner: `N plugin updates available. /plugin reload to apply.` Stored in `agentConfig.ephemeral.pendingPluginUpdates` (a runtime-only field — not persisted).

### Per-plugin options — `PluginOptions.ts`

```ts
// src/core/plugins/PluginOptions.ts
export class PluginOptions {
  constructor(
    private credentialStore: CredentialStore,
    private agentConfig: AgentConfig,
  ) {}

  async get(pluginId: PluginId): Promise<Record<string, unknown>> {
    const nonSensitive = this.agentConfig.getConfig().pluginConfigs?.[pluginId]?.options ?? {};
    const sensitive = await this.credentialStore.getPluginSecrets(pluginId) ?? {};
    return { ...nonSensitive, ...sensitive };   // sensitive wins on collision
  }

  async set(pluginId: PluginId, key: string, value: unknown, schema: PluginUserConfigOption): Promise<void> {
    this.validate(value, schema);
    if (schema.sensitive) {
      await this.credentialStore.setPluginSecret(pluginId, key, value);
    } else {
      const current = this.agentConfig.getConfig().pluginConfigs ?? {};
      const updated = {
        ...current,
        [pluginId]: { options: { ...(current[pluginId]?.options ?? {}), [key]: value } },
      };
      await this.agentConfig.update({ pluginConfigs: updated });
    }
  }

  async delete(pluginId: PluginId): Promise<void> {
    // Called from uninstall step 9; wipes both stores
    await this.credentialStore.deletePluginSecrets(pluginId);
    const current = this.agentConfig.getConfig().pluginConfigs ?? {};
    const { [pluginId]: _, ...rest } = current;
    await this.agentConfig.update({ pluginConfigs: rest });
  }

  private validate(value: unknown, schema: PluginUserConfigOption): void {
    // type check + min/max + required
  }
}
```

**Settings cascade addition**: extend `IAgentConfig` and `IStoredConfig` with `pluginConfigs?: Record<PluginId, { options: Record<string, unknown> }>`.

### Per-plugin options UX

**Desktop / Extension (webfront present):** modal dialog rendered by `src/webfront/components/PluginOptionsDialog.svelte`. For each option in `manifest.userConfig`:
- `type: 'string'` → text input
- `type: 'number'` → number input with min/max constraints
- `type: 'boolean'` → checkbox
- `type: 'directory'` → directory picker (Tauri dialog API) / file input (extension fallback)
- `type: 'file'` → file picker
- `sensitive: true` → masked input (password style); store via credential store
- `required: true` → red asterisk; save button disabled until satisfied
- `default` → pre-populated value
- `multiple: true` → array input (add/remove rows)

On save: call `PluginOptions.set(pluginId, ...)` per changed key, then surface "Settings saved. Run `/plugin reload <id>` to apply." User must explicitly reload.

**Server (no webfront):** fallback to chat-message-based prompt sequence. Render structured input prompts in chat: `Set GH_TOKEN for gh-workflow (sensitive): _`. Less polished, but accessible.

**Slash command surface**: `/plugin options <id>` triggers the modal/prompt. Tests: open dialog for fixture plugin, set each option type, verify round-trip through storage.

### Trust UI banner

`src/webfront/components/PluginTrustWarning.svelte` — static banner shown on `/plugin install` and marketplace browse screens:

```svelte
<div class="plugin-trust-warning">
  <strong>⚠ Trust check</strong>
  Make sure you trust this plugin before installing, updating, or using it. Plugins can run shell commands, access browser tabs, and read/write files.
  {#if policyMessage}
    <p class="policy-message">{policyMessage}</p>
  {/if}
</div>
```

Reads `getPolicySettings().pluginTrustMessage` for org-customizable suffix. No state, no per-plugin trust toggle (Q1).

## User-Facing Surfaces

The slash command output formats below are the **contract** between the plugin system and the chat UI. Implementation in `src/webfront/components/PluginCommandOutput.svelte` (or equivalent renderer).

### `/plugin list`

```
Installed plugins:
  ✓ gh-workflow@official       v0.3.1   user      enabled
  ✓ slack-tools@third-party    v1.2.0   user      enabled
  ⚠ broken-plugin@third-party  v0.1.0   user      error      manifest-validation-error
  ○ docs-search@bundled        v1.0.0   bundled   disabled

4 plugins · 2 enabled · 1 error
```

Columns: status glyph, plugin ID, version, scope, status, (if error) error variant. Sort: enabled first, then disabled, then error. Render plugin IDs as clickable for `/plugin info <id>` in interactive UIs.

### `/plugin info <id>`

```
gh-workflow@official (v0.3.1)
  Author: jane@example.com
  Source: github:browserx-community/gh-workflow at sha 1234567
  Scope: user
  Status: enabled (3 hours ago)

Capabilities:
  Skills: gh-workflow:pr-review, gh-workflow:issue-triage, gh-workflow:branch-namer (3)
  Commands: /gh-workflow:create-pr, /gh-workflow:label (2)
  Hooks: PreToolUse on Bash (1)
  MCP servers: github (1, connected)
  Sub-agent types: gh-workflow:reviewer (1)

User config:
  GH_TOKEN (sensitive, set)
  MAX_RETRIES = 3

No load errors.
```

`Source` line shows `<sourceType>:<identifier> at sha <short>` for git/github sources; `inline`/`bundled`/`url` for others. `Status` includes `lastError` summary when status is `error`.

### `/plugin enable <id>` (success)

```
✓ Enabled gh-workflow@official.
  Loaded: 3 skills, 2 commands, 1 hook, 1 MCP server, 1 sub-agent type.
  Effective on next message.
```

### `/plugin enable <id>` (failure)

```
✗ Failed to enable gh-workflow@official.
  Reason: manifest-validation-error
  At: skills.path "./skills"
  Detail: path does not exist
```

`Reason` is the `PluginError.type`; `At` extracts the path/slot context; `Detail` is the human message. Renderer pulls from `plugin.loadErrors[last]`.

### `/plugin disable <id>`

```
✓ Disabled gh-workflow@official.
  Removed: 3 skills, 2 commands, 1 hook, 1 MCP server (disconnected), 1 sub-agent type.
```

### `/plugin reload` (success)

```
Reloaded 4 plugins.
  ✓ gh-workflow@official:    3 skills, 2 commands, 1 hook, 1 MCP, 1 agent
  ✓ slack-tools@third-party: 5 skills, 0 commands, 2 hooks, 1 MCP, 0 agents
  ✓ docs-search@bundled:     8 skills, 1 command, 0 hooks, 0 MCP, 0 agents
  ⚠ broken-plugin: failed (manifest-validation-error)

3 enabled, 1 error.
```

### `/plugin reload` (refused — active tasks)

```
✗ Cannot reload: 2 background tasks running with plugin sub-agent types.
  - task-abc123 (gh-workflow:reviewer, running 4m)
  - task-def456 (slack-tools:notifier, running 12s)

Run /task list to inspect, /task stop <id> to abort.
```

### `/plugin install <id>@<marketplace>`

```
Installing gh-workflow@official...
  Resolving dependencies... 2 dependencies found.
  Fetching gh-workflow from github:browserx-community/gh-workflow@sha:1234567... done.
  Fetching common-utils@official from github:.../common-utils@sha:abcdef0... done.
  Verifying SHAs... ok.
  Caching to /home/user/.airepublic-pi/plugins/cache/official/gh-workflow/0.3.1/... done.

✓ Installed gh-workflow@official (v0.3.1) + 1 dependency (common-utils).
  Run /plugin enable gh-workflow@official to activate, or /plugin info to inspect.
```

### `/plugin uninstall <id>`

```
✓ Uninstalled gh-workflow@official.
  Disabled and removed: 3 skills, 2 commands, 1 hook, 1 MCP server, 1 sub-agent type.
  Plugin files marked for cleanup (will be removed after 7 days).
  Wiped plugin config and 1 secret.
```

### Error format conventions

All command outputs follow:
- `✓` for success, `✗` for hard failure, `⚠` for partial success / warning, `○` for no-op (already in target state)
- Two-space indent for sub-bullets
- Plugin IDs in plain text (not code-fenced) for selectability
- Counts always show units ("3 skills" not "3")
- Time deltas via relative format ("3 hours ago", "4m")

## Test Plan

### Phase 10a-1 (registries)

- **SkillRegistry**: `pluginId` round-trip via Zod schema; `removeByPluginId` deletes only matching; persists across provider reload.
- **HookRegistry**: widened `HookSource` filtering; `registerFromConfig` with plugin source; `unregisterBySource({ type: 'plugin', pluginId: 'a' })` doesn't touch `pluginId: 'b'` entries; tests for the union-deep-equal helper.
- **MCPManager**: cap exemption for `pluginId`-tagged; `removeByPluginId` disconnects before drop; events fire normally for plugin-installed.
- **SubAgentRunner**: `addType` + `removeByPluginId` + tool definition rebuild; `ToolRegistry.replace` semantics; concurrent `addType` + `removeByPluginId` on same id is serialized.
- **CommandLoader**: `plugin?` dep slot; precedence still `builtin > skill > plugin`; `PluginCommandLoader.removeByPluginId` removes only that plugin's commands.

### Phase 10a-2 (loader)

- **PluginManifest schema**: valid, missing optional slots, unknown top-level field (must pass-through), missing required `name`/`version`, malformed JSON.
- **Per-slot loader unit tests** with mocked target registries.
- **PluginLoader integration test**: load a fixture plugin with all five slots; verify each target registry receives the contribution with the right `pluginId`.
- **PluginRegistry**: `enable` adds to all five; `disable` removes from all five; redundant enable/disable is idempotent; concurrent enable + disable on same id is serialized; enable failure rolls back completed slots.
- **Claudy compatibility fixture**: copy a real claudy plugin under `tests/fixtures/claudy-plugins/<name>/`; confirm loads in BrowserX (for v1 slots) without modification.
- **`/plugin` slash command**: list, info, enable, disable, reload; edge cases (unknown id, malformed args).

### Phase 10b (marketplace)

- Marketplace fetch (git mocked + tarball mocked).
- Installer integration: install fixture plugin from local git repo; verify cache landing + registry update + SHA match.
- SHA mismatch rejection.
- Uninstall: removes from all five registries + settings + cache + options.

### Phase 10c (hardening)

- Policy: blocked plugin refuses to load/enable.
- Impersonation guard: marketplace with reserved name from non-Anthropic-equivalent source rejected.
- Autoupdate: simulate SHA change → autoupdate detects → fetches → user notified → reload applies.
- Options round-trip: set value → restart → value persisted → plugin receives at load.

### End-to-End Integration Scenarios

These scenarios verify the **feature works for a user**, not just that units pass. Live under `src/core/plugins/__tests__/e2e/*.test.ts` using Vitest with real registries (no mocks) and a temp-dir provider.

**E2E-1: Local plugin happy path (Phase 10a-2 gate)**

1. Set up fixture at `<tempDir>/plugins/test-plugin/` with `plugin.json` declaring skills + hooks + commands + one sub-agent type.
2. Bootstrap a `PluginRegistry` with a `FilesystemPluginProvider` rooted at `<tempDir>/plugins`.
3. Call `/plugin list` → assert `test-plugin@local` listed, status `disabled`.
4. Call `/plugin enable test-plugin@local` → assert state transitions to `enabled`, all 4 registries got contributions tagged with `pluginId: 'test-plugin@local'`.
5. Invoke a plugin skill directly → assert content returns correctly.
6. Trigger a `PreToolUse` event matching the plugin's hook → assert hook fires.
7. Run a `sub_agent` tool call with `type: 'test-plugin:reviewer'` → assert sub-agent runs.
8. Call `/plugin disable test-plugin@local` → assert all 4 registries scope-removed; skills/hooks/MCP no longer fire.
9. Call `/plugin info test-plugin@local` → assert status `disabled`, no `loadErrors`.

Acceptance: every step passes without manual intervention.

**E2E-2: Marketplace install/uninstall (Phase 10b gate)**

1. Create a local git repo `<tempDir>/fake-marketplace` with `marketplace.json` listing one plugin entry pinned to a specific SHA.
2. Initialize a second local repo `<tempDir>/test-plugin-repo` with the plugin source; commit; record SHA.
3. Update `fake-marketplace/marketplace.json` to point to that SHA.
4. Call `/plugin marketplace add file://<tempDir>/fake-marketplace` → assert marketplace registered, no policy refusal.
5. Call `/plugin install test-plugin@fake-marketplace` → assert:
   - Resolved dep closure (just root in this test).
   - SHA verified against marketplace entry.
   - Cache landed at `<plugins-root>/cache/fake-marketplace/test-plugin/<version>/`.
   - `installed_plugins_v2.json` updated.
   - `enabledPlugins[id] = true` in settings (single atomic write).
   - `PluginRegistry.enable` called and succeeded.
6. Invoke the plugin's skill → asserts work end-to-end.
7. Call `/plugin uninstall test-plugin@fake-marketplace` → assert:
   - Active-task guard not triggered (no active sub-agents).
   - All 4 registries scope-removed.
   - `enabledPlugins[id]` removed from settings.
   - `installed_plugins_v2.json` no longer has entry.
   - Cache dir has `.orphaned_at` marker (file exists with epoch timestamp).
   - Plugin secrets/options wiped.
8. Re-run the GC sweep with `cleanupAge: 0` (skip the 7-day delay) → assert cache dir actually deleted.

**E2E-3: Autoupdate flow (Phase 10c gate)**

1. Install plugin from fixture marketplace (re-use E2E-2 setup).
2. Update fake marketplace: change `plugin.source.sha` to a new commit.
3. Call `autoUpdatePluginsInBackground()`.
4. Assert:
   - Marketplace refresh fetched new state.
   - SHA diff detected for the installed plugin.
   - New version cached at a different versioned path.
   - Old version marked `.orphaned_at`.
   - `installed_plugins_v2.json` updated with new SHA + path.
   - User-facing banner state `pendingPluginUpdates` populated.
5. Call `/plugin reload` → asserts new version becomes active; old version still on disk (waiting for GC).

**E2E-4: Cross-plugin collision resolution**

1. Install three plugins: `plugin-a`, `plugin-b`, `plugin-c`.
2. Each contributes a skill named `git-status` (so `plugin-a:git-status`, `plugin-b:git-status`, `plugin-c:git-status`).
3. `plugin-a` and `plugin-b` contribute an MCP server with key `myserver`. `plugin-b`'s entry should hit the suppression branch.
4. Verify:
   - All three plugin skills are invocable via qualified names.
   - Bare-name `git-status` does NOT resolve to a plugin skill (only user-skills can).
   - `plugin-b.loadErrors` contains `mcp-server-suppressed-duplicate`; `plugin-a`'s MCP server is the one connected.
   - Disable `plugin-a` → `plugin-b` and `plugin-c` skills + hooks unaffected.
5. Enable `plugin-b` after `plugin-a` was disabled → assert `plugin-b`'s MCP server now successfully registers (no longer a duplicate).

**E2E-5: Failure modes**

For each scenario, run end-to-end and verify the system survives without crash and surfaces clear error to user:

| Scenario | Expected behavior |
|---|---|
| Plugin manifest missing required `name` | `manifest-validation-error`; `loadErrors` populated; plugin appears in `/plugin list` with `error` status |
| Skill slot fails mid-enable; hooks already loaded | Rollback unloads hooks; final state is `disabled`; original error in `loadErrors`; rollback failure (if any) logged as separate `loadErrors` entry but doesn't mask original |
| Plugin enable while a background task is running | Enable succeeds; new sub-agent types not visible to in-flight task; visible to next task |
| `/plugin reload` while background task running | Refused with descriptive error; no state change |
| Uninstall while sub-agent of plugin's type is running | Refused with descriptive error; no state change |
| Process killed mid-uninstall (after settings write, before v2 file update) | Next startup: plugin not loaded (settings is source of truth); cache dir gets `.orphaned_at` on next GC sweep; eventually cleaned up |
| Policy-blocked plugin attempts install | Refused with `marketplace-blocked-by-policy`; no files written |
| Impersonation: third party tries to register marketplace named `browserx-official` | Refused with `reserved-name-non-authoritative` |
| `${user_config.GH_TOKEN}` in MCP env when `GH_TOKEN` not set | Strict substitution throws → MCP slot fails to load; `loadErrors` populated; other slots still load |
| Sensitive `${user_config.GH_TOKEN}` in skill body | Resolves to literal placeholder string; skill loads normally |

**E2E-6: Storage round-trip across platforms**

For each provider (`FilesystemPluginProvider`, `IndexedDBPluginProvider`, `NodePluginProvider`):
1. Install a plugin with mixed files (skills/, agents/, manifest).
2. Restart the platform (re-instantiate provider).
3. Call `provider.listMeta()` → assert plugin listed.
4. Call `provider.load(id)` → assert files round-tripped intact, no corruption.

**E2E-7: Performance smoke**

1. Set up 10 fixture plugins each with 3 skills, 2 commands, 1 MCP server.
2. Measure: `bootstrapEnabledPlugins()` wall-clock < 2s.
3. Measure: subsequent `/plugin reload` < 1s.
4. Measure: agent's `TurnManager.runTurn` warmup overhead vs. zero-plugins baseline < 100ms.

Soft thresholds — failures don't block CI but trigger a perf-review comment.

## Risks

1. **Plugin sub-agent type registration is the highest-coupled refactor.** `SubAgentRunner` is per-runner; Q3's `addType` API requires care that the tool-definition rebuild doesn't break in-flight invocations. Mitigations: rebuild on the runner's event loop tick, not synchronously inside `addType`; assert no in-flight `sub_agent` calls during rebuild.

2. **`HookSource` widening (Q2) is a non-trivial type change.** Touches all `register` / `unregisterBySource` callers. Verify with `tsc` + tests pre-merge.

3. **Plugin filesystem in extension.** No native filesystem; need virtualized plugin store via IndexedDB. Extends `FilesystemSkillProvider`-equivalent pattern. Q5 picks this approach.

4. **MCP server lifecycle on disable.** `MCPManager.removeByPluginId` must call `disconnect()` before drop. Verified: `removeServer` (line 197) already does this; loop is safe.

5. **Bundled vs user-installed name conflict.** Mirror claudy: bundled wins. `mergePluginSources` ordering.

6. **Extension git clone is impossible.** v1 marketplace install in extension is "GitHub-only via tarball API." Documented limitation; non-blocking.

7. **`/plugin reload` while a plugin is mid-enable/disable.** `PluginRegistry.serialize` per-plugin lock prevents this from corrupting state, but global reload must drain all locks first.

8. **Naming collision** with the prior `src/server/plugins/PluginRegistry`. **Resolved by the Q7 rename PR** — directory moved to `src/server/channel-connectors/`, class renamed to `ConnectorRegistry`. Track 10 PRs don't touch the connector files.

## Out of Scope

- LSP servers (not relevant to BrowserX).
- Output styles (subsystem doesn't exist).
- DOM site addons (`src/extension/tools/dom/addons/`, post-PR #218) — stay compile-time; not migrated to plugin format.
- OpenClaw channel connectors (`src/server/channel-connectors/`) — keep dedicated loader; do not unify in this track.
- Channels-as-plugins migration — separate proposal after this track ships.
- Plugin developer mode (live-reload while editing) — Phase 4 candidate.
- Extension-native hook type (non-shell hooks for the extension platform) — separate proposal.
- MCPB (`.mcpb`/`.dxt`) bundle support — Phase 4 if BrowserX wants to consume claudy MCPB packages.

## Dependencies

- ✅ **Track 01 (Hook & Event System)** — required, shipped via PR #198.
- ✅ **Track 03 (Command & Skill System)** — required for `commands` slot, shipped via PR #204.
- ✅ **Sub-agent system (PR #191)** — required, shipped.
- ✅ **MCPManager** — required, exists.
- ✅ **SkillRegistry** — required, exists.
- ✅ **Track 04 (Typed Task Families)** — not required, but plugin-supplied sub-agent types interact with `BackgroundAgentTaskState` so the interface must be respected.
- Track 07 (Centralized State) — *not* required; would simplify plugin-state subscription but not load-bearing.

## Validation Notes (2026-05-14)

All registry surfaces re-verified against `agent-improvements@c44d9505`:
- `src/core/skills/SkillRegistry.ts:32, 125, 138`
- `src/core/skills/types.ts:32-60, 67-81, 118-194`
- `src/core/skills/SkillProvider.ts:7-31`
- `src/core/hooks/HookRegistry.ts:20-27, 36-55, 60-75, 96, 111, 137, 145`
- `src/core/hooks/types.ts:50-71, 88`
- `src/core/hooks/HookExecutor.ts:140-150, 220-228`
- `src/core/mcp/MCPManager.ts:34, 38, 64, 81, 128, 197, 269, 494`
- `src/core/mcp/types.ts:38-118, 284-290`
- `src/tools/AgentTool/register.ts:29-117, 122-142, 148-172`
- `src/tools/AgentTool/SubAgentRunner.ts:31, 612-614`
- `src/tools/AgentTool/types.ts:7-50`
- `src/core/commands/CommandLoader.ts:14-49`
- `src/core/commands/types.ts:17, 25-43, 49-79, 82`
- `src/core/commands/precedence.ts:5-12`
- `src/core/commands/loaders/SkillCommandLoader.ts:14-48`
- `src/core/PromptLoader.ts:57-66, 78, 104-112`
- `src/core/RepublicAgent.ts:79, 81, 996, 1014, 1024, 1038`
- `src/storage/StorageAdapter.ts:17-36, 58-76`
- `src/storage/IndexedDBAdapter.ts:24, 29-52, 168, 337-347`
- `src/server/storage/NodeSQLiteAdapter.ts:17-30, 56-63`
- `tauri/src/db_storage.rs:19-41`
- `src/extension/storage/IndexedDBSkillProvider.ts`
- `src/desktop/storage/FilesystemSkillProvider.ts`
- `src/core/tabs/ActiveTabService.ts:52` (subscribe pattern reference)
- `src/webfront/commands/CommandRegistry.ts:66, 124, 134, 155`
- `src/webfront/commands/builtinCommands.ts:23-54, 67, 79`
- `src/extension/background/service-worker.ts:257, 260, 263, 278, 492, 784-841, 975, 995, 1007`
- `src/desktop/agent/DesktopAgentBootstrap.ts:142, 339-365, 400-438, 429, 445, 506, 515`
- `src/server/agent/ServerAgentBootstrap.ts` (post Q7 rename: channel-connector accessor was renamed; verify current line numbers)
- `src/server/channel-connectors/connector-registry.ts:29` (the renamed OpenClaw `ConnectorRegistry`)

Claudy source paths cross-referenced (read 2026-05-14):
- `claudy/utils/plugins/schemas.ts:17-169, 274-320, 348-373, 543-572, 632-654, 884-898, 1062-1161, 1254-1326, 1592-1629`
- `claudy/utils/plugins/pluginLoader.ts:139-162, 1348-1770, 1888-2090, 2191-2410, 3009-3064, 3096-3211`
- `claudy/utils/plugins/loadPluginHooks.ts:91-157, 138-148, 179-207, 255-287`
- `claudy/utils/plugins/loadPluginAgents.ts:65-229, 113-123, 153-168, 231-344`
- `claudy/utils/plugins/loadPluginCommands.ts:414-942`
- `claudy/utils/plugins/marketplaceManager.ts:102-192, 1782-1924, 2122-2178`
- `claudy/utils/plugins/refresh.ts:72-191`
- `claudy/utils/plugins/cacheUtils.ts:24, 44-50, 74-116`
- `claudy/utils/plugins/pluginAutoupdate.ts:84-102, 161-200, 227-284`
- `claudy/utils/plugins/pluginPolicy.ts:1-21`
- `claudy/utils/plugins/pluginBlocklist.ts:1-128`
- `claudy/services/plugins/PluginInstallationManager.ts:1-186`
- `claudy/services/plugins/pluginOperations.ts:321-572`
- `claudy/utils/plugins/pluginInstallationHelpers.ts:348-466`
- `claudy/plugins/builtinPlugins.ts:1-160`
- `claudy/types/plugin.ts:18-70, 86-289, 295-362`
- `claudy/commands/plugin/parseArgs.ts:17-103`
- `claudy/commands/plugin/PluginTrustWarning.tsx:6-31`
- `claudy/commands/reload-plugins/reload-plugins.ts:1-63`
- `claudy/utils/attachments.ts:2607-2635`

No remaining collisions — the prior `src/server/plugins/PluginRegistry` has been resolved by the Q7 rename (now `src/server/channel-connectors/connector-registry.ts:ConnectorRegistry`). `'plugin'` literal in `CommandLoadedFrom` and `SOURCE_PRECEDENCE` confirmed pre-reserved by Track 03. `/plugin` slash command name unused.
