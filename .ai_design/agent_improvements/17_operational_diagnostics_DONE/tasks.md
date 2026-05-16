# Track 17 Tasks

> **Status (2026-05-15):** READY TO IMPLEMENT. Effort M. Four phases, each
> independently shippable as its own PR. **Phase 1+2 deliver the marquee
> K8s-probe win with zero unbuilt-track dependencies** — do these first.
> Phases 3–4 are additive surface/observability.

See [`design.md`](./design.md) for rationale, verified `file:line` seams,
the four corrected false premises, and Validation Notes.

---

## Phase 0: Pre-implementation verification (DO FIRST — gates the estimate)

The design was line-level verified on branch `agent-improvements` (2026-05-15).
Re-confirm before editing — the branch moves and these are load-bearing. Record
findings inline in this file.

- [ ] **Re-confirm the health gap.** `src/server/handlers/health.ts:83-85` still derives `status` from `_agentReady` only; `HealthStatus` shape unchanged (`:16-37`). `setHealthActiveRuns` (`:57`) still has zero callers (`grep -rn setHealthActiveRuns src/`). `HealthMonitor.refresh()` still hardcodes channels to `'connected'` (`health-monitor.ts:60-64`).
- [ ] **Re-confirm Track 16 absent.** `ls src/core/telemetry 2>/dev/null` → none; `grep -rn "redactConfig\|stripProtoFields\|AnalyticsSink" src/` → only `redactConfig` (2-field, `server-config.ts:238-247`). ⇒ in-track redactor required (decision 5). If Track 16 has since landed, swap the redactor for its API and note here.
- [ ] **Re-confirm Track 09 store inert.** `src/core/RepublicAgent.ts:74` still constructs `Session` with `services: undefined` (so `getToolResultStore()` is `undefined`). ⇒ heapdump writes via `getDataDir()` directly (decision 6). If Track 32 wired it, revisit Phase 4.
- [ ] **Re-confirm command path.** `grep -rln "from '@/core/commands'" src/ | grep -v __tests__` → none (typed surface still dead). Live path is `src/webfront/commands/{CommandRegistry,builtinCommands}.ts`. No `local-jsx`. Track 13 funnel still absent (`ls src/core/input 2>/dev/null`).
- [ ] **Confirm the service factory + wiring shape.** Read `src/core/services/skills-services.ts:37-45` and `src/core/services/index.ts:40-69`; confirm `ServiceHandler = (params, context) => Promise<unknown>` (`ServiceRegistry.ts:15-18`) and that `ServerAgentBootstrap.ts:408-412` is still where server passes deps. Confirm desktop (`DesktopAgentBootstrap`) + extension (`service-worker.ts`) also call `registerAllServices` — list the exact lines here.
- [ ] **Decide `DiagnosticsMonitor` interval.** Default 30s (design Risks). Confirm K8s readiness `periodSeconds`/`failureThreshold` expectations with the deploy owner; record the chosen interval here.

---

## Phase 1: `core/diagnostics` registry + redactor + 3 cross-platform checks

**Goal:** Pure `core/` diagnostic engine + redactor + the three checks whose
data sources exist on all platforms. No surface, no server wiring yet — fully
unit-testable in isolation.
**Estimated size:** ~250 LOC + tests. **Single PR.**

### 1.1 Types & registry

- [ ] `src/core/diagnostics/types.ts` — `DiagnosticStatus`, `DiagnosticPlatform`, `DiagnosticResult`, `DiagnosticContext`, `DiagnosticCheck`, `DoctorReport` exactly as in design.md "Phase 1". Module JSDoc header per house convention (`@module core/diagnostics/types`).
- [ ] `src/core/diagnostics/DiagnosticRegistry.ts` — module-singleton `_checks` Map; `registerDiagnosticCheck`, `getDiagnosticChecks`, `buildDoctorReport(ctx)` with `platforms.includes(ctx.platformId)` filter, per-check 3s `withTimeout` + `Promise.all` isolation, worst-severity rollup. Mirror the `core/*` module-singleton pattern (cf. `packages/ws-server/src/methods.ts` `_handlers`).
- [ ] `src/core/diagnostics/withTimeout.ts` (or reuse an existing util if one exists — `grep -rn "withTimeout\|pTimeout" src/core/utils src/utils`; do NOT add a dependency if one exists).

### 1.2 Redactor (in-track; Track 16 may subsume)

