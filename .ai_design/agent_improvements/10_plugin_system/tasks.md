# Track 10: Plugin System — Tasks

> Phased delivery: **10a-1 (registry refactor) → 10a-2 (manifest + loader + UI) → 10b (distribution) → 10c (hardening)**. Each phase = one PR.
>
> All 10 design decisions resolved — see `design.md § Resolved Design Decisions` for rationale.
>
> Line numbers verified against `agent-improvements@801c9248` (2026-05-14, post-Q7-rename).

## Resolved Decisions

All 10 design decisions confirmed 2026-05-14 — see `design.md § Resolved Design Decisions` for full rationale.

| # | Decision |
|---|---|
| Q1 | Mirror claudy (enable = trust) |
| Q2 | Widen `HookSource` to discriminated union with `pluginId` |
| Q3 | Runtime sub-agent registration API + `ToolRegistry.replace()` |
| Q4 | Add `pluginId?: string` field to `Skill` |
| Q5 | `StorageProvider` layer (new `IPluginProvider`) |
| Q6 | Natural re-render — no skill-change bus |
| Q7 | **Landed via PR #217** — `src/server/plugins/` → `src/server/channel-connectors/`, class `PluginRegistry` → `ConnectorRegistry`. Track 10 takes the freed `PluginRegistry` name. |
| Q8 | Raise `MAX_SERVERS` from 5 to 100 globally (no per-source exemption) |
| Q9 | Atomic clear-then-register inside `HookSlotLoader` |
| Q10 | Load + skip at executor (extension command hooks) |

**Precondition (satisfied):** the Q7 rename has landed — the prior `src/server/plugins/PluginRegistry` was renamed and moved to `src/server/channel-connectors/connector-registry.ts:ConnectorRegistry`. The unqualified `PluginRegistry` name is now free for Track 10 to use under `src/core/plugins/`.

## Phase 10a-1 — Registry refactor (PR 10a-1)

**Goal:** every existing registry grows `pluginId` + scoped-removal capability. No plugin manifest code yet. Each registry change is independently reviewable; the PR is a wide-but-shallow shape change.

### SkillRegistry (`src/core/skills/`)

- [ ] **types.ts**: add `pluginId?: string` to `Skill` (line 32-60); to `SkillMeta` (line 67-81); to `skillSchema` Zod (line 169-194); to `skillFrontmatterSchema` (line 144-167) so manifest-driven plugin skills can carry it on disk.
- [ ] **SkillRegistry.ts**: add `removeByPluginId(pluginId: string): Promise<void>` — iterate `this.metas`, delete via `provider.delete()`, filter `metas`.
- [ ] **SkillRegistry.ts:7**: add `'plugin'` to reserved-names list (prevents skills shadowing `/plugin` command).
- [ ] **SkillProvider.ts**: no interface change — `save(skill)` round-trips `pluginId` since it's part of `Skill`.
- [ ] **FilesystemSkillProvider.ts** (`src/desktop/storage/`): verify Zod round-trip preserves `pluginId` in `.skill-meta.json` sidecar.
- [ ] **IndexedDBSkillProvider.ts** (`src/extension/storage/`): verify `pluginId` round-trips through `StorageProvider.save/list`.
- [ ] **NodeSkillProvider** (`src/server/...`): same verification.

### HookRegistry (`src/core/hooks/`)

- [ ] **types.ts:88**: widen `HookSource` to `'config' | 'session' | { type: 'plugin'; pluginId: string }` (Q2).
- [ ] **HookRegistry.ts:36** (`register`): accept widened union; equality comparisons use a helper `isSameSource(a, b)`.
- [ ] **HookRegistry.ts:60** (`registerFromConfig`): accept widened union.
- [ ] **HookRegistry.ts:96** (`unregisterBySource`): match on deep equality for plugin variant.
- [ ] **HookRegistry.ts** (`RegisteredHook.source` field): type updated to widened union.
- [ ] Test: register hooks with `{ type: 'plugin', pluginId: 'a' }`, register with `pluginId: 'b'`, `unregisterBySource({ type: 'plugin', pluginId: 'a' })` removes only `a`-tagged.

### ToolRegistry (`src/core/`)

- [ ] **ToolRegistry**: add `replace(name: string, def: ToolDefinition): void` — overwrite if present, else register. Needed for Q3 sub-agent tool-def rebuild.

### MCPManager (`src/core/mcp/`)

- [ ] **types.ts:38-83**: add `pluginId?: string` to `IMCPServerConfig`.
- [ ] **MCPManager.ts:34** (Q8): raise `MAX_SERVERS` constant from `5` to `100`. No per-source branching needed.
- [ ] **MCPManager.ts:128** (`addServer`): persist `pluginId` through. Existing cap check stays — just hits the new higher ceiling.
- [ ] **MCPManager.ts**: add `removeByPluginId(pluginId: string): Promise<void>` — loop `removeServer()` for matching configs.
- [ ] **MCPConfig.ts**: add `pluginId` to create/update DTOs (`src/core/mcp/MCPConfig.ts` or wherever DTOs live; verify path).
- [ ] Test: `addServer({ pluginId: 'p1', ...})` succeeds with pluginId persisted; `removeByPluginId('p1')` disconnects + drops + emits `config-removed`; cap at 100 still enforced.

### SubAgentRunner (`src/tools/AgentTool/`)

