# Track 20: Managed / Policy Settings Tier

**Priority: P1** · **Effort: M** (full OS-MDM parity: P3/L) · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's settings precedence + remote-managed-settings and browserx's two config systems across all three deploy targets — see "Validation Notes".

## Problem

BrowserX has **no admin-enforced configuration tier**. Two independent config systems, neither with a policy layer:
- `server/config/server-config.ts` — `loadServerConfig()` is **env > config.json > defaults** (`applyEnvOverrides` at `:141` + `ServerConfigSchema.parse`); no policy tier.
- `config/AgentConfig` + `config/defaults.ts` — `mergeWithDefaults()` deep-merges stored config over `default.json`; no admin-enforced source, no locked keys.

For team/fleet deployments (org-locked permissions, enforced allowlists, MDM-managed extension) there is no way for an administrator to set configuration a user/agent cannot override.

## What Claudy Does

Settings come from an ordered source chain merged via `lodash mergeWith` "in priority order with deep merging" (`utils/settings/settings.ts:673`): `policySettings`, `userSettings`, `projectSettings`, `localSettings`, `flagSettings`. **`policySettings` sits at the top and is itself resolved by "first source wins," not merged** (`getSettingsForSourceUncached`, `settings.ts:319-345`):

```
remote managed  →  MDM (HKLM / macOS plist)  →  managed-settings.json (+ .d/)  →  HKCU
```

`getPolicySettingsOrigin()` (`:372-400`) reports which won (`'remote'|'plist'|'hklm'|'file'|'hkcu'`) — used for diagnostics.

`services/remoteManagedSettings/index.ts`: enterprise-only (`isEligibleForRemoteManagedSettings`), `POLLING_INTERVAL_MS=1h`, `SETTINGS_TIMEOUT_MS=10s`, **fail-open** (`:11` "if fetch fails, continues without remote settings"), SHA-256 checksum, **ETag** via `If-None-Match` (`:273-275`), background poll, `securityCheck.jsx` prompts before applying dangerous managed changes, hot-reload via a change detector.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Server config | `server/config/server-config.ts:124-151` `loadServerConfig()` env>file>defaults, `ServerConfigSchema` (zod) | No policy tier; `applyEnvOverrides` `:141` |
| Server hot-reload | `onConfigReload()`/`watchConfig()`/`stopWatchingConfig()` (`:168-201`) | **Existing reload seam** — reuse |
| Agent config | `config/AgentConfig` + `config/defaults.ts:195` `mergeWithDefaults()` | Two layers, no policy/locked keys |
| Extension config store | `ChromeConfigStorage` over `chrome.storage.local` (`extension/storage/ChromeConfigStorage.ts:24`); `manifest.json` has `"storage"` but **no `managed_storage` schema** | No native enterprise-policy channel wired |
| Diagnostics | Track 17 `/doctor` | Home for "active managed source" |

### Per-Platform Behavior

This is the most platform-divergent track: "managed policy" is a fundamentally different mechanism per target. The shared core is the **resolver + `lockedKeys` enforcement**; the *policy source* is platform-native.

