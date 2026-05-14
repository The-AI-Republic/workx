# Track 10: Plugin System — Tasks

> Phased delivery. Each phase = one PR. Mirrors `design.md` section order. If review
> feedback demands, Phase 1 may further split into "10a-registries" (extending existing
> registries with `pluginId` + `removeByPluginId`) and "10a-loader" (manifest + plugin
> loader on top).

## Phase 1 — Foundation (PR 10a)

### Manifest schema
- [ ] Add `src/core/plugins/PluginManifest.ts` with Zod schema mirroring claudy's `PluginManifestSchema` for the v1 slots: `name`, `version`, `description`, `author`, `skills`, `hooks`, `mcpServers`, `agents`, `settings`, `userConfig`. Accept (and silently ignore) unrecognized top-level slots so claudy plugins with `commands`/`outputStyles`/`lspServers` still load.
- [ ] Add `src/core/plugins/types.ts` with `LoadedPlugin`, `PluginSource`, and the BrowserX-specific `browserx.domains` / `browserx.platforms` extensions.
- [ ] Add `src/core/plugins/PluginErrors.ts` — discriminated union mirroring `claudy/types/plugin.ts:79` (generic-error, plugin-not-found, manifest-parse-error, manifest-validation-error, component-load-failed, …).

### Registry extensions
- [ ] Extend `Skill` in `src/core/skills/types.ts` with optional `pluginId: string`. Update Zod schema. Update `SkillProvider` interface to round-trip the field.
- [ ] Add `SkillRegistry.removeByPluginId(pluginId: string): Promise<void>` in `src/core/skills/SkillRegistry.ts`. Iterate registered skills, delete those matching, emit `changed`.
- [ ] Extend `HookSource` in `src/core/hooks/types.ts` with `{ type: 'plugin'; pluginId: string }` variant. Existing `HookRegistry.unregisterBySource()` covers removal — no further change needed.
- [ ] Extend `IMCPServerConfig` in `src/core/mcp/types.ts` with optional `pluginId`. Add `MCPManager.removeByPluginId(pluginId)` in `src/core/mcp/MCPManager.ts` — must `disconnect()` before `connections.delete()`.
- [ ] Refactor `src/tools/AgentTool/register.ts` to expose `registerSubAgentTypes(types, source)` and `unregisterTypesByPluginId(pluginId)` as runtime APIs. Keep the existing bootstrap path (`registerSubAgentTool({ subAgentTypes })`) calling through the new API for parity.