- [ ] **SubAgentRunner.ts**: replace private read-only `customTypes` (line 31) with mutable `Map<string, SubAgentTypeConfig>` + `Map<pluginId, Set<typeId>>` index.
- [ ] **SubAgentRunner.ts**: add `addType(config: SubAgentTypeConfig, source: { type: 'plugin'; pluginId: string } | { type: 'config' })`. Validate via existing `validateSubAgentTypeConfig` (`register.ts:148-172`). Calls `scheduleRebuild()`.
- [ ] **SubAgentRunner.ts**: add `removeByPluginId(pluginId: string)`. Calls `scheduleRebuild()`.
- [ ] **SubAgentRunner.ts**: add `scheduleRebuild()` — **defers rebuild until next turn boundary** when an active task exists. Subscribes to `TaskCompleted` hook in constructor to flush pending rebuild. Direct rebuild only when no active task. Avoids LLM seeing mid-turn schema change. See design § Active-Session Semantics Rule 2.
- [ ] **SubAgentRunner.ts**: add private `rebuildSubAgentTool()` — constructs new `sub_agent` tool def from `Array.from(types.values())`, calls `toolRegistry.replace('sub_agent', def)`.
- [ ] **register.ts:29-117** (`registerSubAgentTool`): refactor to call `runner.addType(t, { type: 'config' })` for each merged type instead of constructing the tool def directly. Bootstrap behavior preserved.
- [ ] Test: bootstrap path produces identical merged-type set as before; concurrent `addType` + `removeByPluginId` is serialized; **pending rebuild fires on next `TaskCompleted`, not immediately when active task exists**; `ToolRegistry.replace` semantics.

### CommandLoader (`src/core/commands/`)

- [ ] **CommandLoader.ts:14-17**: extend `CommandLoaderDeps` with `plugin?: PluginCommandLoader`.
- [ ] **CommandLoader.ts:22-27** (`loadAll`): push `await this.deps.plugin.load()` when `plugin` dep present.
- [ ] **No `types.ts` changes** — `'plugin'` literal already in `CommandLoadedFrom` (`types.ts:17`) and `SOURCE_PRECEDENCE` (`precedence.ts:12`).
- [ ] **loaders/PluginCommandLoader.ts** (NEW): `add(pluginId, commands)`, `removeByPluginId(pluginId)`, `load(): Promise<Command[]>`. Implementation in design doc § Loader-by-slot Wiring.
- [ ] Test: precedence still `builtin > skill > plugin`; `removeByPluginId` doesn't touch other plugins' commands; `isEnabled: () => pluginRegistry.isEnabled(id)` filter works through `dedupeByName`.

### Cross-cutting

- [ ] Update tests touching `HookSource` strings — at minimum `src/core/hooks/__tests__/*` and `src/core/hooks/loaders/__tests__/*`.
- [ ] No `STORE_KEY_PATHS` / `IndexedDBAdapter` / `NodeSQLiteAdapter` / `db_storage.rs` changes in this phase (Q5 picks `StorageProvider` layer).
- [ ] No DB_VERSION bump.

## Phase 10a-2 — Manifest + loader + `/plugin` UI (PR 10a-2)

**Goal:** add the plugin manifest, unified loader, per-slot loaders, `PluginRegistry`, platform adapters, and `/plugin` slash command. Local plugins only — no marketplace.

### Type model + manifest

- [ ] **src/core/plugins/types.ts** (NEW): `PluginId`, `PluginScope`, `PluginPlatform`, `PluginAuthor`, `PluginManifest`, `CommandMetadata`, `PluginUserConfigOption`, `PluginSource`, `LoadedPlugin`, `PluginSlot`, `PluginLoadResult`. Shape per design doc § Type Model.
- [ ] **src/core/plugins/PluginManifest.ts** (NEW): Zod schema. Build via partial sub-schemas (mirror claudy `schemas.ts:884` pattern). Top-level `unknownKeys('passthrough')` so claudy plugins with `outputStyles`/`lspServers`/`channels` still load (those slots are silently ignored). `name` kebab-case regex `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`.
- [ ] **src/core/plugins/PluginErrors.ts** (NEW): start with 6 variants — `generic-error`, `plugin-not-found`, `path-not-found`, `manifest-parse-error`, `manifest-validation-error`, `component-load-failed`. Add `marketplace-blocked-by-policy` in 10c.

### IPluginProvider + platform adapters (Q5)

- [ ] **src/core/plugins/PluginProvider.ts** (NEW): `IPluginProvider` interface — `initialize()`, `listMeta()`, `load(id)`, `exists(id)`, `remove(id)`, `writeFiles(id, files)`, `getRoot(id)`.
- [ ] **src/desktop/storage/FilesystemPluginProvider.ts** (NEW): writes to `~/.airepublic-pi/plugins/<id>/`. Mirrors `FilesystemSkillProvider`. Tauri commands: `plugins_ensure_dir`, `plugins_list_dirs`, `plugins_read_file`, `plugins_write_file`, `plugins_remove_dir`.
- [ ] **src/extension/storage/IndexedDBPluginProvider.ts** (NEW): uses `StorageProvider.list('plugins')`. New collection in the `StorageProvider` layer.
- [ ] **src/server/storage/NodePluginProvider.ts** (NEW): writes to `<workspace>/.browserx/plugins/<id>/`.
- [ ] **tauri/src/lib.rs**: register new Tauri commands.
- [ ] **tauri/src/db_storage.rs**: NO change (Q5 — `StorageProvider`-level, not `StorageAdapter`-level).

### Per-slot loaders

