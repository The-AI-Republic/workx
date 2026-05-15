# Track 19: Versioned Migration Framework

**Priority: P1** · **Effort: S** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's migration runner and browserx's config init across all three deploy targets — see "Validation Notes". Smallest effort / highest de-risking leverage of the second-pass set.

## Problem

BrowserX has **no versioned migration framework**. The only migration is `AgentConfig.migrateApprovalConfig()` — un-versioned, **runs on every `initialize()`**, **extension-only** (`AgentConfig.ts:76` `__BUILD_MODE__==='extension'` → `:77` unconditional call), a single hardcoded legacy-key move (body `:183-199`). `IndexedDBAdapter.onupgradeneeded` handles DB *structure* (`DB_VERSION=5`) but not config/settings *data* schema. Every future rename/restructure must be hand-wired and re-runs forever.

## What Claudy Does

`main.tsx:325-352`:

```ts
const CURRENT_MIGRATION_VERSION = 11;
function runMigrations(): void {
  if (getGlobalConfig().migrationVersion !== CURRENT_MIGRATION_VERSION) {
    migrateAutoUpdatesToSettings();
    migrateBypassPermissionsAcceptedToSettings();
    /* …ordered list… */
    if (feature('TRANSCRIPT_CLASSIFIER')) resetAutoModeOptInForDefaultOffer();
    if ("external" === 'ant') migrateFennecToOpus();
    saveGlobalConfig(prev =>
      prev.migrationVersion === CURRENT_MIGRATION_VERSION ? prev
      : { ...prev, migrationVersion: CURRENT_MIGRATION_VERSION });   // race-guarded stamp
  }
  migrateChangelogFromConfig().catch(() => {});   // async, fire-and-forget, retry next startup
}
```

Called once at startup (`main.tsx:950`). Each migration (`src/migrations/*.ts`) is a plain **idempotent** function: early-returns when not applicable, reads a *specific* settings source (`getSettingsForSource('userSettings')` — not merged), writes via `updateSettingsForSource` **only if** the old value matches, emits a `logEvent`. Pattern: **version-gated batch · idempotent · ordered · analytics-instrumented · sync set + async fire-and-forget · race-guarded stamp**.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Only migration | `AgentConfig.migrateApprovalConfig()` (`config/AgentConfig.ts:183-199`), called from `initialize()` (`:69`, gate `:76`, call `:77`) | Un-versioned, **every load**, extension-only, non-fatal try/catch (`:198`) |
| Config store | `AgentConfig` over `ConfigStorageProvider` (extension) / `FileConfigStorageProvider` (desktop/server) | Where a `migrationVersion` counter belongs |
| DB structure | `IndexedDBAdapter` `DB_VERSION=5`, `onupgradeneeded` (`storage/IndexedDBAdapter.ts:24,168`) | **Different layer** — leave as-is |
| Bootstrap (ext) | extension background service worker → `AgentConfig.getInstance()` | run-once seam |
| Bootstrap (desktop) | `DesktopAgentBootstrap.initialize()` (`:83`), `AgentConfig.getInstance()` (`:93`) | run-once seam, after `:93` |
| Bootstrap (server) | `ServerAgentBootstrap.initialize()`: `setConfigStorage(new FileConfigStorageProvider(dataDir))` (`:141`) → `AgentConfig.getInstance()` (`:144`); `watchConfig`/`onConfigReload` (`:322-329`) | run-once seam between `:144` and `:148` |

### Per-Platform Behavior

The framework is **one core module**; the `migrationVersion` counter lives in the config store so it is naturally per-platform. What differs is the storage backend, the run seam, and one headless-only hazard.