### Skill listing reinjection
- [ ] Add `SkillRegistry.onChanged(listener)` subscription primitive (mirrors `HookRegistry`).
- [ ] Wire `PromptLoader` (or whatever assembles the agent's system prompt) to invalidate cached skill listing when `SkillRegistry.changed` fires. Re-emit on next turn. Equivalent to claudy's `resetSentSkillNames()` (`claudy/utils/attachments.ts:2612`).

### Loaders
- [ ] Add `src/core/plugins/loaders/SkillSlotLoader.ts` — walks `<plugin>/skills/` (or each entry of `manifest.skills` if array), parses with `SkillParser`, registers via `SkillRegistry.save({ ..., pluginId })`. Skills from a plugin default to `trusted: false` until the plugin is trusted.
- [ ] Add `src/core/plugins/loaders/HookSlotLoader.ts` — reads inline `manifest.hooks` (or `.hooks.json` referenced from manifest), calls `HookRegistry.registerFromConfig(config, { type: 'plugin', pluginId })`. On platform without shell (extension), mark each registered hook with `unsupportedOnPlatform: true` and the executor skips it.
- [ ] Add `src/core/plugins/loaders/McpSlotLoader.ts` — reads inline `manifest.mcpServers` (or `.mcp.json`), calls `MCPManager.addServer({ ..., pluginId })`. Do not auto-connect; respect plugin trust state.
- [ ] Add `src/core/plugins/loaders/SubAgentSlotLoader.ts` — walks `<plugin>/agents/` directory, parses agent `.md` files (mirroring claudy's `loadAgentsDir`), calls `registerSubAgentTypes(types, { type: 'plugin', pluginId })`.

### Unified loader + registry
- [ ] Add `src/core/plugins/PluginLoader.ts` — reads `plugin.json`, validates with `PluginManifestSchema`, dispatches each slot to its loader, collects per-slot errors, returns `LoadedPlugin` with success/error per slot.
- [ ] Add `src/core/plugins/PluginRegistry.ts` — tracks loaded plugins by id, enable/disable state, persists state via storage adapter. Atomic `enable(id)` runs all four slot loaders; `disable(id)` calls `removeByPluginId` on all four registries. Idempotent.

### Discovery
- [ ] Add `src/core/plugins/BundledPluginRegistry.ts` — port of `claudy/plugins/builtinPlugins.ts`. In-process registration API; bundled plugins always discoverable; user-toggleable.
- [ ] Add discovery roots for each platform:
  - **Desktop**: `~/.browserx/plugins/`, `<cwd>/.browserx/plugins/`, bundled in app resources
  - **Extension**: IDB-backed virtual plugin store (extends `FilesystemSkillProvider` extension shim) + bundled in extension assets
  - **Server**: same as desktop

### UI / commands
- [ ] Register `/plugin list` slash command → show installed plugins, enabled state, source.
- [ ] Register `/plugin enable <id>` / `/plugin disable <id>`.
- [ ] Register `/plugin reload` — clear `PluginRegistry`, re-scan discovery roots, re-enable previously-enabled plugins.
- [ ] Register `/plugin info <id>` — manifest fields + capability summary + source + load errors.

### Tests
- [ ] `PluginManifest` unit tests: valid manifest, missing optional slots, invalid slot value, unknown top-level field (must pass-through), malformed JSON.
- [ ] Per-loader unit tests with mocked target registries.
- [ ] `PluginLoader` integration test: load a fixture plugin with all four slots; verify each target registry receives the contribution with the right `pluginId`.
- [ ] `PluginRegistry` tests: `enable` adds to all four; `disable` removes from all four; redundant enable/disable is idempotent; concurrent enable + disable on same id is serialized.
- [ ] Claudy compatibility fixture: copy a real claudy plugin under `tests/fixtures/claudy-plugins/<name>/`, confirm it loads in BrowserX (for v1 slots) without modification.
- [ ] Skill listing reinjection test: enable plugin → `SkillRegistry.changed` fires → next prompt build includes the new skill names.

## Phase 2 — Distribution (PR 10b)

### Marketplace
- [ ] Add `src/core/plugins/MarketplaceSchema.ts` — Zod schema for `marketplace.json` (list of plugin entries with name, source, sha, version).
- [ ] Add `src/core/plugins/MarketplaceRegistry.ts` — added marketplaces by name, fetch cadence, last-update time.
- [ ] Implement catalogue fetch:
  - **Desktop/Server**: `git clone --depth 1` then read `marketplace.json`. Update via `git fetch && git reset --hard <sha>`.
  - **Extension**: GitHub API call to fetch `marketplace.json` blob + verify via response headers. Limited to github.com hosts.

### Installer
- [ ] Add `src/core/plugins/PluginInstaller.ts` — fetch plugin (git clone or tarball), verify SHA from marketplace entry, write to plugin dir, register with `PluginRegistry`. Reject SHA mismatch.
- [ ] Add `src/core/plugins/PluginCache.ts` — on-disk cache structure (`<cache>/<marketplace>/<plugin>/<sha>/`), integrity verification, eviction policy.

### UI / commands
- [ ] `/plugin marketplace add <url>` — clone marketplace repo, verify `marketplace.json`, register.
- [ ] `/plugin marketplace list` / `/plugin marketplace remove <name>`.
- [ ] `/plugin install <id>@<marketplace>` — fetch, SHA-pin, write to cache, trust prompt, register.
- [ ] `/plugin uninstall <id>` — disable + delete plugin dir + remove from cache.
- [ ] Trust prompt UI: render manifest name/version/author + source URL + commit SHA; require explicit confirmation.

### Tests
- [ ] Marketplace fetch unit tests (mocked git + mocked tarball).
- [ ] Installer integration test: install fixture plugin from a local git repo, confirm it lands in cache + registers with correct SHA.
- [ ] SHA mismatch rejection.
- [ ] Trust prompt: install without confirmation does not enable plugin.
- [ ] Uninstall removes from all four target registries and from cache.

## Phase 3 — Hardening (PR 10c)

### Autoupdate
- [ ] Add `src/core/plugins/PluginAutoupdate.ts` — background SHA check + apply for marketplaces with `autoUpdate: true`. Gated on marketplace trust.
- [ ] Configurable interval (default opt-out for non-official marketplaces, opt-in for official; matches claudy default in `schemas.ts:42`).
- [ ] Manual `/plugin update <id>` and `/plugin update --all`.

### Policy
- [ ] Add `src/core/plugins/PluginPolicy.ts` — admin blocklist + version pin support, read from policy config.
- [ ] Add `src/core/plugins/PluginBlocklist.ts` — bundled blocklist + remote blocklist refresh. Refuse install/load of blocked plugins; log + show user-visible warning.
- [ ] Add `src/core/plugins/OfficialMarketplaceGuards.ts` — port `BLOCKED_OFFICIAL_NAME_PATTERN` + reserved-name + source-org validation from `claudy/utils/plugins/schemas.ts:17-169`. Adapt official-name list for BrowserX (set to empty for v1 — no BrowserX-official marketplaces yet; structure ready for future reservations).

### Trust hardening
- [ ] Per-plugin trust state, persisted via storage adapter.
- [ ] Untrusted-plugin behavior gates:
  - Skills loaded but `trusted: false` → no auto-invocation
  - Hooks loaded but execution disabled
  - MCP servers loaded but `MCPManager` does not auto-connect
  - Sub-agent types loaded but not callable via `Task` tool
- [ ] `/plugin trust <id>` — explicit user action with full-manifest confirmation. On trust, re-enable gated capabilities.

### Options
- [ ] Add `src/core/plugins/PluginOptions.ts` — per-plugin config storage; validate against manifest's `userConfig` schema; expose via API to plugins at registration time.
- [ ] `/plugin options <id>` — interactive options dialog driven by the manifest's `userConfig`.

### UI extensions
- [ ] Trust warning dialog on first install of an untrusted plugin.
- [ ] Impersonation warning if a third-party marketplace claims a reserved name.
- [ ] Update list view to show trust state and update-available marker.

### Tests
- [ ] Policy enforcement: blocked plugin refuses to load (Phase 1 already loads — extend with policy check).
- [ ] Impersonation guard: marketplace with reserved name from non-official source rejected.
- [ ] Trust gating: untrusted plugin's hooks do not fire; skills not auto-invocable; MCP not connected.
- [ ] Autoupdate flow: simulate SHA change in marketplace → autoupdate detects → fetches → applies → re-registers.
- [ ] Options round-trip: set value → restart → value persisted → plugin receives at load.

## Out of v1

- LSP server slot
- Output styles slot (subsystem doesn't exist)
- Commands slot (deferred to Track 03 merge)
- DOM site plugin migration to plugin format (intentional: stays compile-time)
- OpenClaw channel plugin migration (out of scope; keeps own loader)
- Plugin developer mode (live-reload while editing) — Phase 4 candidate
- Cross-platform extension-safe hook type (referenced as open question in design)