- [ ] `src/core/diagnostics/redact.ts` — `redactDoctorReport(r: DoctorReport): DoctorReport`. Pure, returns a deep clone. Deny-by-shape on `detail` and every string value in `data`: `sk-[A-Za-z0-9]{16,}`, `Bearer\s+\S+`, `(api[-_]?key|token|secret|password)["':=\s]+\S+`, `://[^/\s]+:[^@\s]+@` (URL userinfo), JWT `eyJ[\w-]+\.[\w-]+\.[\w-]+`. Replace with `'***'`. Leave the existing `'[SECURED]'` marker untouched (already safe). One function, no class — Track 16 can later re-export/replace it.
- [ ] Unit test `src/core/diagnostics/__tests__/redact.test.ts` — each pattern redacted in `detail` and nested `data`; `[SECURED]` preserved; clone (no input mutation).

### 1.3 Cross-platform checks (`platforms: ['extension','desktop','server']`)

Each reads the **`core/storage` singletons guarded by `is*Initialized()`** — NOT `IPlatformAdapter.get*Storage()` (those are stubs; verified).

- [ ] `src/core/diagnostics/checks/config-valid.ts` — `isConfigStorageInitialized()` guard → `AgentConfig.getInstance()` → `getConfig()` → `validateConfig()` (`src/config/validators.ts:30`). `fail` on invalid/absent, `detail` carries `ValidationResult.field/error` (will be redacted).
- [ ] `src/core/diagnostics/checks/credentials-present.ts` — `isCredentialStoreInitialized()` guard → for each provider in config, `agentConfig.getProviderApiKey(id)` non-null OR `provider.apiKey === '[SECURED]'`. Server-only sub-branch (`ctx.platformId === 'server'`): `!process.env.VITE_VAULT_SECRET` ⇒ `fail` (FileCredentialStore throws without it — `FileCredentialStore.ts:36-39`). Never put a key value in `detail`.
- [ ] `src/core/diagnostics/checks/channels-reachable.ts` — `ctx.channelManager?.getChannelInfo()` (`ChannelManager.getChannelInfo()` `:148`). `warn`/`fail` if zero channels where ≥1 expected. (This is the real check the faked `health-monitor.ts:60-64` map never did.)
- [ ] `src/core/diagnostics/index.ts` — barrel + `registerCoreDiagnosticChecks()` registering the three.

### 1.4 Do NOT modify (this phase)

- [ ] No edits to `src/server/handlers/health.ts`, `health-monitor.ts`, `src/core/services/*`, any bootstrap, or webfront. Phase 1 is engine-only.

### 1.5 Tests

- [ ] `src/core/diagnostics/__tests__/DiagnosticRegistry.test.ts` — platform filter (a `server`-only check excluded for `extension` ctx); a throwing check → `fail` result, others still run; a hanging check → timeout `fail` within ~3s; worst-severity rollup (pass/warn/fail combinations).
- [ ] One unit test per check with mocked `DiagnosticContext` (initialized vs uninitialized storage; valid vs invalid config; present vs missing creds incl. the server `VITE_VAULT_SECRET` branch; zero vs N channels).
- [ ] `npm run type-check && npm run lint && npm test` green.

---

## Phase 2: Server `diagnostics.report` service + truthful K8s probe

**Goal:** The marquee win. `GET /health` `status` becomes accurate (can return
`'error'`); full report served over an authenticated service on all platforms.
Shape-compatible — existing probes keep parsing.
**Estimated size:** ~150 LOC + tests. **Single PR.** Depends on Phase 1.

### 2.1 The service

- [ ] `src/core/services/diagnostics-services.ts` — `createDiagnosticsServices(deps: { buildCtx: () => DiagnosticContext })` → `{ 'diagnostics.report': async () => redactDoctorReport(await buildDoctorReport(deps.buildCtx())) }`. Match `skills-services.ts:37-45` factory shape exactly.
- [ ] `src/core/services/index.ts` — add `diagnostics?: DiagnosticsServiceDeps` to `AllServiceDeps` (`:24-33`); add `['diagnostics', createDiagnosticsServices]` to the factory list (`:46-55`); add the re-export (`:72-79`).

### 2.2 Per-platform deps wiring (one line each — auto-registers everywhere)