- [ ] **src/core/plugins/loaders/SkillSlotLoader.ts** (NEW): walks `<plugin>/skills/` for SKILL.md files (single-skill mode: probe `<path>/SKILL.md` first; else scan subdirs). Reuse existing `SkillParser`. **Skill name is namespaced as `<pluginName>:<bareName>`** before `skillRegistry.save({ ..., pluginId, name: 'pluginName:bareName' })`. Plugin skills are invocable only by qualified name in v1. Default `trusted: true` (Q1). **Body content runs through `substitutePluginVariables` → `substituteUserConfigInContent`** (sensitive values resolve to placeholder per design § User Config Substitution).
- [ ] **src/core/plugins/loaders/HookSlotLoader.ts** (NEW): reads inline `manifest.hooks` or referenced `.hooks.json`. **Atomic clear-then-register** (Q9):
  ```ts
  // HookSlotLoader.load(plugin) — full swap for a single plugin
  hookRegistry.unregisterBySource({ type: 'plugin', pluginId });
  hookRegistry.registerFromConfig(hooksConfig, { type: 'plugin', pluginId });
  ```
- [ ] **src/core/plugins/loaders/HookSlotLoader.ts** — add **`pruneRemovedPlugins(enabledPluginIds: Set<PluginId>)`** sibling method (mirror claudy `pruneRemovedPluginHooks`, gh-36995 fix). Removal-only: walks registered hooks, drops any whose `source.pluginId` is not in the set. Called from `PluginRegistry.reload` step (7) and from any future "settings changed externally" sweep. **Does NOT add hooks from newly-enabled plugins** — those wait for explicit reload signal.
- [ ] **src/core/plugins/loaders/McpSlotLoader.ts** (NEW): reads inline `manifest.mcpServers` or `.mcp.json`. **Substitution order**: `substitutePluginVariables` → `substituteUserConfigVariables` (strict) on `env`/`command`/`args`. Calls `mcpManager.addServer({ ..., pluginId })` per entry. Auto-connect honored. **Duplicate server key handling:** if another server (any source) already exists with the same key, emit `mcp-server-suppressed-duplicate` error in `LoadedPlugin.errors` and skip that one entry; rest of the plugin still loads.
- [ ] **src/core/plugins/loaders/SubAgentSlotLoader.ts** (NEW): walks `<plugin>/agents/` for `.md` files. Parses frontmatter. **Drops sensitive fields** (`permissionMode`, `hooks`, `mcpServers`) with warning (claudy `loadPluginAgents.ts:153-168`). Calls `subAgentRunner.addType(config, { type: 'plugin', pluginId })`. Type id namespace: `<pluginName>:<typeName>`. **Body content runs through `substitutePluginVariables` → `substituteUserConfigInContent`** (sensitive resolves to placeholder).
- [ ] **src/core/plugins/loaders/CommandSlotLoader.ts** (NEW): walks `<plugin>/commands/` for `.md` files. Reuses Track 03 parser. **Command name namespaced as `<pluginName>:<bareName>`** (between-plugins collision resolution). Stamps `loadedFrom: 'plugin'` (so cross-source dedup via `SOURCE_PRECEDENCE` lets builtin/skill shadow plugin). Calls `pluginCommandLoader.add(pluginId, commands)`. On unload: `pluginCommandLoader.removeByPluginId(pluginId)`. **Body content runs through `substitutePluginVariables` → `substituteUserConfigInContent`**.

### Carried from 10a-1 review (PR #222)

Two latent gaps were left in the 10a-1 foundation because no call path exercises them until the loaders below are wired. Both are **acceptance criteria for the SubAgentSlotLoader wiring**, not optional cleanup.

- [ ] **`SubAgentRunner.addType` — guard the non-plugin source branch.** `addType` (`src/tools/AgentTool/SubAgentRunner.ts`) only enforces the id-collision guard for `source.type === 'plugin'`. The `else` branch (config/builtin source) does a bare `this.types.set(id, config)` with no `pluginTypeOwner` check. If 10a-2 ever calls `addType` with a non-plugin source whose id collides with a plugin-owned type, it silently overwrites the plugin's type while `pluginTypeOwner` still points at the plugin — a later `removeByPluginId` then deletes the wrong (now non-plugin) type. Mirror of the plugin-side guard already in place. Acceptance: a config/builtin `addType` colliding with a plugin-owned id either throws or is explicitly defined; regression test added alongside the existing collision tests in `SubAgentRunner.pluginTypes.test.ts`.
- [ ] **`ToolRegistry.replace` — make the sub-agent tool swap gap-free.** `replace()` (`src/tools/ToolRegistry.ts`) deletes the old entry, emits `ToolUnregistered`, then `await`s `register()` — a window where `sub_agent` is absent from the registry (a concurrent `discover()`/dispatch misses it). 10a-1 only fixed the misleading JSDoc; the real fix lands here because the consumer (the `setTypesChangedCallback` → `rebuildSubAgentTool` → `replace` path) is wired in 10a-2. Acceptance: either build-then-atomic-swap in `replace`, or serialize the rebuild against tool discovery; coordinate with the active-task-guard NOTE already in `addType` (defer rebuild until TaskCompleted per design § Active-Session Semantics Rule 2). Test: concurrent discover during a rebuild always sees exactly one `sub_agent` definition.

### User-config substitution module

- [ ] **src/core/plugins/userConfigSubstitution.ts** (NEW): three functions per design § User Config Substitution.
  - `substitutePluginVariables(value, plugin)` — substitutes `${CLAUDE_PLUGIN_ROOT}` + `${CLAUDE_PLUGIN_DATA}`. Function-form `.replace((m,k)=>v)` to avoid `$$`/`$'` reinterpretation. Single-pass, non-recursive. Windows-normalizes backslashes.
  - `substituteUserConfigVariables(value, userConfig)` — strict variant, **throws on missing keys**. Used by MCP env, hook commands.
  - `substituteUserConfigInContent(content, options, schema)` — content-safe variant. Sensitive resolves to literal string `[sensitive option 'KEY' not available in skill content]` (verbatim from claudy — plugins authored for claudy expect this fingerprint). Unknown keys stay literal.