- **BrowserX (extension, Chrome).** The idiomatic policy channel is **Chrome's native enterprise mechanism**, not a file: declare a `managed_storage` schema in `manifest.json`, and read admin-pushed policy (set via GPO / Jamf / Workspace / Intune) read-only from **`chrome.storage.managed`**. This is the exact analog of claudy's HKLM/plist for a browser extension — and it means the extension *does* get a real managed tier (correcting the first-pass implication that managed settings are desktop/server-only). Hot-reload via `chrome.storage.onChanged` (the extension's existing reactive channel — **not** server `watchConfig`). `getPolicyOrigin()` → `'chrome-managed'`. `securityCheck` for dangerous managed changes routes through the interactive approval surface (Track 14).
- **Apple Pi (desktop, Tauri).** `managed-settings.json` at an OS well-known path (`/Library/Application Support/AppliPi/`, `%ProgramData%\ApplePi\`, `/etc/applepi/`), reload via fs watch. Full OS-MDM (macOS plist / Windows registry) is the P3/L extension. `getPolicyOrigin()` → `'file'` (later `'plist'|'hklm'`).
- **Apple Pi Server (headless, Docker/K8s).** Where fleet policy matters most. Sources, highest first: the **shared remote-policy fetcher** (the canonical many-container fleet path), then a `managed-settings.json` mounted via ConfigMap/Secret volume, then env. **Precedence nuance (net-new clarification):** in containers, env (`APPLEPI_*`, `applyEnvOverrides:141`) is *itself an admin channel* (set in the K8s deployment manifest). So the model is not naively "policy beats env" — env stays an admin lever; `lockedKeys` exists to stop the *agent runtime / interactive/API overrides* from beating policy, not to override the operator's own env. Hot-reload via the **existing** `watchConfig`/`onConfigReload` (`:168-201`). No interactive user → `securityCheck` auto-applies dangerous managed changes **with a Track 16 `emitLog`/`logs.tail` audit event** so operators see policy changes in the stream they already tail. `getPolicyOrigin()` → `'remote'|'file'|'env'`.

### Key design decisions (and divergences from claudy)

1. **A single `policy` source resolved "first wins," sitting ABOVE all existing layers — in both config systems, with a platform-native source.** server-config effective order: `policy > env > config.json > defaults`; AgentConfig: `policy > stored > default.json`. Port `getPolicySettingsOrigin()` as `getPolicyOrigin()` for Track 17. **Divergence:** the *policy source* is platform-native — `chrome.storage.managed` (ext), well-known file (desktop), remote-fetcher/volume-file/env (server) — not claudy's fixed remote>plist>HKLM>file>HKCU chain.
2. **Explicit `lockedKeys` (net-new vs claudy).** claudy relies on `policySettings` being highest in a `mergeWith` chain. BrowserX's existing merges are deep-merge (`mergeWithDefaults`) and env-overlay — a managed value could be silently overridden. A managed source must declare an explicit `lockedKeys` set; the resolver hard-pins those **post-merge**, and interactive UIs render them non-editable ("managed by your organization"). On the extension this also drives which `manifest.json` `managed_storage` keys are enforced.
3. **One remote-policy fetcher, shared across Tracks 12/16/20.** ETag + `If-None-Match` + SHA-256 + 1h poll + 10s timeout + **fail-open** + stale-cache is identical to what Track 12 needs (org rate-limit / unattended policy) and Track 16 (policy-locked privacy level). Build `core/config/remotePolicy/` **once**; Tracks 12/16 consume it. Primarily exercised on server (fleet), available to desktop; the extension's "remote" equivalent is Chrome managed policy, so the fetcher is desktop/server-focused.
4. **Reuse the platform-native reload seam, never a parallel watcher.** Server/desktop file + remote policy hot-reload through the existing `onConfigReload`/`watchConfig` (`server-config.ts:168-201`). Extension managed policy reloads through `chrome.storage.onChanged`. No bespoke `settingsChangeDetector`.
5. **`securityCheck` before applying dangerous managed changes** (port claudy's `securityCheck.tsx`): expanded permissions / disabled approvals / new allowlisted domains. Interactive runtimes (ext/desktop) prompt via the Track 14 approval surface; **server auto-applies with a Track 16 audit event** (no interactive user).
6. **Phase the OS-MDM matrix (divergence).** The M-effort 80/20: precedence model + `lockedKeys` + the extension `chrome.storage.managed` source + a desktop/server managed-file source + the shared remote fetcher. Full OS-MDM (macOS plist / Windows registry / Linux drop-in dir) is **P3/L**, separate.

## Implementation Plan (file-level, ordered)

**Phase 1 (P1) — resolver + lockedKeys, both systems.**
- `core/config/policy/PolicyResolver.ts`: first-wins `policy` tier + `lockedKeys` post-merge pin; `getPolicyOrigin()`.
- Integrate into `server/config/server-config.ts` (`policy > env > file > defaults`) and `config/defaults.ts` `mergeWithDefaults` (`policy > stored > default.json`).

**Phase 2 (P1) — platform-native sources.**
- Extension: add `managed_storage` schema to `manifest.json`; `extension/storage/ChromeManagedConfigSource.ts` reading `chrome.storage.managed` (read-only) + `chrome.storage.onChanged` reload; feeds `PolicyResolver`.
- Desktop/server: `core/config/policy/ManagedFileSource.ts` at the OS well-known path / mounted volume; hot-reload via existing `onConfigReload`/`watchConfig`.
- Interactive UIs render `lockedKeys` non-editable with the org-managed label.

**Phase 3 (P1) — remote fetcher + securityCheck.**
- `core/config/remotePolicy/` (ETag/checksum/1h-poll/10s-timeout/fail-open/stale-cache); export for Tracks 12/16.
- `securityCheck`: interactive prompt (ext/desktop, Track 14 surface) vs server auto-apply + Track 16 `emitLog` audit event.

**Phase 4 (P3/L) — OS-MDM matrix.**
- macOS plist / Windows registry / Linux `managed-settings.d` sources behind the same `PolicyResolver` interface.

## Dependencies

- **Track 12** (Rate-Limit) & **Track 16** (Telemetry): consume the shared remote-policy fetcher; privacy level / unattended / rate-limit policy can be `lockedKeys`; server `securityCheck` audit rides Track 16.
- **Track 14** (Plan/Approval): `securityCheck` for dangerous managed changes routes through the approval surface (ext/desktop).
- **Track 17** (Diagnostics): `/doctor` reports `getPolicyOrigin()` + locked keys.
- **Track 18** (Cost): per-job/per-day USD budget cap is a candidate `lockedKeys` policy.
- Existing `server-config` reload seam + `AgentConfig`/`mergeWithDefaults`; extension `chrome.storage` layer + `manifest.json`.

## Risks

- A misconfigured remote/managed policy could lock users out — **fail-open** + stale-cache + never hard-deny on fetch failure (claudy's explicit contract).
- Two config systems → the policy tier must be implemented consistently in both; share the resolver/`lockedKeys` logic, not copy.
- Silent override: browserx's deep-merge could let a non-policy layer beat a managed value — `lockedKeys` post-merge pin is the guard; test explicitly.
- Extension: a wrong `managed_storage` schema can break extension load for managed fleets — schema is additive, all keys optional, validated.
- Scope: resist full OS-MDM in v1.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `utils/settings/settings.ts:309-345,372-400,663-776`; `services/remoteManagedSettings/index.ts:11,52-57,131-136,144,273-275`; `securityCheck.tsx`.
- browserx core: `server/config/server-config.ts:124-151` (env>file>defaults, `applyEnvOverrides:141`), `:168-201` (reload seam); `config/defaults.ts:195-212`; `config/types.ts:17-21,476-480`.
- browserx platforms: extension `extension/storage/ChromeConfigStorage.ts:24` (`chrome.storage.local` only — no managed channel today), `manifest.json:12` (`"storage"`, no `managed_storage` schema); server `server-config.ts:127-128,141,179` (`APPLEPI_*` env as container admin channel); desktop OS well-known path (new).

Corrections vs the first-pass draft:
1. browserx has **two** independent config systems; the policy tier lands in both via a shared `PolicyResolver`.
2. claudy's policy precedence is **first-source-wins** (not merge) and highest; browserx's existing layers deep-merge, so an explicit `lockedKeys` post-merge pin is required.
3. The shared remote-policy fetcher is an explicit cross-track artifact (Tracks 12/16/20 build it once).
4. Reuse the **existing** `onConfigReload`/`watchConfig` (server/desktop) and `chrome.storage.onChanged` (extension) seams; no bespoke change detector.
5. **Multi-platform (2026-05-15):** the extension's policy source is **Chrome-native `chrome.storage.managed`** + a `manifest.json` `managed_storage` schema (the proper analog of claudy's HKLM/plist) — the extension *does* get a managed tier, correcting the first-pass desktop/server-only implication. On server, clarified that env is itself an admin channel in containers, so `lockedKeys` guards against *runtime/API* override, not the operator's env; the remote fetcher is the fleet path and `securityCheck` auto-applies with a Track 16 audit event headless.
