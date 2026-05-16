# Track 20 Tasks

> **Status (2026-05-16):** READY TO IMPLEMENT. Effort M (Phase 4 OS-MDM is
> P3/L, separate). Four phases, each independently shippable as its own PR.
> **Phase 1 delivers the entire enforcement guarantee with zero unbuilt-track
> dependencies** (testable end-to-end with a stub source) — do it first.
> Phase 2 makes policy real per-platform + visible in the UI. Phase 3 adds the
> fleet remote path + securityCheck. Phase 4 is additive OS-MDM.

See [`design.md`](./design.md) for rationale, the verified `file:line` seams,
the seven corrections vs prior drafts, the dependency/degradation table, and
Validation Notes.

**Non-negotiable invariant (the whole track rests on this):** a locked key must
survive **all four** override paths — `buildRuntimeConfig`/`reload`,
`updateConfig`, domain mutators, and the LLM `setting_tool`. A pin only at the
merge point is **not** end-to-end and must not be merged.

---

## Phase 0: Pre-implementation verification (DO FIRST — gates the estimate)

The design was line-level verified on branch `agent-improvements` (2026-05-16).
Re-confirm before editing — the branch moves and these are load-bearing. Record
findings inline in this file.

- [ ] **Re-confirm the agent hydrator.** `src/config/defaults.ts:351` is `buildRuntimeConfig(stored)`; its final `return` is `:394`; nested merges are one level deep (`:400-440`). `grep -n mergeWithDefaults src/config/AgentConfig.ts` → **none** (so `mergeWithDefaults:198` is genuinely unused by AgentConfig). `AgentConfig.ts:85` (`initialize`) and `:114` (`reload`) both call `buildRuntimeConfig`.
- [ ] **Re-confirm the three agent write surfaces.** `AgentConfig.updateConfig` shallow spread at `:131`; `setProviderApiKey` at `:419`; the other domain mutators (`updateToolsConfig`/`updateProvider`/profile) exist and mutate `currentConfig` then persist. `config/configSchema.ts:resolve(path, action)` is at `:268-278` and is the LLM `setting_tool` write gate — confirm signature and that `setting_tool`'s write path actually calls it (`grep -rn "configSchema\|resolve(" src/ | grep -i setting_tool` or trace the tool).
- [ ] **Re-confirm `reload()` emits nothing.** `AgentConfig.reload()` (`:109-119`) has no `emitChangeEvent`; `emitChangeEvent` is at `:889`. ⇒ Phase 1 must add a `config-changed` emission or the UI won't re-render locked fields.
- [ ] **Re-confirm `IStoredConfig` boundary.** `config/types.ts` `IAgentConfig` ~`:26`, `IStoredConfig` `:505-531`, `extractStoredConfig` `defaults.ts:449`. The new `policy` field must be runtime-only — confirm `extractStoredConfig` enumerates an explicit allowlist (so adding `policy` to `IAgentConfig` does NOT round-trip to storage).
- [ ] **Re-confirm the server pin seam.** `server/config/server-config.ts`: `ServerConfigSchema.parse(merged)` at `:142`, `_config = parsed` at `:144`; reload seam `onConfigReload`/`watchConfig`/`stopWatchingConfig` `:168-204`; `applyEnvOverrides` `:210-233` (the 5 env-overridable keys).
- [ ] **Re-confirm bootstrap ordering.** Extension `service-worker.ts`: `setConfigStorage(new ChromeConfigStorage())` `:187` → `AgentConfig.getInstance()` `:211`. Server `ServerAgentBootstrap.ts`: `setConfigStorage` `:142` → `AgentConfig.getInstance()` `:145`; reload bridge `:327-335`. Desktop `DesktopAgentBootstrap.ts:93` (`AgentConfig.getInstance`), `desktop/ui/main.ts:44` (`initializeConfigStorage`), manual reload `DesktopAgentBootstrap.ts:772-773`.
- [ ] **Re-confirm the extension manifest + build copy.** `src/extension/manifest.json` has `"storage"` (~`:12`) and **no** `managed_storage` (`grep -rn "managed_storage\|chrome.storage.managed\|storage.onChanged" src/` → expect **zero**). `scripts/build.js` `copyFileSync`s the manifest `:43-47`; the copied-files list is near `:175`.
- [ ] **Re-confirm desktop has no watcher.** `grep -rn "fs.watch\|onConfigReload\|chokidar\|watchImmediate" src/desktop` → **none**. ⇒ desktop reload is net-new (watch command or poll); do NOT claim `watchConfig` reuse on desktop.
- [ ] **Re-confirm Track 14 API + the server fail-open.** `core/ApprovalManager.ts:101` `requestApproval(req): Promise<ApprovalResponse>`; request/detail shape `:10-30`; server-side no-decision fail-open/hang path `:145-184`; obtained via `RepublicAgent.getApprovalManager()` `:1166`. Confirm the server `exec` manager is the *separate* `src/server/exec/approval-manager.ts` (different API) ⇒ server `securityCheck` must NOT touch core ApprovalManager.
- [ ] **Re-confirm Track 16 sink.** `src/server/handlers/logs.ts:39` `emitLog(level, message, data?)`; `LogLevel` `:15`; event `{level,message,data,timestamp}` `:40-45`. `grep -rn "redact" src/server/handlers/logs.ts` → **none** ⇒ Track 20 owns redaction. `ls src/core/telemetry 2>/dev/null` → none (Track 16 design-only).
- [ ] **Re-confirm Track 17 absent.** `grep -rn "DiagnosticRegistry\|buildDoctorReport\|registerDiagnosticCheck" src/` → **none** ⇒ ship standalone exports; conditional registry registration only.
- [ ] **Re-confirm no remote-fetch primitive + Track 12 shape.** `grep -rn "If-None-Match\|ETag\|computeChecksum\|remotePolicy" src/` → **none** (fetcher is genuinely net-new). `src/core/models/resilience/withRetry.ts` is pure retry (no config I/O); confirm the option names Track 12 reads (`unattended`, the reset/max-wait cap) so Phase 3 documents the exact config keys it consumes.
- [ ] **Pick a dot-path get/set util.** `grep -rn "lodash.get\|lodash/get\|function get(.*path\|getByPath\|setByPath" src/core src/utils` — reuse an existing deep get/set if one exists; **do NOT add a dependency** if so. Record the chosen util here.
- [ ] **Decide the policy document namespacing key.** Confirm `agent.*` / `server.*` prefix convention works for every locked path in scope (e.g. `agent.approval.policy`, `agent.tools.sandboxPolicy.network_access`, `server.exec.approvalPolicy`). Record the canonical key list seed here.