- [ ] **src/core/plugins/pluginOptionsStorage.ts** (NEW): `loadPluginOptions(pluginId)` — memoized. Reads non-sensitive from `settings.pluginConfigs[pluginId].options`; reads sensitive from `credentialStore.read().pluginSecrets[pluginId]`. Merges with credential store winning on key collision.
- [ ] **Hook executor extension**: when invoking plugin-sourced hook commands, inject `CLAUDE_PLUGIN_OPTION_<KEY>` env vars. Sanitize key as `key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()`. Sensitive values **INCLUDED** in env (same trust boundary as hooks reading credential store directly).
- [ ] Test: substitution non-recursive (value containing `${nested}` after substitution stays literal); strict throws on missing key; content-safe returns placeholder for sensitive; env var key sanitization matches regex.

### Loader + Registry

- [ ] **src/core/plugins/PluginLoader.ts** (NEW): `loadFromDir(dir): Promise<LoadedPlugin>` — reads `plugin.json`, validates with `PluginManifestSchema`, falls back to `{name: dirname}` if manifest missing. Auto-detects `skills/`, `agents/`, `commands/` dirs when manifest doesn't declare them. Resolution is **not done here** — substitution happens per-slot at load time (design § User Config Substitution).
- [ ] **src/core/plugins/PluginRegistry.ts** (NEW): per design § PluginRegistry Algorithm. Track 04 `tails` Map for per-key serialization (`src/core/tasks/TaskOutputStore.ts:55, 213-248`). Track 04 `evicted` Set for post-uninstall block. Atomic 5-slot enable with rollback. **Rollback failure policy:** log to `plugin.loadErrors` + leave inconsistent state + DON'T re-throw — surface original error. **PluginState discriminated union** for `LoadedPlugin.state` (mirrors `TaskStateBase` pattern in `src/core/tasks/types.ts:53-73`): `disabled | enabling | enabled | disabling | error`.
- [ ] **src/core/plugins/PluginRegistry.ts** — `bootstrapEnabledPlugins()`: read `agentConfig.getConfig().enabledPlugins`, list manifests, filter by enabled, **sort lexicographically** for deterministic debugging, enable **sequentially** (not parallel — MCP events would race, hook clear-then-register is non-reentrant per plugin). Failures collected in result; partial bootstrap is contract.
- [ ] **src/core/plugins/PluginRegistry.ts** — `reload()`: implement the 7-step flow per design § Active-Session Semantics "/plugin reload precise flow":
  1. Active-task guard (refuse if `session.listActiveTasks()` has any `background_agent`)
  2. Drain `tails` serialization locks
  3. Snapshot `previouslyEnabled`
  4. Sequential disable, error-tolerant
  5. Re-scan via `provider.listMeta()`
  6. Re-enable `previouslyEnabled`
  7. `hookSlot.pruneRemovedPlugins(currentIds)` for any manifests that disappeared
- [ ] **src/core/plugins/PluginRegistry.ts** — `agentConfig` change subscription: in constructor, subscribe to `agentConfig.on('config-changed', ...)` and call `reconcileFromConfig()` when `e.section === 'enabledPlugins'`. Diffs current `state.status === 'enabled'` against the new `enabledPlugins` map and emits enable/disable calls. Handles admin policy push / external settings UI / file-watcher updates.
- [ ] **src/core/plugins/BundledPluginRegistry.ts** (NEW): module-scoped `Map<PluginId, BundledPluginDefinition>`. `registerBundledPlugin(def)` + `getBundledPlugins()`. Sentinel marketplace `'bundled'`; ID `<name>@bundled`. Path = `'bundled'` literal. Read `enabledPlugins[id]` for toggle state; default from `defaultEnabled`. `isAvailable(): () => boolean` per-platform self-disable.
- [ ] **src/desktop/agent/initBundledPlugins.ts** + **src/extension/agent/initBundledPlugins.ts** + **src/server/agent/initBundledPlugins.ts** (NEW): platform-specific bundled plugin init. Empty bodies for v1; structure ready for future bundled plugins. Called from each platform bootstrap **before** `new PluginRegistry(...)`. `PluginRegistry.constructor` logs warning if `getBundledPlugins().length === 0` to catch missed-call.
- [ ] **src/core/plugins/index.ts** (NEW): public exports.

### Config schema extensions

- [ ] **src/config/types.ts**: add `enabledPlugins?: Record<PluginId, boolean>` to both `IAgentConfig` and `IStoredConfig`.
- [ ] **src/config/types.ts**: widen `IConfigChangeEvent.section` literal union to include `'enabledPlugins'`. Without this, `PluginRegistry`'s subscription can't receive notifications.
- [ ] **src/config/AgentConfig.ts**: `extractStoredConfig` (~line 446) and `buildRuntimeConfig` (~line 348) must round-trip `enabledPlugins`. Update both.
- [ ] **src/config/defaults.ts**: `getDefaultAgentConfig()` returns `enabledPlugins: {}`.
- [ ] Future-proof: `extraKnownMarketplaces` and `pluginConfigs` schema slots land in Phase 10b/10c respectively. `policySettings.*` not yet in `IAgentConfig`; Phase 10c precondition to add.

### Bootstrap wiring

- [ ] **src/desktop/agent/DesktopAgentBootstrap.ts**: after `skillRegistry` init (~line 400), instantiate `FilesystemPluginProvider` + `PluginRegistry`. Wire all five slot loaders. Call `bootstrapEnabledPlugins()`. Expose `getPluginRegistry()`.
- [ ] **src/extension/background/service-worker.ts**: after `initializeSkills()` (line 278/975), same pattern with `IndexedDBPluginProvider`. Wire into service registry.
- [ ] **src/server/agent/ServerAgentBootstrap.ts**: same pattern with `NodePluginProvider`. The Q7 rename already renamed the channel-connector accessor; Track 10 adds a new, separate `pluginRegistry` field for the user-plugin system. Verify current accessor names in the bootstrap file post-rename.

