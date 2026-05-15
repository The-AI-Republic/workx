# Track 20: Managed / Policy Settings Tier

**Priority: P1** · **Effort: M** (full OS-MDM parity: P3/L) · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's settings precedence + remote-managed-settings and browserx's two config systems — see "Validation Notes".

## Problem

BrowserX has **no admin-enforced configuration tier**. There are two independent config systems, neither with a policy layer:
- `server/config/server-config.ts` — `loadServerConfig()` is **env > config.json > defaults** (`applyEnvOverrides` + `ServerConfigSchema.parse`); no policy tier.
- `config/AgentConfig` + `config/defaults.ts` — `mergeWithDefaults()` deep-merges stored config over `default.json` static metadata; no admin-enforced source, no locked keys.

For team/server deployments (org-locked permissions, enforced allowlists, fleet management) there is no way for an administrator to set configuration a user cannot override.

## What Claudy Does

Settings come from an ordered source chain merged via `lodash mergeWith` "in priority order with deep merging" (`utils/settings/settings.ts:673`): `policySettings`, `userSettings`, `projectSettings`, `localSettings`, `flagSettings`. **`policySettings` sits at the top and is itself resolved by "first source wins," not merged** (`getSettingsForSourceUncached`, `settings.ts:319-345`):

```
remote managed  →  MDM (HKLM / macOS plist)  →  managed-settings.json (+ .d/)  →  HKCU
```

`getPolicySettingsOrigin()` (`:372-400`) reports which won (`'remote'|'plist'|'hklm'|'file'|'hkcu'`) — used for diagnostics.

`services/remoteManagedSettings/index.ts`: enterprise-only (`isEligibleForRemoteManagedSettings`), `POLLING_INTERVAL_MS = 1h`, `SETTINGS_TIMEOUT_MS = 10s`, **fail-open** (`:11` "if fetch fails, continues without remote settings"), SHA-256 checksum (`computeChecksumFromSettings → sha256:…`), **ETag** via `If-None-Match` (`:273-275`), background poll, `securityCheck.jsx` prompts before applying dangerous managed changes, hot-reload via a change detector.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Server config | `server/config/server-config.ts:124-151` `loadServerConfig()` env>file>defaults, `ServerConfigSchema` (zod) | No policy tier |
| Server hot-reload | `onConfigReload()` / `watchConfig()` / `stopWatchingConfig()` (`:168-201`) | **Existing reload seam** — reuse for managed layer |
| Agent config | `config/AgentConfig` + `config/defaults.ts:195` `mergeWithDefaults()` (stored ⊕ `default.json`) | Two layers, no policy/locked keys |
| Diagnostics | Track 17 `/doctor` | Natural home for "active managed source" |

### Key design decisions (and divergences from claudy)

1. **Add a single `policy` source resolved "first wins," sitting ABOVE all existing layers — in both config systems.** server-config effective order becomes `policy > env > config.json > defaults`; AgentConfig becomes `policy > stored > default.json`. Port claudy's `getPolicySettingsOrigin()` as a `getPolicyOrigin()` for Track 17 `/doctor`. **Divergence:** claudy's non-policy sources deep-merge; browserx keeps its existing merge for those — only the new `policy` tier is first-wins-and-highest.

2. **Explicit `lockedKeys` (net-new vs claudy).** claudy relies on `policySettings` being highest in a `mergeWith` chain to make managed values win. BrowserX's existing merges are deep-merge (`mergeWithDefaults`) and env-overlay — a managed value could be silently overridden. So a managed source must declare an explicit `lockedKeys` set; the resolver hard-pins those (post-merge enforcement) and the Svelte UI renders them non-editable with "managed by your organization."

3. **One remote-policy fetcher, shared across Tracks 12/16/20.** The ETag + `If-None-Match` + SHA-256-checksum + 1h background poll + 10s timeout + **fail-open** + stale-cache pattern is identical to what Track 12 needs for org rate-limit policy and Track 16 for a policy-locked privacy level. Build `core/config/remotePolicy/` **once**; Tracks 12/16 consume it. This is an explicit cross-track consolidation, not three copies.

