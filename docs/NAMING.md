# Naming & Compatibility Policy

The user-facing desktop/server product is **WorkX** (formerly "Apple Pi").
The browser extension remains **BrowserX**.

This document is the source of truth for *what* carries the WorkX name, what
intentionally still carries the legacy `applepi` / `pi` codename, and *why*.
It is enforced by `src/__tests__/naming-convention.test.ts`.

## Three-tier naming convention

| Tier | Scope | Identifier |
|------|-------|------------|
| 1 | Shared / core internal codename | `applepi` (lowercase) |
| 2 | Extension-specific | `browserx` |
| 3 | Desktop/server **user-facing product name** | `WorkX` |

The Apple trademark exposure lived entirely in **Tier 3**. The rename therefore
changed only the user-facing product surface and left the Tier 1 internal
codename in place.

## Renamed to WorkX (Tier 3 — user-facing)

Window/app title, Tauri `productName`/`mainBinaryName`, desktop agent prompt
identity, long/short descriptions, locale display strings, README/docs headline
branding, tray menu, notification fallback title, and systemd job descriptions.

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