### `/plugin` slash command

- [ ] **src/webfront/commands/builtinCommands.ts**: register `/plugin` (call `unregister` first to be safe; webfront throws on duplicate). Subcommands parsed inside the action.
- [ ] Subcommand handlers (called via service surface):
  - `list` — show installed plugins + enabled state + load errors.
  - `enable <id>` — `pluginRegistry.enable(id)`.
  - `disable <id>` — `pluginRegistry.disable(id)`.
  - `reload` — `pluginRegistry.reload()` (clear + re-scan + re-enable previously enabled).
  - `info <id>` — manifest + capability summary + source + load errors.
- [ ] Service exposed: `plugins.list`, `plugins.enable(id)`, `plugins.disable(id)`, `plugins.reload`, `plugins.info(id)` registered via `registerAllServices`.

### Tests

- [ ] `PluginManifest` unit tests: valid; missing optional slots; invalid value in a slot; **unknown top-level field passes through**; malformed JSON; missing required `name`/`version`.
- [ ] Per-loader unit tests with mocked target registries.
- [ ] `PluginLoader` integration: load a fixture plugin with all five slots; verify each target registry receives the contribution with the right `pluginId`.
- [ ] `PluginRegistry` lifecycle: `enable` populates all five; `disable` removes from all five; redundant enable/disable idempotent; concurrent enable + disable on same id serialized; **enable failure mid-slot rolls back completed slots**.
- [ ] `PluginCommandLoader`: `add` populates load output; `removeByPluginId` clears only that plugin's entries; precedence `builtin > skill > plugin` verified.
- [ ] Claudy compatibility fixture: copy a real claudy plugin under `tests/fixtures/claudy-plugins/<name>/`; confirm loads in BrowserX (for v1 slots) without modification.
- [ ] `/plugin` slash command: list, info, enable, disable, reload — happy path + unknown id + malformed args.
- [ ] Bootstrap path: enabled plugins from `settings.enabledPlugins` are auto-enabled at startup; failures don't break bootstrap.
- [ ] **Namespacing**: skills registered as `<pluginName>:<bareName>`; bare-name invocation misses; qualified-name invocation hits. Two plugins shipping the same bare-name skill produce two distinct namespaced skills.
- [ ] **Reserved skill names**: plugin attempting to register a bare skill named `'new' | 'help' | 'settings' | 'plugin'` fails registration with a clear error (the namespaced form like `myplugin:plugin` is fine).
- [ ] **MCP duplicate suppression**: plugin contributes an MCP server with a key that already exists; `mcp-server-suppressed-duplicate` lands in `LoadedPlugin.errors`; the conflicting entry is skipped; rest of the plugin's slots load.
- [ ] **Cross-source command precedence**: a plugin command named `help` (qualified as `myplugin:help`) does not shadow the builtin `help`; bare `help` resolves to builtin. SOURCE_PRECEDENCE order verified end-to-end through `CommandLoader.loadAll()`.

## Phase 10b — Distribution (PR 10b)

**Scope:** git-backed marketplace, install/uninstall, SHA pinning, trust prompt banner.

### Marketplace

- [ ] **src/core/plugins/MarketplaceSchema.ts** (NEW): Zod for `marketplace.json` — `name`, `owner: PluginAuthor` (required), `plugins: PluginMarketplaceEntry[]`, `forceRemoveDeletedPlugins?: boolean`, `metadata?`. `PluginMarketplaceEntry` extends `PluginManifest.partial()` + `name` (required), `source: PluginSource`, `category?`, `tags?`, `strict?: boolean` (defaults true).
- [ ] **src/core/plugins/MarketplaceRegistry.ts** (NEW): in-memory tracker of added marketplaces. Backed by `agentConfig.extraKnownMarketplaces` + persistent state file (TBD path per platform).
- [ ] Catalogue fetch:
  - **Desktop / Server**: `git clone --depth 1` via system `git`. Refresh via `git pull`.
  - **Extension**: GitHub Tarball API. github.com only. Verify-by-SHA.
- [ ] Persistent state: `<plugin-root>/known_marketplaces.json` per claudy. Schema mirrors `KnownMarketplaceSchema` (claudy `schemas.ts:1592-1610`).

### Dependency closure resolution

- [ ] **src/core/plugins/dependencyResolver.ts** (NEW): port `resolveDependencyClosure(rootId, lookup, alreadyEnabled, allowedCrossMarketplaces)` from claudy `utils/plugins/dependencyResolver.ts:95-159`. Pure function (no I/O, lookup injected). DFS with cycle-detection stack and visited set. **Post-order output** (deps before dependents). Returns `{ closure: PluginId[] }` or one of `{ error: 'cycle' | 'not-found' | 'cross-marketplace', chain?: PluginId[] }`. Cross-marketplace check runs AFTER `alreadyEnabled` so manually-pre-installed cross-mkt deps don't block.
- [ ] Test: simple linear chain → post-order; diamond pattern → no duplicate visit; cycle detected with full chain reported; cross-marketplace dep with empty allowlist rejected; cross-marketplace dep when alreadyEnabled passes.

### Installer

