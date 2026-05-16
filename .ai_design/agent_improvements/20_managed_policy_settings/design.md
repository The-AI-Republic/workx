# Track 20: Managed / Policy Settings Tier

**Priority: P1** · **Effort: M** (full OS-MDM parity: P3/L) · **Status: READY TO IMPLEMENT (end-to-end spec)**

> Source: third-pass claudy↔browserx research (2026-05-16) — full reads of claudy's
> `services/remoteManagedSettings/` + `utils/settings/` and a full audit of browserx's
> two config systems, all three bootstraps, the three config write surfaces, and the
> Track 12/14/16/17 integration points. See **"Validation Notes"** for the verified
> file:line map. This revision **corrects** prior drafts (see "Corrections" at the end):
> AgentConfig hydrates via `buildRuntimeConfig` (not `mergeWithDefaults`); claudy has
> **no** `lockedKeys` and **no** generic managed-UI lock (both are net-new here, not a
> port); desktop has **no** config watcher to reuse; Tracks 16/17 are design-only.

---

## Problem

BrowserX has **no admin-enforced configuration tier**. An administrator deploying to a
team/fleet cannot set configuration that a user — *or the agent itself* — is unable to
override (org-locked approvals, enforced allowlists, fleet rate-limit/privacy policy,
spend caps).

There are **two fully independent config systems**, neither with a policy layer, and the
agent system has **three** independent write surfaces, any one of which can silently beat
a managed value:

- **Server config** — `src/server/config/server-config.ts`. `loadServerConfig()` is
  `env > config.json > schema-defaults` (`applyEnvOverrides:210` then
  `ServerConfigSchema.parse:142`). Governs HTTP/auth/limits only. No policy tier.
- **Agent config** — `src/config/AgentConfig.ts` + `src/config/defaults.ts`. The runtime
  is hydrated by **`buildRuntimeConfig(stored)` (`defaults.ts:351`)**, called by both
  `AgentConfig.initialize()` (`AgentConfig.ts:85`) and `reload()` (`:114`). It is a
  **one-level-deep manual merge** where stored always beats `default.json`. Three write
  surfaces mutate `currentConfig` after that merge:
  1. `updateConfig()` (`AgentConfig.ts:131`) — UI settings pages, shallow spread.
  2. Domain mutators — `setProviderApiKey()` (`:419`), `updateToolsConfig`,
     `updateProvider`, profile mutators.
  3. The LLM `setting_tool` — gated only by `configSchema.ts:resolve(path, action)`.

  A managed value pinned only at the merge point is therefore overwritable by all three
  until the next reload. **This is the crux of making the feature actually work
  end-to-end** and is the central engineering content of this track.

## What Claudy Does (and what it does *not* do)

Claudy resolves a `policySettings` source that is **highest precedence purely by merge
order** — it is *last* in `SETTING_SOURCES` (`utils/settings/constants.ts:7-22`) and the
`loadSettingsFromDisk` loop `mergeWith`s sources in array order, last-writer-wins
(`settings.ts:674,761-766`). Within `policySettings` it is **first-source-wins** (not
merged): `remote → MDM(plist/HKLM) → managed-settings.json → HKCU`
(`settings.ts:319-345`). `getPolicySettingsOrigin()` (`settings.ts:375-407`) reports the
winner; its only consumer is the `/status` diagnostics command (`utils/status.tsx:139`).

The remote fetcher (`services/remoteManagedSettings/index.ts`): SHA-256 checksum
(`sortKeysDeep → stable JSON → sha256`, prefixed `sha256:`, computed locally from cache,
never persisted — `:131-137,423-426`), `If-None-Match` conditional GET (`:274-276`), 10s
timeout (`:52`), 1h `.unref()` poll (`:54,612-628`), **fail-open** (stale cache else
continue without — `:432-443,492-502`), status semantics `304→keep / 204|404→clear /
200→validate / auth→skipRetry` (`:287-360`). Eligibility is gated on enterprise/team
Anthropic subscription (`syncCache.ts:49-112`). Hot-reload: a change-detector
`notifyChange('policySettings') → fanOut → resetSettingsCache() + settingsChanged.emit`
(`changeDetector.ts:437-450`); the poll diffs `jsonStringify(prev)` vs `(new)`.
`securityCheck.tsx`: "dangerous" = shell-helper settings / non-allowlisted env / hooks
(`ManagedSettingsSecurityDialog/utils.ts`); **headless ⇒ applied silently with no
prompt and no audit** (`securityCheck.tsx:22-61`); interactive reject ⇒ `process.exit(1)`.