- **BrowserX (extension, MV3).** Config in `ConfigStorageProvider`/IndexedDB. Run seam: the extension background bootstrap after `AgentConfig.getInstance()`. The MV3 service worker restarts frequently, so claudy's "async migration fire-and-forget, retry next startup" pattern works *especially well* here — a transient/async migration that doesn't finish before SW eviction simply completes on the next wake. Migration #1 (`migrateApprovalConfig`) stays `platforms:['extension']` (it is extension-only today).
- **Apple Pi (desktop, Tauri).** Config in `FileConfigStorageProvider`. Run seam: `DesktopAgentBootstrap.initialize()` immediately after `AgentConfig.getInstance()` (`:93`). Single long-lived process → both sync and async migrations complete reliably; no concurrency concern.
- **Apple Pi Server (headless, Docker/K8s).** Config in `FileConfigStorageProvider(dataDir)` (`ServerAgentBootstrap.ts:141`). Run seam: between `AgentConfig.getInstance()` (`:144`) and `configurePrompt()` (`:148`), before `AgentRegistry`/any consumer. **New headless-only hazard:** K8s commonly runs *multiple replicas against a shared `APPLEPI_DATA_DIR` volume*. claudy's race-guarded stamp (`prev.migrationVersion===CURRENT ? prev : …`) only protects single-process re-entry — it does **not** protect concurrent processes mutating the same config file. Two replicas booting together can double-run a migration or interleave-corrupt the stamp. Mitigation (see Decision 6): an advisory file-lock around `runMigrations()` on file-backed stores, OR a documented "migrations run before scale-out / on a single designated migrator" operational constraint. Additionally, `runMigrations()` must complete before `watchConfig()` starts (`:322`) so the hot-reload watcher does not observe a half-migrated file.

### Key design decisions (and divergences from claudy)

1. **`core/migrations/`: ordered registry + version counter, run once per bump.** `Migration { version:number; name:string; platforms?:BuildMode[]; run(): Promise<void>|void }`. `runMigrations()` reads `migrationVersion` from the config store; if behind `CURRENT`, runs the ordered list whose `version > stored`, then stamps with claudy's exact race guard.
2. **Absorb `migrateApprovalConfig` as migration #1.** Concrete verified change: move the body out of `AgentConfig.ts:183-199`, register `{version:1, name:'approval_config', platforms:['extension']}`, delete the unconditional `await this.migrateApprovalConfig()` at `AgentConfig.ts:77` (and the surrounding `:76` gate). It stops running every load — the single biggest immediate win.
3. **Per-migration try/catch + telemetry (improvement over claudy).** claudy does not per-wrap sync migrations; browserx's existing `migrateApprovalConfig` already uses non-fatal try/catch (`:198`) — make that the framework norm: each migration wrapped, a throw logged via Track 16 + skipped, never blocks bootstrap. Async/transient migrations fire-and-forget with retry-next-startup (claudy's `migrateChangelogFromConfig` pattern — best-suited to the extension's frequent SW restarts).
4. **Platform-aware via `__BUILD_MODE__` (net-new vs claudy) — and this is the *correct* gate here.** Each `Migration` declares `platforms`; the runner filters by `__BUILD_MODE__` (the mechanism `migrateApprovalConfig` already uses at `AgentConfig.ts:76`). Unlike Track 13 (where browser capability is runtime-dynamic and must gate on `IPlatformAdapter` flags), a migration's relevant fact — *which config-store backend exists* — is fixed at build time, so `__BUILD_MODE__` is the right, simplest discriminator. Consistent reasoning, not a contradiction of Track 13.
5. **Distinct from `IndexedDBAdapter.onupgradeneeded` — state it explicitly.** That handles object-store *structure* at `DB_VERSION`. This framework migrates *config/settings data* shape. Two layers, two counters, no coupling.
6. **Run at the bootstrap seam, after config init, before first use — with a concurrency guard on file-backed stores.** Invoke `runMigrations()` from the extension background bootstrap / `DesktopAgentBootstrap` / `ServerAgentBootstrap` right after `AgentConfig` resolves. **Divergence from claudy (headless):** on file-backed stores (desktop/server) wrap the run + stamp in an advisory file-lock so a multi-replica server cannot double-run; document the single-migrator operational fallback. claudy is single-process and needs no such guard.

## Implementation Plan (file-level, ordered)