---

## Phase 1: shared `PolicyResolver` + enforcement in both systems + all three write guards

**Goal:** The complete enforcement guarantee. A policy supplied by a stub
source is enforced and **cannot** be overridden by any write surface or by
reload. Pure `core/` engine + the two pin sites + three write guards. No
platform sources, no UI, no fetcher yet — fully testable in isolation.
**Estimated size:** ~350 LOC + tests. **Single PR.**

### 1.1 Types & resolver (`src/core/config/policy/`)

- [ ] `src/core/config/policy/types.ts` — `PolicyOrigin`, `ResolvedPolicy { values, lockedKeys, origin }`, `PolicySource { origin, load(), subscribe? }` exactly as design.md "The shared resolver — API". Module JSDoc header per house convention (`@module core/config/policy/types`).
- [ ] `src/core/config/policy/PolicyResolver.ts` — module-singleton (mirror the `core/*` module-singleton pattern). `registerPolicySources(sources[])` (ordered), `resolveActivePolicy()` (**first non-empty source wins**: first source whose `values` or `lockedKeys` is non-empty wins entirely, lower ignored; caches the result + `origin`), `getActivePolicySync()` (last resolved — for the sync pin), `onPolicyChanged(cb)`, and **standalone** `getPolicyOrigin()` / `getLockedKeys(ns)` / `getActivePolicySummary()` (callable today; Track 17-ready).
- [ ] `src/core/config/policy/applyPolicy.ts` — `applyPolicy<T>(target, policy, ns)`: filter `policy.values`/`policy.lockedKeys` to the `ns.` prefix; (1) overlay each value at its dot-path, then (2) **recursive set-by-dot-path overwrite** of every locked path with the policy value. **Arrays replace** (not claudy concat — an org allowlist is exactly the admin's list). Pure, sync, no I/O. Use the dot-path util chosen in Phase 0.
- [ ] `src/core/config/policy/guards.ts` — `isKeyLocked(nsPath)`, `assertWritable(nsPath)` (throws a typed `PolicyLockedError`), `stripLockedWrites(patch, ns)` (returns patch minus locked paths + the list stripped, for UI-facing soft-reject).
- [ ] `src/core/config/policy/index.ts` — barrel.

### 1.2 Agent-config integration (pin + all three write guards)

- [ ] `src/config/defaults.ts:394` — wrap the final return: `return applyPolicy(merged, getActivePolicySync(), 'agent')`. (Single hydrator ⇒ covers both `initialize` and `reload`.)
- [ ] `src/config/AgentConfig.ts:131` (`updateConfig`) — before assigning `currentConfig`, `stripLockedWrites(config, 'agent')`; if anything was stripped, surface it (return value / `BackgroundEvent`), then re-apply `applyPolicy` to the merged result so the pin holds without waiting for reload.
- [ ] `src/config/AgentConfig.ts:419` (`setProviderApiKey`) + `updateToolsConfig`/`updateProvider`/profile mutators — `assertWritable` on the affected dot-path(s) before mutate+persist (e.g. a locked `agent.providers.<id>` rejects key changes).
- [ ] `src/config/configSchema.ts:resolve(path, action)` (`:268-278`) — when `action === 'write'` and `isKeyLocked('agent.'+path)`, return a deny result (the LLM `setting_tool` surface). Keep the existing deny shape.
- [ ] `src/config/types.ts` (`IAgentConfig` ~`:26`) — add runtime-only `policy?: { lockedKeys: string[]; origin: PolicyOrigin }`. **Do NOT** add to `IStoredConfig` or `extractStoredConfig` (`defaults.ts:449`). Populate it inside `applyPolicy` (or right after) so every `getConfig()` consumer sees it.
- [ ] `src/config/AgentConfig.ts:reload()` (`:109-119`) — after re-hydrate, `emitChangeEvent('config-changed', { reason: 'policy' })` (`:889`).

### 1.3 Server-config integration (pin)

- [ ] `src/server/config/server-config.ts:142-144` — between `ServerConfigSchema.parse(merged)` and `_config = parsed`: `_config = applyPolicy(parsed, getActivePolicySync(), 'server')`. Existing `onConfigReload` callbacks then deliver the pinned object unchanged — no new seam.

### 1.4 Do NOT modify (this phase)

- [ ] No platform sources, no `manifest.json`, no `chrome.storage.*`, no webfront, no remote fetcher, no `securityCheck`, no bootstrap source registration. Phase 1 is engine + pin + guards only, driven by a **stub `PolicySource`** in tests.

### 1.5 Tests (must prove the four-surface invariant)

- [ ] `src/core/config/policy/__tests__/applyPolicy.test.ts` — deep pin defeats a **one-level** `buildRuntimeConfig`-style merge for a *nested* locked key (`tools.sandboxPolicy.network_access`); arrays **replace**; non-locked policy values overlay; `ns` filtering (`server.*` ignored for `'agent'`).
- [ ] `src/core/config/policy/__tests__/PolicyResolver.test.ts` — first-non-empty-source-wins (lower sources ignored); `origin` recorded; empty/absent → `null`; `getActivePolicySync` returns last resolved.
- [ ] `src/config/__tests__/policy.integration.test.ts` — **the crux.** With a stub source locking `agent.approval.policy`: assert it is unchanged after (a) `buildRuntimeConfig`/`reload()`, (b) `updateConfig({approval:{policy:...}})` (and the strip is reported), (c) `setProviderApiKey` on a locked provider rejects, (d) `configSchema.resolve('approval.policy','write')` denies. Assert `config-changed` fires on `reload()`. Assert `getConfig().policy.lockedKeys` is populated and `extractStoredConfig` output contains **no** `policy`.
- [ ] Server: `server/config/__tests__/server-config.policy.test.ts` — locked `server.exec.approvalPolicy` survives `loadServerConfig()` and an `onConfigReload` cycle; env override of a locked key does not win.
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## Phase 2: platform-native sources + reload + UI lock

**Goal:** Real admin policy on every platform with hot-reload; locked fields
render non-editable. End-to-end on extension, desktop, and server (sans the
remote fleet path).
**Estimated size:** ~400 LOC + tests. **2 PRs** (2a sources+reload, 2b UI).
Depends on Phase 1.

### 2a — sources + reload + registration

- [ ] `src/extension/storage/ChromeManagedConfigSource.ts` — `PolicySource`, `origin:'chrome-managed'`, `load()` reads `chrome.storage.managed` (read-only) → `ResolvedPolicy`; `subscribe(cb)` registers a **net-new** `chrome.storage.onChanged` listener filtered to `area==='managed'`.
- [ ] `src/extension/manifest.json` — add `"managed_storage": "managed-schema.json"`; add `src/extension/managed-schema.json` (JSON Schema; all keys optional, additive). `scripts/build.js` — add `managed-schema.json` to the copied-files list (near `:175`) so it lands in `dist/`.
- [ ] `src/desktop/policy/ManagedFileSource.ts` (or `core/config/policy/ManagedFileSource.ts` if shared with server) — `origin:'file'`, reads the OS well-known path (`/Library/Application Support/ApplePi/managed-settings.json`, `%ProgramData%\ApplePi\managed-settings.json`, `/etc/applepi/managed-settings.json`). Desktop reload is **net-new**: a Tauri fs-watch command **or** a 60s poll → `resolveActivePolicy()` → `AgentConfig.reload()`. Pick one in the PR; do NOT claim `watchConfig` reuse.
- [ ] Server `ManagedFileSource` registration — a ConfigMap/Secret-mounted path (`APPLEPI_POLICY_PATH`, default `/etc/applepi/managed-settings.json`). **Reuse** the real `watchConfig`/`onConfigReload` (`server-config.ts:168-204`) to trigger `resolveActivePolicy()` + `AgentConfig.reload()` (the `ServerAgentBootstrap.ts:327-335` bridge already calls `handleConfigUpdate`/reload — extend it to re-resolve policy).
- [ ] **Source registration ordering** (must run before the first `buildRuntimeConfig`):
  - [ ] Extension `service-worker.ts` — `registerPolicySources([new ChromeManagedConfigSource()])` + `await resolveActivePolicy()` **between `:187` and `:211`**; add the `onChanged` subscribe wiring → `AgentConfig.reload()`.
  - [ ] Desktop `DesktopAgentBootstrap.ts` — register + resolve **before `:93`**; wire the chosen watch/poll → `reload()`.
  - [ ] Server `ServerAgentBootstrap.ts` — register `[RemotePolicySource(Phase 3), ManagedFileSource]` + resolve **before `:145`**; extend `:327-335` to re-resolve.
- [ ] Tests: stubbed `chrome.storage.managed`/managed file each resolve + report correct `origin`; `onChanged`/watch/`onConfigReload` each trigger a re-resolve + `reload()`; malformed managed JSON ⇒ source returns `null` (fail-open), extension still loads.

### 2b — UI managed-lock

- [ ] `src/webfront/.../policyLock.ts` (small helper) — `isLocked(path: string): boolean` bound to `getConfig().policy?.lockedKeys` (generalize claudy's `areSandboxSettingsLockedByPolicy` ad-hoc pattern into one reusable check).
- [ ] `src/webfront/settings/*` components (`GeneralSettings`, `ModelSettings`, `ApprovalSettings`, `ExtensionSettings`, `SecuritySettings`, `MCPSettings`, …) — for each input whose dot-path `isLocked(...)`: `disabled` + a "Managed by your organization" affordance (single shared snippet/component, Svelte 5 runes). Re-render on the `config-changed` event from Phase 1.6.
- [ ] Manual UI check (golden path + edge): extension sidepanel/popup + desktop window — a locked setting shows disabled + the managed label; unlock (policy removed → `204`-equiv / file deleted) re-enables after reload. Report explicitly if any surface can't be exercised.
- [ ] Tests: a component renders an input disabled iff its path is locked; toggling `policy.lockedKeys` + emitting `config-changed` flips the disabled state.

---

## Phase 3: remote fetcher + securityCheck

**Goal:** Fleet remote policy (server/desktop) + dangerous-change gating.
**Full track functionality end-to-end.**
**Estimated size:** ~450 LOC + tests. **2 PRs** (3a fetcher, 3b securityCheck).
Depends on Phases 1–2.

### 3a — shared remote fetcher (`src/core/config/remotePolicy/`)

- [ ] `src/core/config/remotePolicy/RemotePolicyFetcher.ts` — `computePolicyChecksum` (`sortKeysDeep → stable JSON → 'sha256:'+sha256`, recomputed from cache, never persisted); `fetchRemotePolicy({endpoint, authHeaders?, cachedChecksum?, timeoutMs=10_000})` with `If-None-Match: "<checksum>"`; status matrix `304→unchanged | 200→validate(zod)→updated | 204|404→cleared | auth→error{skipRetry} | net/timeout→error`.
- [ ] Cache via the existing `ConfigStorageProvider` (key `policy_cache`) — **not** a bespoke disk path. On error: stale cache if present else continue with no policy (**fail-open**, never hard-deny). `204|404` actively **clears** the cache (managed policy removed → locks released).
- [ ] `startPolicyPoll(intervalMs=3_600_000)` / `stopPolicyPoll()` — idempotent, non-process-blocking; first fetch non-blocking (resolve from cache immediately if present; bounded ≤30s startup wait). Eligibility = **policy endpoint configured** (`APPLEPI_POLICY_ENDPOINT` / server config); **no fetcher on the extension** (Chrome managed storage is its channel).
- [ ] `src/core/config/remotePolicy/RemotePolicySource.ts` — `PolicySource`, `origin:'remote'`, wraps the fetcher; registered as the **highest-precedence** server/desktop source (ahead of `ManagedFileSource`); `subscribe` driven by the poll diffing prev vs new (stable-JSON compare).
- [ ] Tests: full status matrix; fail-open uses stale cache; `204` clears + unlocks; checksum stable under key reordering; poll idempotency + start-after-first-fetch.

### 3b — securityCheck

- [ ] `src/core/config/policy/securityCheck.ts` — `assessPolicyChange(prev, next): { weakened: boolean; changedKeys: string[] }`. "Weakened" = BrowserX-domain: approval policy relaxed (`approval.policy` → `never`/disabled), tool permissions expanded, new allowlisted domains, sandbox network opened, credential changes. Only act when **weakened AND changed**.
- [ ] **Extension/desktop (interactive):** call `ApprovalManager.requestApproval({ type:'dangerous_action', riskLevel:'high', title, description, details })` (`core/ApprovalManager.ts:101`, via `RepublicAgent.getApprovalManager()` `:1166`). On **reject**: do NOT apply `next`; keep the previously-applied policy; continue running (**no `process.exit`** — that's claudy's CLI behavior).
- [ ] **Server (headless):** **never** call core `ApprovalManager` (fail-open hang, `:145-184`). Auto-apply + `emitLog('warn','managed policy applied',{origin,lockedKeys,changedKeys})` (`server/handlers/logs.ts:39`). **Redact secret-bearing values before the call** (`emitLog` does no redaction) — small in-track deny-by-shape redactor (api keys/tokens/JWT/URL-userinfo), or reuse Track 17's `redact` if it has landed (note which here).
- [ ] Wire `securityCheck` into the policy-apply path (after `resolveActivePolicy`, before `applyPolicy` commits a *changed* policy) on each platform; pass the interactive-vs-headless decision by platform, not by guesswork.
- [ ] Tests: ext/desktop reject ⇒ prior policy retained, process stays up; server ⇒ auto-applied + a **redacted** audit emitted (inject a fake `sk-…`; assert `***`); unchanged/strengthened policy ⇒ no prompt/audit.

### 3c — cross-track config-key contract (doc only, no code)

- [ ] In `design.md` (and the relevant Track 12/16 docs), record the exact policy keys Tracks 12/16 consume via normal config read (Track 12: `unattended` + the reset/max-wait cap from `withRetry.ts`; Track 16: privacy level) — they consume **config keys**, never the fetcher API. No code change to `withRetry.ts`.

---

## Phase 4: OS-MDM matrix (P3/L — separate, optional)

**Goal:** macOS plist / Windows registry / Linux `managed-settings.d/` as
additional `PolicySource` impls behind the same interface.
**Estimated size:** ~300 LOC (port claudy `mdm/rawRead.ts` pattern) + tests.
**1–2 PRs.** Independent; no change to Phase 1–3 contracts.

- [ ] `src/desktop/policy/mdm/` — macOS `plutil -convert json` read; Windows `reg query`; 5s subprocess timeout; first-source-wins; registered ahead of `ManagedFileSource` on desktop. `origin` extends to `'plist'|'hklm'`.
- [ ] Linux `managed-settings.d/` drop-in dir merge (deterministic order) feeding `ManagedFileSource`.
- [ ] Tests with mocked subprocess output; absent-tool fast path.

---

## Cross-cutting

- [ ] `.ai_design/agent_improvements/README.md` — verify/refresh the Track 20 row (effort **M**; Phase 4 **P3/L**) and the Dependency Graph: Phase 1 has **no hard deps**; Track 14 is a Phase 3 dep (ext/desktop only); Tracks 16/17 are degrade-gracefully forward-notes, not blockers; Track 12/18 are config-key consumers only.
- [ ] After each phase merges, update `design.md` **Status** and tick the corresponding section here. Re-run the Phase 0 `grep`s if the branch moved materially.
- [ ] Rename the dir to `20_managed_policy_settings_DONE` only after **all P1 phases (1–3)** merge; note in README which phases shipped (Phase 4 may trail; the `_DONE` suffix is unreliable, so be explicit).

---

## Deferred (NOT in this track — see design.md)

| Item | Why |
|------|-----|
| Anthropic-subscription eligibility analog | BrowserX has no such concept; eligibility = "policy endpoint configured". Revisit only if a billing/entitlement tier is introduced. |
| ConfigChange-style *blocking* hooks before apply | claudy lets hooks veto a change; BrowserX uses `securityCheck` + fail-open instead. Add later only if a consumer needs pre-apply veto. |
| Remote fetcher on the extension | Chrome managed storage is the extension's native channel; a remote fetcher there would duplicate it. Out of scope by design. |
| Track 16 redactor subsumption | When Track 16 lands, replace the in-track securityCheck redactor internals with its API (keep the signature so callers don't change). |
| Per-key policy *reason*/contact-admin metadata | UI shows a generic "Managed by your organization"; a per-key admin-contact string is a nice-to-have, not required for enforcement. |