**Claudy does NOT have** (verified — these are net-new, not ports):
- **No explicit `lockedKeys`** of any kind. Enforcement is *purely structural* via merge
  order. The only "managed" controls are hard-coded capability booleans
  (`disableBypassPermissionsMode`, `allowManagedHooksOnly`, …) honored ad hoc by helpers
  that read `getSettingsForSource('policySettings')` directly — not a generic mechanism.
- **No generic managed-field UI lock.** The settings editor (`components/Settings/
  Config.tsx`) always writes to user/local and never checks policy origin — a
  policy-overridden value still *appears editable* and the edit silently persists but is
  re-overridden at merge time. Only feature-specific ad-hoc checks exist (permission
  rules `rule.source === 'policySettings'`; the sandbox adapter
  `areSandboxSettingsLockedByPolicy()` — the closest reusable pattern).

**Consequence:** Track 20's `lockedKeys` + non-editable UI are **net-new engineering
designed from first principles for BrowserX**, not a transplant. The transplantable
*ideas* are: first-source-wins policy resolution, the conditional-GET/fail-open/poll
fetcher, headless-vs-interactive securityCheck, and origin reporting for diagnostics.

## BrowserX Design

### One shared resolver, two pin sites, three write guards, per-platform sources

The shared core is **`src/core/config/policy/PolicyResolver.ts`** — platform-agnostic,
no I/O. Platform-native *sources* feed it; both config systems *consume* it.

```
PolicySource[]  (ordered, first non-empty wins)
   ext:     ChromeManagedConfigSource   (chrome.storage.managed, read-only)
   desktop: ManagedFileSource           (OS well-known path)
   server:  RemotePolicySource > ManagedFileSource > env-nuance
        │
        ▼
PolicyResolver.resolveActivePolicy() ──► ResolvedPolicy { values, lockedKeys, origin }
        │                                  (cached in-memory; refreshed on reload)
        ├─ applyPolicy(agentMerged,  policy, 'agent')   ◄─ end of buildRuntimeConfig (defaults.ts:394)
        └─ applyPolicy(serverParsed, policy, 'server')  ◄─ inside loadServerConfig (server-config.ts:142-144)
        │
   write guards (agent system, all three surfaces):
        ├─ AgentConfig.updateConfig()         strip/reject locked dot-paths, re-pin (AgentConfig.ts:131)
        ├─ domain mutators (setProviderApiKey:419, updateToolsConfig, updateProvider, profiles)
        └─ LLM setting_tool                   configSchema.ts resolve(path,'write') → deny if locked
        │
   surfaces:
        ├─ IAgentConfig.policy { lockedKeys, origin }  (runtime-only, NOT persisted)
        ├─ webfront settings/* inputs disabled + "Managed by your organization"
        └─ getPolicyOrigin()/getLockedKeys() standalone exports → diagnostics
```

### Why the post-merge **deep** pin is mandatory