4. **Reuse the existing server reload seam.** claudy has a bespoke `settingsChangeDetector`; browserx already has `onConfigReload`/`watchConfig` (`server-config.ts:168-201`). The managed-file + remote-policy layers hot-reload through that existing callback bus — no parallel watcher.

5. **`securityCheck` before applying dangerous managed changes** (port claudy's `securityCheck.tsx`): expanded permissions / disabled approvals / new allowlisted domains prompt before apply (routes through Track 14/approval surface on interactive runtimes; auto-applied with an audit event on server).

6. **Phase the OS-MDM matrix (divergence).** claudy's plist/HKLM/HKCU is desktop/OS-specific and the extension has no equivalent. The M-effort 80/20 is: precedence model + `lockedKeys` + one managed-file source (desktop/server well-known path) + remote policy. Full MDM (macOS plist / Windows registry / Linux drop-in dir) is **P3/L**, separate.

### Phase plan

- **Phase 1 (P1):** `ConfigResolver` policy tier (first-wins, highest) + `lockedKeys` enforcement in both config systems; `getPolicyOrigin()`.
- **Phase 2 (P1):** managed-settings file source at a well-known path (desktop/server) + Svelte "managed" indicators; hot-reload via existing `onConfigReload`.
- **Phase 3 (P1):** shared `core/config/remotePolicy/` (ETag/checksum/1h-poll/10s-timeout/fail-open/stale-cache) + `securityCheck` before apply; expose to Tracks 12/16.
- **Phase 4 (P3/L):** OS-MDM matrix (macOS plist / Windows registry / Linux managed-settings.d).

## Dependencies

- **Track 12** (Rate-Limit) & **Track 16** (Telemetry): consume the shared remote-policy fetcher; privacy level / rate-limit policy can be `lockedKeys`
- **Track 17** (Diagnostics): `/doctor` reports `getPolicyOrigin()` + locked keys
- **Track 14** (Plan/Approval): `securityCheck` for dangerous managed changes routes through the approval surface
- Existing `server-config` reload seam (`onConfigReload`/`watchConfig`) + `AgentConfig`/`mergeWithDefaults`

## Risks

- A misconfigured remote policy could lock users out — **fail-open** + stale-cache + never hard-deny on fetch failure (claudy's explicit contract).
- Two config systems means the policy tier must be implemented twice (server-config and AgentConfig) consistently — share the resolver/lockedKeys logic, not just copy.
- Silent override: browserx's deep-merge could let a non-policy layer beat a managed value — `lockedKeys` post-merge pin is the guard; test it explicitly.
- Scope: resist building full OS-MDM in v1; precedence + file + remote is the value.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `utils/settings/settings.ts:309-345` (`getSettingsForSource`, `policySettings` first-wins remote>MDM>file>HKCU), `:372-400` (`getPolicySettingsOrigin`), `:663-776` (priority-order `mergeWith` chain); `services/remoteManagedSettings/index.ts:11` (fail-open), `:52-57` (1h poll, 10s timeout), `:131-136` (SHA-256 checksum), `:273-275` (`If-None-Match` ETag), `:144` (eligibility), `securityCheck.tsx`.
- browserx: `server/config/server-config.ts:124-151` (`loadServerConfig` env>file>defaults, zod), `:168-201` (`onConfigReload`/`watchConfig`/`stopWatchingConfig` reload seam); `config/defaults.ts:195-212` (`mergeWithDefaults` stored⊕default.json); `config/types.ts:17-21,476-480` (two-layer model). No policy tier in either system (grep).

Corrections vs the first-pass draft:
1. Pinned that browserx has **two** independent config systems (server-config + AgentConfig); the policy tier must land in both — the draft implied one `ConfigResolver`.
2. claudy's policy precedence is **first-source-wins** (not merge) and sits highest; browserx's existing layers deep-merge, so an explicit `lockedKeys` post-merge pin is required (the draft assumed "highest in merge order" suffices — it does not for a deep-merge system).
3. Made the shared remote-policy fetcher an explicit cross-track artifact (Tracks 12/16/20 build it once) — the draft only hinted at "same pattern."
4. Reuse the **existing** `onConfigReload`/`watchConfig` seam for hot-reload instead of porting claudy's `settingsChangeDetector`.
