# Naming & Compatibility Policy

The user-facing product is **WorkX** across **all surfaces** — desktop, server,
and the Chrome extension (formerly "Apple Pi" on desktop/server and "BrowserX"
on the extension).

This document is the source of truth for *what* carries the WorkX name, what
intentionally still carries a legacy internal codename (`applepi` / `pi` for
desktop/server, `browserx` for the extension), and *why*. It is enforced by
`src/__tests__/naming-convention.test.ts`.

## Three-tier naming convention

| Tier | Scope | User-facing name | Internal codename (retained) |
|------|-------|------------------|------------------------------|
| 1 | Shared / core | WorkX | `applepi` (lowercase) |
| 2 | Extension-specific | WorkX | `browserx` (lowercase) |
| 3 | Desktop/server product | WorkX | `applepi` / `pi` |

The Apple trademark exposure lived entirely in the desktop/server product name;
the extension was unified to the same **WorkX** brand for consistency. In both
cases only the **user-facing** surface was renamed — the lowercase internal
codenames (`applepi`, `browserx`) are retained as functional/persistence
identifiers.

## Renamed to WorkX (user-facing)

**Desktop/server:** window/app title, Tauri `productName`/`mainBinaryName`,
desktop agent prompt identity, long/short descriptions, locale display strings,
README/docs branding, tray menu, notification fallback title, systemd job
descriptions.

**Extension:** `extension_name` and all locale message **values** (the chat
agent label, context-menu items, welcome strings, etc. — i18n keys and `$_t`
references are unchanged), manifest action `default_title`, the extension agent
prompt identity (`default_browserx_agent_prompt.md`, `browserx_intro.md`), the
shadow-agent prompt identity, raw HTML titles, the on-page cursor automation
label, and keyboard-shortcut descriptions.

## Intentionally retained as `applepi` / `pi` (Tier 1 — legacy/internal)

These are **not** user-facing and are **not** a trademark concern. They are
persistence keys, OS/enterprise contracts, or runtime identity where a rename
would orphan existing user data or break external integrations. They are being
retired **gradually**; until then they are kept verbatim, not aliased.

| Identifier | Location | Why kept |
|-----------|----------|----------|
| `applepi_cache` | `src/storage/IndexedDBAdapter.ts` | IndexedDB name — rename orphans cached data |
| `ApplePiRollouts` | `src/storage/rollout/types.ts` | IndexedDB name — rename orphans rollout history |
| `applepi` credential service | `src/config/AgentConfig.ts`, `ControlFrameCredentialStore.ts` | Keychain service — rename orphans stored API keys |
| `.applepi-server` data dir | `src/server/agent/ServerAgentBootstrap.ts` | Server data dir — rename orphans server state |
| `/Library/Application Support/ApplePi`, `ProgramData\ApplePi` | `ManagedFileSource.ts`, `ManagedDirSource.ts` | Enterprise MDM managed-policy path contract |
| `com.airepublic.pi` | `tauri/tauri.conf.json`, `Info.plist` | Bundle identifier — rename breaks the auto-updater / OS app identity |
| crate `pi`, `default-run = "pi"` | `tauri/Cargo.toml` | Internal Rust crate name |
| `APPLEPI_NODE_BIN` | `tauri/src/runtime_supervisor.rs` | Documented power-user / CI env contract |
| agent types `applepi` / `applepi-server` | `src/prompts/PromptComposer.ts` | Runtime agent identity (connector, MCP server name, prompt fragments) |
| `ApplePiConnectorApi`, platform id `applepi-server` | `src/server/channel-connectors/` | Connector/platform identity surfaced to channel connectors |
| `PiRuntimeBootstrap` | `src/desktop-runtime/PiRuntimeBootstrap.ts` | Internal desktop-runtime class name |
| hotkey events `applepi:*`, attr `data-applepi-injected` | `src/desktop/hotkeys.ts`, DOM addons | Internal event / DOM contract |
| crontab marker `pi-scheduler-*` | `tauri/src/scheduler_commands.rs` | Removal-identity marker for existing crontab entries |

## Intentionally retained as `browserx` (Tier 2 — legacy/internal)

The extension's user-facing brand is now WorkX, but the lowercase `browserx`
codename is retained as functional/persistence identity, for the same reasons
as Tier 1. Renaming these orphans stored data or breaks DOM/event contracts.

| Identifier | Location | Why kept |
|-----------|----------|----------|
| `browserx-credential:` prefix | `src/extension/storage/ChromeCredentialStore.ts` | Extension credential store — rename orphans stored API keys |
| events `browserx:*`, `browserx:visual-effect` | `DomService.ts`, content-script, contracts | Runtime DOM event contract |
| element ids `browserx-visual-effects-host` | content-script | Runtime DOM element contract |
| tab group title `browserx`, session prefix `browserx_s_` | `src/core/TabManager.ts`, `AgentSession.ts` | Rename orphans existing Chrome tab groups |
| agent type `browserx`, event titles `'browserx'` | `PromptComposer.ts`, `Main.svelte` | Runtime agent identity |
| `.browserx` data dir, `/etc/browserx`, `ProgramData\BrowserX` policy | `src/server/agent/ServerAgentBootstrap.ts` | Server data dir / enterprise policy path contract |
| i18n keys (`"Browserx"`, `"Explain_with_Browserx"`, …) | `_locales/*/messages.json` | i18n lookup keys referenced by `$_t(...)`; only **values** were rebranded |
| prompt fragment files `browserx_intro.md`, `default_browserx_agent_prompt.md` | `src/prompts/` | Internal filenames (content rebranded to WorkX) |
| code identifiers `BrowserxExtensionSchema`, manifest key `browserx` | `src/core/plugins/PluginManifest.ts` | Plugin-manifest data contract |
| GitHub repo refs `browserx/*` | plugin tests/fixtures | External repository identifiers |

## Deep links

| Scheme | Status |
|--------|--------|
| `workx://` | **Canonical.** Registered on all platforms and used for newly generated links (e.g. the scheduler). |
| `applepi://` | **Legacy, retained.** Still registered and handled as a fallback so existing links and installs keep working. |

Both schemes are registered in `tauri.conf.json`, `Info.plist`, and the Linux
`.desktop` `MimeType`, and both are accepted by `is_app_deep_link` in
`tauri/src/main.rs`. The internal Rust→WebView event channel
(`applepi-deeplink`) keeps its Tier 1 name.

### Known exception: login callback

The hosted-auth login jump-back still emits **`applepi://auth/callback`**
(`src/config/runtimeUrls.ts`, `src/webfront/stores/userStore.ts`). Migrating it
to `workx://auth/callback` requires the hosted auth provider to allow-list the
new redirect URL first; until then it stays on `applepi://` for backward
compatibility. Tracked as gradual-retirement follow-up.

## Retirement roadmap (future PRs)

1. Allow-list `workx://auth/callback` on the hosted auth provider, then switch
   the login redirect; keep `applepi://auth/callback` as a fallback.
2. Migrate persistence keys (cache DB, rollout DB, keychain service, data dir)
   behind a one-time data migration, keeping old names as read fallbacks.
3. Migrate the bundle identifier only with an updater-continuity plan.