- [ ] **src/core/plugins/PluginInstaller.ts** (NEW): `install(pluginId@marketplace, scope)` — 9-step flow per design § Marketplace > Installer:
  1. Validate scope
  2. Root policy guard (`isPluginBlockedByPolicy`)
  3. Local-source guard (reject local source without marketplaceInstallLocation)
  4. Compute cross-marketplace allowlist (root marketplace only — no transitive trust)
  5. Resolve dep closure
  6. Re-check every closure member against policy (fail-closed)
  7. **Single atomic settings write** — ONE `agentConfig.update` call with the entire closure spread into `enabledPlugins`. No partial writes possible.
  8. Materialize loop (fire-and-forget per closure member, in post-order): download → SHA-verify → atomic rename into versioned cache path → record in `installed_plugins_v2.json` → `pluginRegistry.register(loaded)`.
  9. `clearAllCaches()` to force re-read.
- [ ] **PluginInstaller** failure recovery: partial materialize is **NOT rolled back**. Settings claims N plugins enabled but only M materialized; next `loadAllPlugins()` returns `plugin-cache-miss` for missing entries; `verifyAndDemote` demotes them session-locally. User reruns `install` → idempotent retry fills the gap.
- [ ] **src/core/plugins/PluginCache.ts** (NEW): on-disk cache `<plugin-root>/cache/<marketplace>/<plugin>/<version>/` with sanitized components (regex `/[^a-zA-Z0-9\-_]/→'-'`). `.orphaned_at` tombstoning (write `Date.now()` as text). Background GC: Pass 1 unlinks stale markers on installed paths; Pass 2 marks-then-deletes cached paths whose age exceeds `BROWSERX_PLUGIN_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1000`.
- [ ] **Uninstall flow** (`src/core/plugins/PluginUninstaller.ts`): 9-step order per design § Marketplace > Uninstall flow.

### Git command specifics (desktop/server)

- [ ] **src/core/plugins/git.ts** (NEW): `gitClone(url, targetPath, ref?, sparsePaths?)` with the exact arg list from design § Git command specifics. SSH options: `BatchMode=yes + StrictHostKeyChecking=yes` (not `accept-new`). Env: `GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=''`. `stdin: 'ignore'`. **Do NOT disable credential helpers by default** — user's `gh auth` / keychain / `git-credential-store` work natively.
- [ ] **src/core/plugins/git.ts**: `gitPull(cwd, ref?, options)` — with-ref does `fetch + checkout + pull`; without-ref does `pull origin HEAD`. `options.disableCredentialHelper` prepends `-c credential.helper=`.
- [ ] **src/core/plugins/git.ts**: `gitSubmoduleUpdate(cwd, options)` — stat `.gitmodules` first; skip if absent (saves ~35ms). Otherwise `git submodule update --init --recursive --depth 1` with the same SSH options. Non-fatal on failure.
- [ ] **src/core/plugins/git.ts**: stderr → user-friendly-hint table — port the pattern-match table from claudy `marketplaceManager.ts:649-770+`. Timeout default 120s; override via `BROWSERX_PLUGIN_GIT_TIMEOUT_MS`. Redact credentials in error messages.

### Trust warning banner

- [ ] **src/webfront/components/PluginTrustWarning.svelte** (NEW): static banner shown on Browse / Install screens. Reads `policySettings.pluginTrustMessage` for org-customizable suffix.

### Slash command additions

- [ ] `/plugin install <id>@<marketplace>` → `PluginInstaller.install`.
- [ ] `/plugin uninstall <id>` → `pluginOperations.uninstall`.
- [ ] `/plugin marketplace add <url>`, `list`, `remove <name>`.

### Extension tarball install (SHA verification)

- [ ] **src/extension/storage/IndexedDBPluginProvider.ts**: implement `fetchPluginTarballExtension(entry)` per design § SHA verification. Restrict to `entry.source.type === 'github'` with `source.sha` present. Fetch `https://api.github.com/repos/{owner}/{repo}/tarball/{sha}`. URL-pinning IS the SHA verification — no content-hash needed.
- [ ] Error UX: when extension marketplace install fails because of non-github source, surface clear message: "This plugin requires git-based source resolution. Use desktop or server runtime."
- [ ] Tarball unpacking: use `pako` (gzip) + a tar reader in the extension; for desktop/server use Node's tar module.

### `installed_plugins_v2.json` schema

- [ ] **src/core/plugins/types.ts**: add `InstalledPluginScope`, `InstalledPluginEntry`, `InstalledPluginsFileV2` types per design § installed_plugins_v2.json schema.
- [ ] **src/core/plugins/installedPluginsSchema.ts** (NEW): Zod schema matching the TS types. `version: z.literal(2)`.
- [ ] **src/core/plugins/installedPluginsStore.ts** (NEW): `readInstalledPluginsV2()` + `writeInstalledPluginsV2(file)` with atomic write pattern (write `.tmp`, fsync, rename). On read failure: log warning, return `{ version: 2, plugins: {} }`. Per-platform path resolution.
- [ ] Test: round-trip; corrupt file falls back to empty; concurrent writes serialize via lockfile (desktop/server) or transaction (extension).

### Uninstall + active-task guard

- [ ] **PluginUninstaller**: add active-task pre-check per design § Uninstall + active-task guard. Refuse uninstall if `session.listActiveTasks()` has any `background_agent` whose `subAgentTypeId.startsWith(pluginName + ':')`. Surface descriptive error.
- [ ] Test: uninstall blocked when matching active task; uninstall proceeds when active task uses a different plugin's type; uninstall proceeds when no active tasks.

### Tests

- [ ] Marketplace fetch (mocked git + mocked tarball).
- [ ] Installer integration: install fixture plugin from local git repo; verify cache landing + `PluginRegistry.enable` + SHA match.
- [ ] SHA mismatch rejection (tampered tarball → refused).
- [ ] Uninstall removes from all five registries + settings + cache + options.
- [ ] Extension tarball mode: github-only restriction enforced.
- [ ] Dep closure: install A depends on B; B also installed and enabled.

## Phase 10c — Hardening (PR 10c)