`buildRuntimeConfig` (`defaults.ts:394-441`) merges only **one level deep** (e.g.
`tools: { ...DEFAULT_TOOLS_CONFIG, ...stored.tools, sandboxPolicy:{…}, perToolConfig:{…} }`).
A *shallow* pin would be defeated for a nested locked key (e.g.
`tools.sandboxPolicy.network_access`). Therefore `applyPolicy` must perform a
**recursive set-by-dot-path overwrite** of every `lockedKeys` entry **after** all merging,
using the policy value verbatim (arrays **replace**, not claudy's concat — an org
allowlist must be *exactly* the admin's list, not user ∪ admin). This is the single
guarantee the whole track rests on; it is tested explicitly.

### The shared resolver — API (net-new, `src/core/config/policy/`)

```ts
// PolicyResolver.ts
export type PolicyOrigin = 'chrome-managed' | 'file' | 'remote' | 'env' | null;

export interface ResolvedPolicy {
  values: Record<string, unknown>;     // namespaced dot-paths: "agent.*" | "server.*"
  lockedKeys: string[];                // namespaced dot-paths
  origin: PolicyOrigin;
}

export interface PolicySource {
  readonly origin: Exclude<PolicyOrigin, null>;
  load(): Promise<ResolvedPolicy | null>;          // null = this source has no policy
  subscribe?(onChange: () => void): () => void;    // platform-native reload hook
}

export function registerPolicySources(sources: PolicySource[]): void;       // ordered
export function resolveActivePolicy(): Promise<ResolvedPolicy | null>;      // first-wins; caches
export function getActivePolicySync(): ResolvedPolicy | null;               // last resolved (for pin)
export function applyPolicy<T>(target: T, policy: ResolvedPolicy | null,
                               ns: 'agent' | 'server'): T;                  // overlay + deep-pin
export function isKeyLocked(nsPath: string): boolean;
export function getLockedKeys(ns: 'agent' | 'server'): string[];
export function getPolicyOrigin(): PolicyOrigin;
export function onPolicyChanged(cb: (p: ResolvedPolicy | null) => void): () => void;
```

- **First-source-wins** mirrors claudy: the first registered source whose `load()`
  returns a non-empty `values` *or* non-empty `lockedKeys` wins entirely; lower sources
  are ignored (no inter-source merge). `origin` records the winner.
- **Namespacing** is a BrowserX necessity (claudy has one settings doc; we have two
  systems). One policy document; `values`/`lockedKeys` use `agent.*` / `server.*`
  prefixes; `applyPolicy(target, policy, ns)` filters to its namespace before overlay
  and pin. On the server **both** call sites run (server-config gets `server.*`,
  AgentConfig gets `agent.*`); on extension/desktop only the `agent.*` site exists.
- `applyPolicy` = (1) overlay every `ns.*` value at its dot-path, then (2) recursively
  overwrite every `ns.*` `lockedKeys` path with the policy value. Pure, sync, no I/O —
  the pin reads `getActivePolicySync()` so `buildRuntimeConfig` stays synchronous.

### Pin + write-guard integration (exact seams)

| Seam | File:line | Change |
|---|---|---|
| Agent merge pin | `config/defaults.ts:394` | wrap final return: `return applyPolicy(merged, getActivePolicySync(), 'agent')` |
| Agent write guard 1 | `config/AgentConfig.ts:131` (`updateConfig`) | reject/strip writes whose dot-path `isKeyLocked('agent.'+path)`, then re-apply pin to `currentConfig` |
| Agent write guard 2 | `config/AgentConfig.ts:419` (`setProviderApiKey`) + `updateToolsConfig`/`updateProvider`/profile mutators | guard locked paths before mutate+persist |
| Agent write guard 3 | `config/configSchema.ts:resolve(path, action)` | when `action==='write'` and `isKeyLocked('agent.'+path)` → return deny (the LLM `setting_tool` path) |
| Server pin | `server/config/server-config.ts:142-144` | between `ServerConfigSchema.parse(merged)` and `_config = parsed`: `_config = applyPolicy(parsed, getActivePolicySync(), 'server')` |
| Reload event | `config/AgentConfig.ts:reload()` (`:109-119`) | after re-hydrate, `emitChangeEvent('config-changed', { reason: 'policy' })` (`emitChangeEvent:889`) so the UI re-renders locked fields — `reload()` currently emits nothing |
| Runtime surface | `config/types.ts:26` (`IAgentConfig`) | add **runtime-only** `policy?: { lockedKeys: string[]; origin: PolicyOrigin }`; **must NOT** be added to `IStoredConfig`/`extractStoredConfig` (`:449`) — policy is admin-sourced, never persisted to user storage |

### Per-platform policy sources + reload (each is platform-correct, not uniform)

- **BrowserX extension (Chrome).** `ChromeManagedConfigSource` reads
  **`chrome.storage.managed`** (read-only; admin-pushed via GPO/Jamf/Workspace/Intune) —
  the proper analog of claudy's HKLM/plist. Add a `managed_storage` block + a bundled
  schema JSON to `src/extension/manifest.json` (today: `"storage"` only, no
  `managed_storage`); extend the `scripts/build.js` copy list (it `copyFileSync`s the
  manifest at `:43-47`, file list near `:175`) so the schema lands in `dist/`. Created
  **between `setConfigStorage` (`service-worker.ts:187`) and `AgentConfig.getInstance`
  (`:211`)** so the first `buildRuntimeConfig` already sees policy. Reload: a **net-new
  `chrome.storage.onChanged` listener** (`area === 'managed'`) → `resolveActivePolicy()`
  → `AgentConfig.reload()`. `origin: 'chrome-managed'`. (Neither `chrome.storage.managed`
  nor `onChanged` is used anywhere today — both net-new.)
- **Apple Pi desktop (Tauri).** `ManagedFileSource` at an OS well-known path
  (`/Library/Application Support/ApplePi/managed-settings.json`,
  `%ProgramData%\ApplePi\managed-settings.json`, `/etc/applepi/managed-settings.json`).
  Created before `AgentConfig.getInstance` (`DesktopAgentBootstrap.ts:93`). **Reload is
  net-new** — desktop has **no `fs.watch`/`onConfigReload` analog** (verified; only
  manual `AgentConfig.reload()` exists). Specify a Tauri-side fs-watch command **or** a
  60s poll feeding `resolveActivePolicy()` → `AgentConfig.reload()`. The doc must **not**
  claim "reuse `watchConfig`" here (server-only). `origin: 'file'`.
- **Apple Pi server (headless, Docker/K8s).** Sources, highest first:
  `RemotePolicySource` (the net-new fetcher — the canonical fleet path) → `ManagedFileSource`
  (a ConfigMap/Secret-mounted path, e.g. `APPLEPI_POLICY_PATH`) → **env nuance**: in
  containers `APPLEPI_*` env *is itself* an operator/admin channel
  (`server-config.ts:210-233`), so `lockedKeys` guards the **agent runtime / interactive
  / LLM** surfaces — *not* the operator's own env. Reload: **reuse the existing real
  seam** `watchConfig`/`onConfigReload`/`stopWatchingConfig`
  (`server-config.ts:168-204`) plus the fetcher's 1h poll; both re-run
  `loadServerConfig()` (server-config pin) and trigger `AgentConfig.reload()` (agent pin
  on the server). `origin: 'remote' | 'file' | 'env'`.

### The shared remote fetcher (net-new, `src/core/config/remotePolicy/`)

There is **no existing remote-fetch primitive** anywhere in `src/` to unify with — this
is built once. Tracks 12 and 16 are **consumers of the config keys it sets** (Track 12's
`withModelRetry` reads `unattended`/max-wait via normal config; Track 16's privacy level
likewise) — they do **not** call the fetcher API. Surface:

```ts
// remotePolicy/RemotePolicyFetcher.ts
export interface RemoteFetchResult {
  status: 'updated' | 'unchanged' | 'cleared' | 'error';
  policy?: ResolvedPolicy;     // status==='updated'
  skipRetry?: boolean;         // auth-class error
}
export function computePolicyChecksum(p: unknown): string;  // sortKeysDeep→stableJSON→`sha256:`+sha256
export async function fetchRemotePolicy(opts: {
  endpoint: string; authHeaders?: Record<string,string>;
  cachedChecksum?: string; timeoutMs: number;              // default 10_000
}): Promise<RemoteFetchResult>;
export function startPolicyPoll(intervalMs?: number): void; // default 3_600_000; .unref-equiv; idempotent
export function stopPolicyPoll(): void;
```

- **Conditional GET / fail-open** (claudy-parity, ported faithfully): send
  `If-None-Match: "<cachedChecksum>"`; `304 → unchanged (keep cache)`; `200 → validate
  (zod) → updated`; `204|404 → cleared (drop cache — managed policy removed)`; auth
  error → `error{skipRetry:true}`; network/timeout → `error` (retryable). On any error,
  caller uses **stale cache if present, else continues with no policy** — never
  hard-deny. Checksum recomputed from cache on each request, never persisted.
- **Cache via the existing `ConfigStorageProvider`** abstraction (key `policy_cache`) —
  **not** a new bespoke disk path (claudy writes `~/.claude/remote-settings.json`;
  BrowserX already has a platform-portable storage seam — reuse it, this is a deliberate
  improvement for the extension/desktop/server split).
- **Eligibility analog**: claudy gates on Anthropic enterprise subscription; BrowserX
  has no such concept — the fetcher is attempted **iff a policy endpoint is configured**
  (`APPLEPI_POLICY_ENDPOINT` / server config). No remote fetcher on the extension
  (Chrome managed storage *is* its channel); fetcher is desktop/server only.
- First fetch is non-blocking: resolves immediately from cache if present while the
  network fetch continues; a bounded wait (≤30s) prevents startup deadlock (claudy
  parity).

### securityCheck (net-new logic, real integration points)

`src/core/config/policy/securityCheck.ts`. "Dangerous" is **BrowserX-domain** (claudy's
shell/env/hooks don't map): a *newly applied* policy that **weakens** security vs the
currently-applied policy — e.g. approval policy relaxed (`approval.policy` →
`never`/disabled), tool permissions expanded, new allowlisted domains, sandbox network
access opened, credential changes. Only prompt when it **weakens AND changed**.

- **Extension / desktop (interactive):** call the **real** core API
  `ApprovalManager.requestApproval({ type:'dangerous_action', riskLevel:'high', title,
  description, details })` (`src/core/ApprovalManager.ts:101`; request shape `:10-30`;
  obtained via `RepublicAgent.getApprovalManager()` `:1166`). On **reject**: do **not**
  apply the new policy; keep the previously-applied policy and continue running. (No
  `process.exit` — that is claudy's CLI behavior; BrowserX stays up on prior policy.)
- **Server (headless):** **never** call the core `ApprovalManager` — on the server it
  has no decision wiring and **fail-opens / hangs** (verified: `ApprovalManager.ts:145-184`;
  only the *separate* `server/exec/approval-manager.ts` is wired, different API).
  Instead **auto-apply + audit** via the **real, shipped** primitive
  `emitLog('warn', 'managed policy applied', { origin, lockedKeys, changedKeys })`
  (`src/server/handlers/logs.ts:39`; event `{level,message,data,timestamp}`). `emitLog`
  performs **no redaction** — `securityCheck` must redact secret-bearing values
  (api keys, tokens) **before** the call. This is a deliberate **improvement over
  claudy** (claudy headless = silent, *no* audit at all).

### Diagnostics (Track 17 is design-only — degrade gracefully)

Track 17's `/doctor` and its `DiagnosticRegistry` **do not exist in code** (verified:
zero `doctor`/`DiagnosticRegistry` symbols). Therefore:
- `PolicyResolver` exports `getPolicyOrigin()` / `getLockedKeys()` /
  `getActivePolicySummary()` as **plain standalone functions** — callable today (e.g.
  surfaced via the existing `server/handlers/health.ts`).
- Additionally ship a `makePolicyDiagnosticCheck()` factory matching Track 17's designed
  `DiagnosticCheck` interface, registered **conditionally** *iff* the registry exists.
  Track 20 must **not** import a non-existent registry.

## Implementation Plan (phased; each phase leaves the system consistent)

**Phase 1 (P1) — shared resolver + enforcement in both systems + all three write guards.**
Build `core/config/policy/PolicyResolver.ts` (resolver, `applyPolicy` deep-pin,
standalone exports, write-guard helpers). Wire the two pin sites (`defaults.ts:394`,
`server-config.ts:142-144`) and **all three** agent write guards
(`updateConfig`, domain mutators, `configSchema.ts:resolve`). Add the runtime-only
`IAgentConfig.policy` field; emit `config-changed` from `reload()`.
*Outcome:* a policy supplied by a stub/test source is **enforced and cannot be overridden
by any write surface or by reload** — the core guarantee is functional and unit/integration
tested end-to-end (with a stub source).

**Phase 2 (P1) — platform-native sources + reload + UI lock.**
`ChromeManagedConfigSource` + `manifest.json` `managed_storage` + schema in build copy +
`chrome.storage.onChanged` reload. `ManagedFileSource` for desktop (net-new
watch/poll) and server (reuse `watchConfig`/`onConfigReload`). Webfront `settings/*`
components read `getConfig().policy.lockedKeys`, disable locked inputs, render "Managed
by your organization" (generalize claudy's sandbox-adapter pattern into one
`isLocked(path)` helper).
*Outcome:* real admin policy on **every** platform with hot-reload; users see locked
fields as non-editable; end-to-end works on extension, desktop, and server (sans remote).

**Phase 3 (P1) — remote fetcher + securityCheck.**
`core/config/remotePolicy/` (checksum/If-None-Match/1h-poll/10s-timeout/fail-open/
cleared-on-204|404/cache-via-ConfigStorageProvider) registered as the
highest-precedence server/desktop `PolicySource`. `securityCheck`: ext/desktop →
`ApprovalManager.requestApproval`; server → `emitLog` audit + pre-redaction. Document
the Track 12/16 config-key contract.
*Outcome:* fleet remote policy + dangerous-change gating. **Full track functionality
end-to-end.**

**Phase 4 (P3/L) — OS-MDM matrix.**
macOS plist / Windows registry / Linux `managed-settings.d/` as additional
`PolicySource` impls behind the same interface. Independent, optional, no change to
Phases 1-3 contracts.

## Test Strategy (must prove end-to-end, not just unit)

- **Unit:** `applyPolicy` deep-pin defeats the one-level `buildRuntimeConfig` merge for a
  *nested* locked key; first-source-wins resolution + `origin`; `computePolicyChecksum`
  stability under key reordering; fetcher status matrix (`304/200/204/404/auth/timeout`).
- **Integration (the crux — a locked `agent.approval.policy` must survive all four):**
  (a) `buildRuntimeConfig`/`reload()`, (b) `updateConfig()`, (c) `setProviderApiKey`/
  domain mutator, (d) the LLM `setting_tool` via `configSchema.resolve`. All four must
  fail to override; `config-changed` fires on reload.
- **Fail-open:** fetcher error ⇒ stale cache used (or none) ⇒ agent still runs; `204` ⇒
  policy cleared, locks released.
- **securityCheck:** ext/desktop reject ⇒ prior policy retained, process stays up;
  server ⇒ auto-applied + a **redacted** `emitLog` audit emitted.
- **Per-platform:** stubbed `chrome.storage.managed` / managed file / remote each resolve
  and report correct `origin`; `onChanged` / watch / `onConfigReload` each trigger a
  re-resolve.

## Dependencies & Graceful Degradation (code vs design — verified)

| Dependency | Status | Track 20 handling |
|---|---|---|
| Server `watchConfig`/`onConfigReload` | **CODE** (`server-config.ts:168-204`) | reuse directly (server only) |
| `AgentConfig.buildRuntimeConfig`/`reload` | **CODE** (`defaults.ts:351`, `AgentConfig.ts:109`) | pin inside; add reload event |
| Track 12 `withRetry.ts` | **CODE** (pure retry; no config I/O) | consumes config keys we set; no fetcher coupling |
| Track 14 core `ApprovalManager` | **CODE** ext/desktop; **server unwired/fail-open** | call on ext/desktop only; **never on server** |
| Track 16 telemetry framework | **DESIGN ONLY**; `emitLog` sink **CODE** (`logs.ts:39`) | depend on `emitLog` directly; redact before emit |
| Track 17 `/doctor`/registry | **DESIGN ONLY** (zero code) | standalone exports now; conditional registration later |
| Track 18 cost cap | **DESIGN ONLY** | merely a candidate `lockedKeys` value; non-blocking |
| `chrome.storage.managed`/`onChanged` | **absent today** | both net-new (Phase 2) |
| Desktop config watcher | **absent** (no `fs.watch`) | net-new watch/poll (Phase 2) — **not** a `watchConfig` reuse |

## Risks

- **Silent override (highest risk):** browserx's one-level merge + three write surfaces
  could let a non-policy path beat a managed value. Mitigation: post-merge **deep** pin
  *and* guards at **all three** write entry points; explicit four-surface integration
  test. A pin-only-at-merge implementation is **not** end-to-end and is rejected.
- A misconfigured/unreachable remote or managed policy could lock users out → **fail-open
  + stale-cache + never hard-deny**; `204|404` actively clears stale locks.
- Two config systems → policy must enforce in both via the *shared* resolver + namespaced
  paths; never copy logic.
- Server `securityCheck` must **never** call the core `ApprovalManager` (fail-open hang)
  — server is auto-apply + audit only.
- Extension: a malformed `managed_storage` schema can break extension load for managed
  fleets — schema is additive, all keys optional, validated; covered by Phase 2 tests.
- `emitLog` does no redaction — Track 20 owns redaction of secret-bearing managed values.
- Scope: resist full OS-MDM in v1 (Phase 4, separate).

## Validation Notes (verified 2026-05-16)

- **claudy:** `services/remoteManagedSettings/index.ts:52,54,131-137,144,274-276,287-360,
  416,423-443,492-502,538-547,589-628`; `syncCache.ts:49-112`; `syncCacheState.ts:32,
  51-96`; `securityCheck.tsx:22-73` + `ManagedSettingsSecurityDialog/utils.ts`;
  `utils/settings/settings.ts:309-345,375-407,538-547,645-796`;
  `utils/settings/constants.ts:7-22,159-167`; `utils/settings/changeDetector.ts:103-146,
  381-450`; `utils/settings/types.ts:255,1071-1073` (no locked-keys); `components/
  Settings/Config.tsx` (no policy check); `utils/sandbox/sandbox-adapter.ts:647-664`
  (closest reusable lock pattern); `utils/status.tsx:139` (sole origin consumer).
- **browserx agent config:** `config/AgentConfig.ts:53-60,69-101,109-119,122-125,131-154,
  419-445,889`; `config/defaults.ts:351-442` (esp. `:394` return; one-level merges
  `:400-440`); `config/types.ts:26,449-481,505-531`; `config/configSchema.ts:268-278`;
  storage `core/storage/ConfigStorageProvider.ts:32-112`, `storage/ConfigStorage.ts:27`,
  `extension/storage/ChromeConfigStorage.ts:24`, `server/storage/FileConfigStorageProvider.ts:11`,
  `desktop/storage/TauriConfigStorage.ts:30`.
- **browserx server config:** `server/config/server-config.ts:126-146,142-144,168-204,
  210-233`.
- **browserx bootstraps:** `extension/.../service-worker.ts:187,211`;
  `server/agent/ServerAgentBootstrap.ts:27,142,145,327-335`;
  `desktop/agent/DesktopAgentBootstrap.ts:93,772-773`; `desktop/ui/main.ts:44`;
  build `scripts/build.js:43-47,175`; `extension/manifest.json:12` (no `managed_storage`).
- **integration:** Track 14 `core/ApprovalManager.ts:10-30,101,145-184,1166`;
  Track 16 `server/handlers/logs.ts:15,39-45`; Track 12
  `core/models/resilience/withRetry.ts` (pure retry, no config I/O);
  Track 17 `.ai_design/agent_improvements/17_operational_diagnostics/` (design only);
  sequencing `.ai_design/agent_improvements/README.md` (`12→13→{14..17}→20`).

### Corrections vs prior drafts

1. AgentConfig hydrates via **`buildRuntimeConfig`** (`defaults.ts:351`), **not**
   `mergeWithDefaults` (which exists at `:198` but is unused by `AgentConfig`). The pin
   goes at `defaults.ts:394`.
2. Claudy has **no `lockedKeys`** and **no generic managed-UI lock** — both are
   **net-new BrowserX engineering**, designed here from first principles, not ports.
3. There are **three** agent-config write surfaces; pinning only at the merge point is
   **not** end-to-end. All three must be guarded.
4. **Desktop has no config watcher** — the prior "reuse `onConfigReload`/`watchConfig`"
   claim holds for **server only**; desktop reload is net-new.
5. Tracks **16 and 17 are design-only**; Track 20 depends on the real `emitLog` sink and
   ships standalone diagnostic exports, degrading gracefully.
6. The remote fetcher caches via the existing **`ConfigStorageProvider`**, not a bespoke
   disk path; eligibility = "policy endpoint configured" (no Anthropic-subscription
   analog); no remote fetcher on the extension.
7. Server `securityCheck` **must not** use the core `ApprovalManager` (fail-open hang);
   it auto-applies **with** a redacted audit event — an improvement over claudy's silent
   headless behavior.