- [ ] `src/server/agent/ServerAgentBootstrap.ts:408-412` — pass `diagnostics: { buildCtx: () => ({ platformId:'server', agentConfig, mcpManager, skillRegistry, scheduler: this.scheduler, channelManager: getChannelManager() }) }` assembled from already-held singletons.
- [ ] Desktop bootstrap `registerAllServices(...)` call (line found in Phase 0) — same, `platformId:'desktop'`.
- [ ] Extension `service-worker.ts` `registerAllServices(...)` call (line found in Phase 0) — same, `platformId:'extension'` (omit `scheduler`/server-only handles it doesn't have; checks already tolerate `undefined`).
- [ ] Call `registerCoreDiagnosticChecks()` once per bootstrap before first report (next to where services are registered).

### 2.3 Cached status derivation (NOT synchronous in getHealthStatus)

- [ ] `src/server/handlers/health.ts` — add `let _diagnostics: DiagnosticStatus = 'pass'` + `export function setHealthDiagnostics(v: DiagnosticStatus): void`. Replace the derivation at `:83-85` with the 3-way from design.md decision 4 (`fail`→`'error'`, `!ready||warn`→`'degraded'`, else `'ok'`). Shape unchanged; only the value.
- [ ] `src/server/health/diagnostics-monitor.ts` — `DiagnosticsMonitor` class mirroring `HealthMonitor` (`start/stop/private refresh`, interval from Phase 0). `refresh()` → `buildDoctorReport(serverCtx)` → `setHealthDiagnostics(report.overall)`; defensive `try/catch` + `console.error('[DiagnosticsMonitor] …')` (never throw — match `HealthMonitor.refresh`).
- [ ] `src/server/agent/ServerAgentBootstrap.ts:282-283` — instantiate + `.start()` next to `HealthMonitor`; `.stop()` wherever `HealthMonitor` stops.

### 2.4 Security boundary (do NOT widen the unauthenticated route)

- [ ] `src/server/index.ts:101-108` — **no change.** `GET /health` keeps returning the same `HealthStatus` (now truthful `status`). The full `DoctorReport` is ONLY the authenticated `diagnostics.report` service. Add an explicit code comment at the route stating this boundary.

### 2.5 Tests

- [ ] `src/server/handlers/__tests__/health.diagnostics.test.ts` — `setHealthDiagnostics('fail')` ⇒ `status:'error'`; `'warn'` ⇒ `'degraded'`; `'pass'`+`_agentReady` ⇒ `'ok'`; `'pass'`+`!_agentReady` ⇒ `'degraded'`. `HealthStatus` shape byte-compatible (snapshot).
- [ ] `diagnostics-services.test.ts` — `diagnostics.report` returns a redacted report (inject a check emitting a fake `sk-…`; assert `'***'` in the service output).
- [ ] `DiagnosticsMonitor` test — refresh maps `overall` → `setHealthDiagnostics`; a throwing `buildDoctorReport` does not crash the monitor.
- [ ] `npm run type-check && npm run lint && npm test` green; existing health/HealthMonitor tests stay green.

---

## Phase 3: `/doctor` command + view; deeper checks; monitor fold-in

**Goal:** User-facing self-diagnosis on extension/desktop + the remaining
checks + retire the faked channel state.
**Estimated size:** ~300 LOC + tests. **1–2 PRs** (3a command+view, 3b checks).
Depends on Phase 1 (+ Phase 2 for the service).

### 3a — command + view

- [ ] `src/core/skills/SkillRegistry.ts:7` — add `'doctor'` to `RESERVED_COMMAND_NAMES` (prevents a skill shadowing the builtin).
- [ ] `src/webfront/commands/builtinCommands.ts` — add `onOpenDoctor: () => void` to `BuiltinCommandCallbacks` (`:5-9`); register a `doctor` command following the `settings` block (`:47-54`), `action: () => activeCallbacks?.onOpenDoctor()`.
- [ ] `src/webfront/components/.../MessageInput.svelte` `ensureBuiltins()` — wire `onOpenDoctor: () => push('/doctor')` (mirror `onOpenSettings`).
- [ ] `src/webfront/App.svelte` routes (`:28-46`) — add `'/doctor': Doctor,` + the import.
- [ ] `src/webfront/pages/diagnostics/Doctor.svelte` — structurally modeled on `pages/settings/Settings.svelte` (header + close → `push('/')`, `onMount` loader, terminal/`.modern` theme block). `onMount`: `getInitializedUIClient()` → `serviceRequest<DoctorReport>('diagnostics.report')`. Render a discrete pass/warn/fail panel (claudy `Doctor.tsx` pattern, Svelte): green/yellow/red per `status`, `detail` line each, overall banner. Loading + error states.
- [ ] Manual UI check (golden path + edge): extension popup + sidepanel + desktop window — `/doctor` opens the view, shows pass/warn/fail, close returns to chat. Report explicitly if any surface can't be exercised.

### 3b — deeper checks + HealthMonitor fold-in

- [ ] `src/core/diagnostics/checks/mcp-connected.ts` — `ctx.mcpManager` `getConnections()` vs `getServers()`; `fail` per `status==='error'` (carry redacted `lastError`); `warn` if connected < enabled.
- [ ] `src/core/diagnostics/checks/skills-loaded.ts` — `ctx.skillRegistry.getAllSkillMetas()`; dedupe by `name` ⇒ collision `warn`; optional cheap per-file `validateSkill`.
- [ ] `src/core/diagnostics/checks/scheduler-health.ts` — `ctx.scheduler.getSchedulerState()`; `fail` on `isPaused` (unexpected) or `missedCount>0`; `warn` on growing `jobQueueCount`. `platforms` = all three (Scheduler is `core/`).
- [ ] Register the three in `registerCoreDiagnosticChecks()`.
- [ ] `src/server/health/health-monitor.ts:55-82` — replace the hardcoded `channelEntries[...]='connected'` (`:60-64`) with real state derived from the `channels-reachable` data. Remove dead `setHealthActiveRuns` OR wire `_activeRuns` from `AgentRegistry.listSessions()` (pick one; note which in the PR).
- [ ] Tests for the three new checks (mocked ctx); a HealthMonitor test asserting channels reflect real info, not a constant.

---

## Phase 4: Heapdump (server, node-only)

**Goal:** On-demand heap snapshot + leak heuristics for the long-lived server.
**Estimated size:** ~250 LOC (port) + tests. **Single PR.** Server-only.

- [ ] `src/server/diagnostics/heapdump.ts` — port claudy `captureMemoryDiagnostics` + `performHeapDump` + `potentialLeaks[]` heuristic. Keep the **diagnostics-JSON-written-before-snapshot** ordering (snapshot can OOM). Write to `{getDataDir()}/diagnostics/{sessionId}-{ISO-ts}.heapsnapshot` + `-diagnostics.json` (`server-config.ts:161`). NOT `~/Desktop`, NOT `getToolResultStore()` (inert). Import is naturally server-only (file lives under `src/server/`); if any shared module references it, gate that import on `__BUILD_MODE__==='server'`.
- [ ] `src/core/services/diagnostics-services.ts` — add `'diagnostics.heapdump'` (server deps only) → returns `{ heapPath, diagPath }`. Run the diagnostics-JSON summary through the redactor primitive before logging.
- [ ] Surface the artifact: `emitLog('info','heapdump written',{ artifact:{ kind:'heapdump', path } })` so `logs.tail` (admin) subscribers see it (`logs.ts:39`).
- [ ] Test: heapdump writes both files under `getDataDir()`; diagnostics JSON present even if snapshot mocked to throw (ordering); leak heuristic flags a synthetic high-handle/detached-context fixture.

---

## Cross-cutting

- [ ] `.ai_design/agent_improvements/README.md` — verify/refresh the Track 17 row (line ~41; effort is **M**, not "Small–Medium") and add Track 17 to the Dependency Graph (depends on nothing hard for Phase 1+2; Phase 3 needs the live `webfront/commands` path which exists today; note Track 13/16 are forward-notes, not blockers).
- [ ] After each phase merges, update `design.md` Status and tick the corresponding section here.
- [ ] Rename the track dir to `17_operational_diagnostics_DONE` only after **all four phases** merge (per the `_DONE`-suffix convention — and note in README which phases shipped, given the suffix-is-unreliable lesson).

---

## Deferred (NOT in this track — see design.md)

| Item | Why |
|------|-----|
| Desktop heapdump | Desktop has node via the Tauri sidecar, but Phase 4 ships server-only to bound scope. Follow-up: a desktop variant writing via the desktop storage path. |
| `DiagnosticCheckFailed` `EventMsg` variant + hook emission | Optional observability; not required by any phase. Add later alongside Track 01 hook events if a consumer needs it. |
| Admin `health` WS-event carrying the full report | `HealthMonitor` broadcast could carry the redacted report to admin conns. Nice-to-have; the authenticated `diagnostics.report` service already covers the need. |
| Track 16 redactor subsumption | When Track 16 lands, replace `core/diagnostics/redact.ts` internals with its API (keep the function signature so callers don't change). |
| `/status`-style reused view | Claudy's `/status` reuses Settings' Status tab; browserx has no such tab. Out of scope — `/doctor` is the single surface. |
