# Track 19: Versioned Migration Framework

**Priority: P1** · **Effort: S** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's migration runner and browserx's config init — see "Validation Notes". Smallest effort / highest de-risking leverage of the second-pass set.

## Problem

BrowserX has **no versioned migration framework**. The only migration is `AgentConfig.migrateApprovalConfig()` — un-versioned, **runs on every `initialize()`**, **extension-only** (`__BUILD_MODE__==='extension'`), a single hardcoded legacy-key move. `IndexedDBAdapter.onupgradeneeded` handles DB *structure* (`DB_VERSION=5`) but not config/settings *data* schema. Every future rename/restructure must be hand-wired and re-runs forever.

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

Called once at startup (`main.tsx:950`). Each migration (`src/migrations/*.ts`, e.g. `migrateSonnet45ToSonnet46.ts`) is a plain **idempotent** function: early-returns when not applicable (provider/subscriber/value guards), reads a *specific* settings source (`getSettingsForSource('userSettings')` — not merged), writes via `updateSettingsForSource` **only if** the old value matches, emits a `logEvent`. Pattern: **version-gated batch · idempotent · ordered · analytics-instrumented · sync set + async fire-and-forget · race-guarded stamp**.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Only migration | `AgentConfig.migrateApprovalConfig()` (`config/AgentConfig.ts:183-199`), called from `initialize()` (`:74-78`) | Un-versioned, **every load**, extension-only, non-fatal try/catch |
| Config store | `AgentConfig` over `ConfigStorageProvider` (extension) / file (desktop/server); `buildRuntimeConfig`/`extractStoredConfig` (`:80-89`) | Where a `migrationVersion` counter belongs |
| DB structure | `IndexedDBAdapter` `DB_VERSION=5`, `onupgradeneeded` (`storage/IndexedDBAdapter.ts:24,168`) | **Different layer** — DB schema, not config data; leave as-is |
| Bootstrap | `DesktopAgentBootstrap.ts` / `ServerAgentBootstrap.ts` (+ extension background) call `AgentConfig.getInstance()`/`initialize()` | The run-once seam, after config load |

### Key design decisions (and divergences from claudy)

1. **`core/migrations/`: ordered registry + version counter, run once per bump.** `Migration { version:number; name:string; platforms?:BuildMode[]; run(): Promise<void>|void }`. `runMigrations()` reads `migrationVersion` from the config store; if behind `CURRENT`, runs the ordered list whose `version > stored`, then stamps with claudy's exact race guard (`stored===CURRENT ? prev : {...prev, migrationVersion:CURRENT}`).

2. **Absorb `migrateApprovalConfig` as migration #1.** Concrete, verified change: move the body out of `AgentConfig.ts:183-199`, register it as `{version:1, name:'approval_config', platforms:['extension']}`, and delete the unconditional `await this.migrateApprovalConfig()` call at `AgentConfig.ts:77`. It stops running every load — the single biggest immediate win.

3. **Per-migration try/catch + telemetry (improvement over claudy).** claudy's runner does *not* wrap each sync migration (only the async one `.catch()`s). BrowserX's existing `migrateApprovalConfig` already uses a non-fatal try/catch (`AgentConfig.ts:198`) — make that the framework norm: each migration wrapped, a throw is logged via Track 16 + skipped, never blocks bootstrap. Async/transient migrations are fire-and-forget with retry-next-startup (claudy's `migrateChangelogFromConfig` pattern).

4. **Platform-aware (net-new vs claudy).** claudy has one global config file. BrowserX spans extension (`ConfigStorageProvider`/IndexedDB) and desktop/server (file/Tauri). Each `Migration` declares `platforms`; the runner filters by `__BUILD_MODE__` (already the gating mechanism `migrateApprovalConfig` uses at `AgentConfig.ts:76`). The `migrationVersion` counter lives in the config store, so it is naturally per-platform.

5. **Distinct from `IndexedDBAdapter.onupgradeneeded` — state it explicitly.** That handles object-store *structure* at `DB_VERSION`. This framework migrates *config/settings data* shape. Two layers, two version counters, no coupling — documented so they are never conflated.

6. **Run at the bootstrap seam, after config init, before first use.** claudy runs at `main.tsx:950`. BrowserX analog: invoke `runMigrations()` from `DesktopAgentBootstrap`/`ServerAgentBootstrap` (and the extension background bootstrap) right after `AgentConfig.initialize()` resolves, before any consumer reads config.

### Phase plan

- **Phase 1:** `core/migrations/` framework (registry + `Migration` type + version-gated `runMigrations` + race-guarded stamp); wire into the three bootstraps after config init.
- **Phase 2:** port `migrateApprovalConfig` → registered migration #1; remove the every-load call at `AgentConfig.ts:77`.
- **Phase 3:** per-migration try/catch + Track 16 telemetry; async/retry-next-startup support.

## Dependencies

- **Track 16** (Telemetry): per-migration success/failure events (claudy instruments every migration)
- Existing `AgentConfig`/`ConfigStorageProvider` + the three bootstrap classes (run seam)
- No dependency on `IndexedDBAdapter` (explicitly separate layer)

## Risks

- Order vs config readiness: run strictly after `AgentConfig.initialize()` resolves and before first consumer read — the bootstrap seam guarantees this; tests must assert ordering.
- Cross-platform store differences: migrations read/write via the existing config/storage adapter only; `platforms` gating prevents an extension-only migration touching desktop config.
- A bad migration shipped widely: per-migration try/catch + idempotency + Track 16 telemetry contain blast radius; keep each migration tiny and reviewed (claudy's migrations are ~30–60 lines, single-purpose, guard-heavy).
- Don't reintroduce every-load behavior: the version gate is the whole point — `migrateApprovalConfig` becoming version-gated is the regression test.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `main.tsx:325-352` (`CURRENT_MIGRATION_VERSION=11`, `runMigrations` ordered list, race-guarded stamp, async fire-and-forget), `:950` (startup call); `migrations/migrateSonnet45ToSonnet46.ts` (idempotent guard-heavy single-purpose migration, `getSettingsForSource('userSettings')` specific-source read, `logEvent` instrumentation); `migrations/` (11 single-purpose files, 614 LOC total).
- browserx: `config/AgentConfig.ts:69-89` (`initialize()`), `:74-78` (unconditional extension-only `migrateApprovalConfig` call — to be removed), `:183-199` (the migration body, non-fatal try/catch at `:198`); `storage/IndexedDBAdapter.ts:24,145,168` (`DB_VERSION=5`, `onupgradeneeded` — separate DB-structure layer); `desktop/agent/DesktopAgentBootstrap.ts`, `server/agent/ServerAgentBootstrap.ts` (bootstrap run seam).

Corrections vs the first-pass draft:
1. Pinned the exact seam: `migrateApprovalConfig` is called unconditionally at `AgentConfig.ts:77` on **every** `initialize()` and is **extension-only** — Phase 2 is a concrete "move body to migration #1, delete line 77," not a vague "absorb it."
2. claudy's runner does **not** per-wrap sync migrations; browserx should (and already does for `migrateApprovalConfig`) — framed as a deliberate improvement consistent with existing browserx practice, not a claudy port.
3. Explicitly separated this framework from `IndexedDBAdapter.onupgradeneeded` (`DB_VERSION`) — different layer, different counter; the draft risked conflating "schema migration" with the IndexedDB structural upgrade.
4. Run seam is the bootstrap classes (no `main.tsx` equivalent in browserx), after `AgentConfig.initialize()`.