**Scope:** autoupdate, blocklist, policy, impersonation guards, options dialog. All sections below have implementation-ready specs in design § Hardening.

### policySettings — schema and storage

- [ ] **src/core/plugins/types.ts**: add `PolicySettings`, `MarketplaceSource` types per design § policySettings.
- [ ] **src/core/plugins/policySettingsSchema.ts** (NEW): Zod schema. `strictKnownMarketplaces` can be `null`, `MarketplaceSource[]`, or undefined.
- [ ] **src/core/plugins/policyLoader.ts** (NEW): `getPolicySettings(): PolicySettings`. Per-platform read:
  - **Desktop (Linux/Mac)**: `/etc/browserx/policy.json` via `fs.readFile`.
  - **Desktop (Windows)**: `%ProgramData%\BrowserX\policy.json`.
  - **Server**: `<workspace>/.browserx/policy.json`.
  - **Extension**: `chrome.storage.managed.get('policy')`.
- [ ] In-memory cache + change signal: extension subscribes to `chrome.storage.onChanged`; desktop/server v1 = no refresh (restart applies). Falls back to `{}` on read failure with logged warning.
- [ ] Test: each platform reads from correct path; null allowlist behaves differently from empty array; corrupt JSON falls back to empty.

### Policy enforcement — `PluginPolicy.ts`

- [ ] **src/core/plugins/PluginPolicy.ts** (NEW): `isPluginBlockedByPolicy(id): boolean` and `isPluginPolicyForceEnabled(id): boolean` per design § Policy enforcement. Single functions, leaf module.
- [ ] Wire enforcement into 4 points: `PluginRegistry.enable`, `PluginInstaller.install` (root + closure), `MarketplaceRegistry.add`, `PluginRegistry.bootstrapEnabledPlugins`.
- [ ] Test: each enforcement point refuses appropriately; `=== true` force-enable wins over user-disabled.

### Marketplace source guards — `marketplaceHelpers.ts`

- [ ] **src/core/plugins/marketplaceHelpers.ts** (NEW): `isSourceAllowedByPolicy(source)`, `isSourceInBlocklist(source)`, `matches(source, pattern)` per design § Marketplace source guards.
- [ ] Glob matching via `minimatch` (already a dep) for `host`/`path` patterns; exact match for `github` repo.
- [ ] Test: exact match, wildcard, blocklist-trumps-allowlist, empty allowlist = deny-all, null allowlist = no restriction.

### Impersonation guards — `MarketplaceGuards.ts`

- [ ] **src/core/plugins/MarketplaceGuards.ts** (NEW): `isBlockedOfficialName(name)`, `validateOfficialNameSource(name, source)` per design § Impersonation guards. `ALLOWED_OFFICIAL_MARKETPLACE_NAMES = []` for v1; `BLOCKED_OFFICIAL_NAME_PATTERN` and `OFFICIAL_GITHUB_ORG = 'browserx'`.
- [ ] Call site: `MarketplaceRegistry.add(...)` BEFORE any network operation.
- [ ] Test: homograph guard (non-ASCII name rejected); BrowserX-prefixed names rejected unless from `browserx/` org; allowed-list bypass works.

### Delisting / blocklist — `PluginBlocklist.ts`

- [ ] **src/core/plugins/PluginBlocklist.ts** (NEW): `detectAndUninstallDelistedPlugins(marketplaces, installed)` per design § Blocklist / delisting. Iterates `forceRemoveDeletedPlugins: true` marketplaces, computes `installed − catalogue` set, calls `uninstallSilent(pluginId, scope)` for each (skip `managed` scope).
- [ ] Called from autoupdate flow.
- [ ] Surface user notification: "N plugins were removed because their marketplace delisted them: <list>".
- [ ] Test: marketplace with `forceRemoveDeletedPlugins: true` drops a plugin → auto-uninstalled; same marketplace without the flag → no action.

### Autoupdate — `PluginAutoupdate.ts`

- [ ] **src/core/plugins/PluginAutoupdate.ts** (NEW): `autoUpdatePluginsInBackground()` per design § Autoupdate full mechanics. 5-step flow: refresh autoUpdate marketplaces → diff SHAs → fetch to new versioned cache → mark old orphaned → update `installed_plugins_v2.json` → detect delisted.
- [ ] **Trigger**: one-shot fire-and-forget from each platform bootstrap. NOT a recurring timer. `shouldSkipAutoupdate()` returns true in test environments / CI / `--no-autoupdate` flag.
- [ ] **Gating**: `getAutoUpdateMarketplaces()` reads `known_marketplaces.json[name].autoUpdate`. Default: `true` for `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` (empty list = effectively `false` everywhere for v1); settings can opt-in third parties.
- [ ] **Non-in-place**: writes new version to new cache dir, marks old `.orphaned_at`. User must `/plugin reload` or restart to apply.
- [ ] **User notification**: write to `agentConfig.ephemeral.pendingPluginUpdates` (runtime-only, not persisted). Webfront subscribes and shows banner.
- [ ] Manual `/plugin update <id>` and `/plugin update --all` — same flow, scoped to one or all plugins.
- [ ] Test: simulate SHA change → autoupdate detects → fetches → `installed_plugins_v2.json` updated → orphan marker on old → user notified → `/plugin reload` applies.

### Per-plugin options — `PluginOptions.ts`