**Phase 1 — framework + run seams.**
- `core/migrations/types.ts` (`Migration` interface, `BuildMode`); `core/migrations/registry.ts` (ordered list, `CURRENT_MIGRATION_VERSION`); `core/migrations/runMigrations.ts` (version gate, `__BUILD_MODE__` platform filter, claudy race-guarded stamp, per-migration try/catch).
- Wire `runMigrations()` into: extension background bootstrap (after `AgentConfig.getInstance()`), `DesktopAgentBootstrap.initialize()` (after `:93`), `ServerAgentBootstrap.initialize()` (between `:144` and `:148`, before `watchConfig` `:322`).
- File-backed concurrency guard: an advisory lock helper used by the desktop/server run seam only (no-op on extension/IndexedDB).

**Phase 2 — migration #1.**
- Move `migrateApprovalConfig` body (`AgentConfig.ts:183-199`) into `core/migrations/m001_approval_config.ts`; register `{version:1,platforms:['extension']}`; delete `AgentConfig.ts:76-77`. Regression test: it runs at most once and not on subsequent `initialize()`.

**Phase 3 — resilience.**
- Per-migration Track 16 success/failure telemetry; async/retry-next-startup support (`.catch()` fire-and-forget) for transient migrations.

## Dependencies

- **Track 16** (Telemetry): per-migration success/failure events (claudy instruments every migration).
- Existing `AgentConfig`/`ConfigStorageProvider` + the three bootstrap classes (run seam).
- No dependency on `IndexedDBAdapter` (explicitly separate layer).

## Risks

- Order vs config readiness: run strictly after `AgentConfig` resolves and before first consumer read / before server `watchConfig` — bootstrap seam guarantees this; tests assert ordering.
- **Multi-replica server race (headless-only):** shared `APPLEPI_DATA_DIR` + concurrent boots → advisory file-lock around run+stamp, or documented single-migrator constraint; this is the one risk claudy's single-process model never faced.
- Cross-platform store differences: migrations read/write via the existing config/storage adapter only; `platforms` gating prevents an extension-only migration touching desktop/server config.
- A bad migration shipped widely: per-migration try/catch + idempotency + Track 16 telemetry contain blast radius; keep each migration tiny and guard-heavy (claudy's are ~30–60 lines).
- Don't reintroduce every-load behavior: the version gate is the point — `migrateApprovalConfig` becoming version-gated is the regression test.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `main.tsx:325-352,950`; `migrations/migrateSonnet45ToSonnet46.ts`; `migrations/` (11 single-purpose files, 614 LOC).
- browserx core: `config/AgentConfig.ts:69` (`initialize`), `:76` (`__BUILD_MODE__` gate), `:77` (unconditional call — delete), `:183-199` (body, non-fatal catch `:198`); `storage/IndexedDBAdapter.ts:24,145,168` (separate DB-structure layer).
- browserx platforms: `src/desktop/agent/DesktopAgentBootstrap.ts:83,93` (run seam after `AgentConfig.getInstance()`); `src/server/agent/ServerAgentBootstrap.ts:141` (`FileConfigStorageProvider(dataDir)`), `:144` (`AgentConfig.getInstance()`), `:148` (`configurePrompt`), `:322-329` (`watchConfig`/`onConfigReload` — must run after migrations); extension background bootstrap (`AgentConfig.getInstance()` seam).

Corrections vs the first-pass draft:
1. Pinned the exact seam: `migrateApprovalConfig` is called unconditionally at `AgentConfig.ts:77` (gate `:76`) on **every** `initialize()`, extension-only — Phase 2 is concrete "move body, delete `:76-77`."
2. claudy's runner does **not** per-wrap sync migrations; browserx should (and already does for `migrateApprovalConfig`) — a deliberate improvement.
3. Explicitly separated from `IndexedDBAdapter.onupgradeneeded` (`DB_VERSION`).
4. Run seam is the three bootstrap classes (no `main.tsx` in browserx), after `AgentConfig` resolves.
5. **Multi-platform (2026-05-15):** added the headless-only multi-replica shared-volume race + advisory-lock/single-migrator mitigation (claudy's single-process stamp guard is insufficient there); pinned the exact server seam (`:144`→`:148`, before `watchConfig` `:322`); justified `__BUILD_MODE__` as the *correct* gate for this track (config-store backend is build-fixed) in deliberate contrast to Track 13's dynamic-capability gating.