- [ ] **src/core/plugins/PluginOptions.ts** (NEW): class with `get(pluginId)`, `set(pluginId, key, value, schema)`, `delete(pluginId)` per design § Per-plugin options. Non-sensitive → `agentConfig.pluginConfigs[id].options`; sensitive → `credentialStore.setPluginSecret`. Validates against `PluginUserConfigOption` schema before persisting.
- [ ] **src/config/types.ts**: extend `IAgentConfig` and `IStoredConfig` with `pluginConfigs?: Record<PluginId, { options: Record<string, unknown> }>`.
- [ ] **src/storage/CredentialStore.ts** (or platform equivalent): add `setPluginSecret(pluginId, key, value)`, `getPluginSecrets(pluginId)`, `deletePluginSecrets(pluginId)`.
- [ ] Test: round-trip non-sensitive; round-trip sensitive (verify NOT in `pluginConfigs`); validation rejects out-of-range numbers + missing required; delete wipes both stores.

### Per-plugin options UX

- [ ] **src/webfront/components/PluginOptionsDialog.svelte** (NEW): modal dialog rendering one input per option in `manifest.userConfig`. Type-specific inputs per design § Per-plugin options UX.
- [ ] Save flow: per changed key, call `PluginOptions.set(...)`. On completion, surface message: "Settings saved. Run `/plugin reload <id>` to apply."
- [ ] Server fallback (no webfront): chat-message-based prompt sequence for `/plugin options <id>`.
- [ ] Test: open dialog for fixture plugin with each option type; set each; verify round-trip through storage; sensitive option shows masked input.

### Trust UI banner

- [ ] **src/webfront/components/PluginTrustWarning.svelte** (NEW): static banner per design § Trust UI banner. Shown on `/plugin install` flow + marketplace browse screens.
- [ ] Reads `getPolicySettings().pluginTrustMessage` for org-customizable suffix.

### UI extensions

- [ ] `/plugin trust <id>` — register as an alias for `/plugin enable <id>` for compat with claudy users. Per Q1, trust = enable.
- [ ] Plugin list view shows `update-available` marker for plugins in `ephemeral.pendingPluginUpdates`.

## User-Facing Surfaces (Phase 10a-2)

These are the contract between the plugin system and the chat UI. Implementation lands in Phase 10a-2; Phase 10b/10c extends the same renderer.

- [ ] **src/webfront/components/PluginCommandOutput.svelte** (NEW): renderer for all `/plugin *` outputs. Output formats specified in design § User-Facing Surfaces.
- [ ] Status glyph convention: `✓` success, `✗` hard failure, `⚠` partial/warning, `○` no-op.
- [ ] `/plugin list` table: name, version, scope, status, error variant (when applicable). Click plugin ID → `/plugin info`.
- [ ] `/plugin info <id>` rendering: header, source line, capabilities breakdown, user config (with sensitive masking), load errors.
- [ ] `/plugin enable/disable/reload` outputs: success counts + "Effective on next message" footer.
- [ ] Refusal outputs (`/plugin reload` with active tasks, `/plugin uninstall` with active sub-agent): list blocking tasks with task IDs.
- [ ] Test: each command output renders against fixture state; error variants render correctly.

## End-to-End Integration Tests

Live under `src/core/plugins/__tests__/e2e/*.test.ts`. Use Vitest with real registries (no mocks) and a temp-dir `FilesystemPluginProvider`.

- [ ] **E2E-1: Local plugin happy path** (Phase 10a-2 gate). See design § E2E Scenarios E2E-1. Acceptance: enable → invoke skill → trigger hook → run sub-agent → disable → verify clean state.
- [ ] **E2E-2: Marketplace install/uninstall** (Phase 10b gate). See E2E-2. Acceptance: local-git marketplace install with SHA verification + uninstall with orphan marker + 7-day-skip GC sweep.
- [ ] **E2E-3: Autoupdate flow** (Phase 10c gate). See E2E-3. Acceptance: SHA diff detected → new version cached → old orphaned → reload applies.
- [ ] **E2E-4: Cross-plugin collision resolution.** See E2E-4. Acceptance: three plugins with same skill name resolve to distinct qualified names; MCP suppression fires; hook isolation works.
- [ ] **E2E-5: Failure modes table** (12 scenarios). See E2E-5. Each row gets one test.
- [ ] **E2E-6: Storage round-trip across platforms.** See E2E-6. Run identical scenario against each of the 3 `IPluginProvider` impls.
- [ ] **E2E-7: Performance smoke** (soft thresholds). See E2E-7. 10 fixture plugins → bootstrap < 2s, reload < 1s, turn-warmup delta < 100ms.

### Tests

- [ ] Policy enforcement: `enabledPlugins[id] === false` → enable refused, install refused.
- [ ] Impersonation guard: marketplace name in `ALLOWED_OFFICIAL_MARKETPLACE_NAMES` from non-allowed source → rejected.
- [ ] Autoupdate flow: simulate SHA change → autoupdate detects → fetches → user notified → `/plugin reload` applies.
- [ ] Options round-trip: set sensitive value → restart → value persisted in credential store → plugin receives at load.
- [ ] Options validation: out-of-range value rejected against `min`/`max`.
- [ ] Delisting: marketplace with `forceRemoveDeletedPlugins: true` drops a plugin → auto-uninstalled.

## Out of v1 (all phases)

- LSP server slot — subsystem doesn't exist.
- Output styles slot — subsystem doesn't exist.
- DOM site addon migration (`src/extension/tools/dom/addons/`, post-PR #218) to plugin format — intentional: stays compile-time.
- OpenClaw channel connector migration (`src/server/channel-connectors/`) — out of scope; keeps own loader.
- Channels-as-plugins migration — separate proposal.
- Plugin developer mode (live-reload while editing) — Phase 4 candidate.
- Extension-native hook type (non-shell hooks for the extension platform) — separate proposal.
- MCPB (`.mcpb`/`.dxt`) bundle support — Phase 4 if BrowserX wants to consume claudy MCPB packages.
- Cross-platform plugin author SDK / dev tooling — separate effort.
