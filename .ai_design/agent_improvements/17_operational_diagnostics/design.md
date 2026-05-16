# Track 17: Operational Diagnostics

**Priority: P1** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: third-pass claudy↔browserx research (2026-05-15), full implementation-readiness pass. Grounded in a complete read of claudy's `doctor`/`status`/`heapdump` surface AND a verified, line-level read of browserx's health subsystem, command/service transport, platform adapter, and the four dependency tracks across all three deploy targets. **This revision corrects four false premises in the prior draft** (Tracks 16/13 do not exist in code; Track 07's central store was not built; Track 09's artifact store is inert in shipped builds) — see "Validation Notes & Corrections". Incremental, not greenfield: the health primitives exist; the diagnostics layer does not.

## Problem

BrowserX has good server-mode health *primitives* but no unified, user-invokable, cross-platform self-diagnosis, and its one health signal is a lie.

`getHealthStatus()` (`src/server/handlers/health.ts:79-109`) returns a rich `HealthStatus` whose `status` field is typed `'ok' | 'degraded' | 'error'` (`health.ts:17`) but **derived solely from a single binary flag** (`health.ts:83-85`):

```ts
const status: HealthStatus['status'] = _agentReady ? 'ok' : 'degraded';
```

`_agentReady` is one module-level boolean set once at bootstrap (`ServerAgentBootstrap.ts:290`). The consequences, all verified in code:

- `status` **never returns `'error'`** — that arm of the type union is dead. No code path produces it.
- It validates nothing: not config, credentials, channels, MCP, skills, or the scheduler.
- The `channels` map is **fake**: `HealthMonitor.refresh()` hardcodes every channel to `'connected'` (`health-monitor.ts:60-64`) — a dead channel still reports connected.
- `agent.activeRuns` is permanently `0` (`setHealthActiveRuns` has zero callers — dead code, `health.ts:57`); `agent.model` is permanently `undefined` (the 2-arg `setHealthAgentStatus(ready, model?)` is only ever called with one arg, `ServerAgentBootstrap.ts:290`).
- There is no `/doctor`-style command anywhere (grep: zero `doctor`/`DiagnosticRegistry`/`DoctorReport` symbols in `src/`).
- There is no on-demand heapdump.

**Operationally this bites hardest on Apple Pi Server.** `GET /health` (`src/server/index.ts:101-108`, the *only* HTTP route, **unauthenticated**) is the conventional Docker/K8s liveness/readiness probe target. Because `status` is `'ok'` whenever the agent object loaded, a container with expired credentials, a dead MCP, or an unreachable channel **reports healthy forever** — K8s never depools or restarts it, and it silently serves broken responses. The fix that matters most is making that one enum value *true*.

## What Claudy Does

Verified by reading claudy source at `/home/rich/dev/study/claudy/src`:

- **`/doctor`** (`commands/doctor/index.ts`, 14 lines) — a `type:'local-jsx'` command, lazy-loaded (`load: () => import('./doctor.js')`), env-gated (`DISABLE_DOCTOR_COMMAND`). `doctor.tsx` renders `<Doctor onDone={onDone}/>` and nothing else.
- **The check engine** (`utils/doctorDiagnostic.ts`, 626 lines) — `getDoctorDiagnostic()` runs **discrete, independent check functions** (`getCurrentInstallationType`, `detectMultipleInstallations`, `detectConfigurationIssues`, `detectLinuxGlobPatternWarnings`, ripgrep/update-permission probes) and aggregates them into one `DiagnosticInfo`. Each check emits a uniform `{ issue, fix }` shape. There is **no formal registry/class** — just functions appended to a `warnings[]` array. *Claudy's checks are entirely local install/config hygiene; none are runtime health, because claudy is a local CLI with no server.*
- **The panel** (`screens/Doctor.tsx`, 575 lines) — an Ink component that pulls `getDoctorDiagnostic()` plus *several other independent sources* (`checkContextWarnings`, settings errors, plugin errors, agent parse errors, MCP/keybinding widgets) and **merges them at the view layer** into a flat scrolling pass/warn/fail panel.
- **`/status`** (`commands/status/index.ts`) — `local-jsx`, `immediate:true`; renders the existing Settings component at its "Status" tab. A *reused view*, not a second engine.
- **`/heapdump`** → `utils/heapDumpService.ts` (304 lines) — `performHeapDump()` calls `captureMemoryDiagnostics()` (`process.memoryUsage`, `v8.getHeapStatistics/getHeapSpaceStatistics`, `process.resourceUsage`, `_getActiveHandles/_getActiveRequests`, `/proc/self/fd`, `/proc/self/smaps_rollup`), runs a **threshold leak heuristic** (`potentialLeaks[]`), writes diagnostics JSON **first** (cheap, won't OOM) then the `.heapsnapshot` (can OOM on huge heaps) to `~/Desktop`, with a Bun/Node split.

**Pattern to port:** discrete checks → one aggregate → shared view; status is a reused view; heapdump is a node-only side service with leak heuristics and ordered writes. **What does NOT port:** the *checks themselves* (claudy = install hygiene; browserx = runtime operational health), the Ink rendering, and `~/Desktop`. The "DiagnosticRegistry" below is a deliberate *improvement* over claudy's view-layer merge — browserx is multi-platform and needs runtime applicability filtering claudy never needed.

## BrowserX Mapping (verified seams)

### Health primitives — exist, server-only, binary

| Concern | BrowserX location (verified) | State |
|---|---|---|
| Health snapshot | `HealthStatus` + `getHealthStatus()` `src/server/handlers/health.ts:16-37,79-109` | Good shape; `status` from `_agentReady` only (`:83-85`); never `'error'` |
| Push setters | `setHealth*()` `health.ts:48-72` | `setHealthActiveRuns` dead; `_agentModel` always `undefined` |
| WS transport | `registerHealthHandlers()` → `registerMethodHandler('health', …)` `health.ts:115-124` (an `@applepi/ws-server` **method**, scope `admin`, `packages/ws-server/src/methods.ts:59`) | Reuse |
| HTTP transport | `GET /health` `src/server/index.ts:101-108` — only route, **unauthenticated** | Reuse; do NOT leak full report here |
| Periodic broadcast | `HealthMonitor` 60s `refresh()` → `makeEvent('health',status)` to authenticated `admin` conns `src/server/health/health-monitor.ts:19,25-83` | Server-only; channels map is fake (`:60-64`) |
| Log/artifact stream | `installStructuredLogging()`→`emitLog(level,msg,data?)`→`logs.tail` `src/server/health/log-streamer.ts:16`, `src/server/handlers/logs.ts:39-88` | Reuse `data?` for heapdump ref; **no redaction applied here** |
| Cross-platform RPC | `ServiceRegistry` + `registerAllServices(registry, deps)` `src/core/channels/ServiceRegistry.ts:15-18`, `src/core/services/index.ts:40-69` | The seam for a `diagnostics.*` service |
| Platform discriminator | `IPlatformAdapter.platformId: 'extension'|'desktop'|'server'` `src/core/platform/IPlatformAdapter.ts:60` (runtime); `__BUILD_MODE__` `src/types/globals.d.ts:14` (compile-time, +`'mobile'`) | Runtime filter vs. tree-shake gate — see decision 3 |

### Per-platform behavior

One `core/diagnostics` registry; each check declares `platforms`. What differs is the *check set*, the *surface*, and the *operational consequence*.

- **Extension (MV3).** No fs / node `v8` / `~/Desktop`. Checks: config validity (`ChromeConfigStorage`), credentials present, MCP (`MCPClient` SSE) connected, skills loaded + collisions, channels reachable, scheduler health. **No heapdump.** Surface: `/doctor` builtin command → `push('/doctor')` → shared `Doctor.svelte` route (popup/sidepanel render the same `App.svelte`). Consequence: self-service "why is my extension misbehaving."
- **Apple Pi (desktop, Tauri).** Node-capable via the Tauri sidecar. Same check set; same shared `Doctor.svelte`. Heapdump is a **follow-up** (desktop has node, but Phase 4 ships server-only to bound scope). Consequence: local troubleshooting.
- **Apple Pi Server (headless, Docker/K8s).** Richest, highest-value. Full check set incl. `FileConfigStorageProvider`/`FileCredentialStore`/`VITE_VAULT_SECRET`, `NodeMCPBridge` (via `MCPManager`), `ServerScheduler`. No Svelte; the report rides the new `diagnostics.report` service (authenticated) and a *truthful* `GET /health` `status` enum (unauthenticated, status-only). **Key win:** the truthful enum makes the K8s/Docker probe meaningful. Heapdump via `getDataDir()` artifact path, referenced over `logs.tail`.

### Key design decisions (and divergences)

1. **A platform-shared `core/diagnostics/` registry of discrete checks — reuse, don't replace, `server/health`.** Each `DiagnosticCheck` returns `{ id, status:'pass'|'warn'|'fail', detail, data?, platforms }`. `buildDoctorReport(ctx)` aggregates. `getHealthStatus()` stays; its binary derivation is *upgraded* (decision 4) to consume the aggregate verdict.
2. **`diagnostics` is a `ServiceRegistry` service; `health` stays an `@applepi/ws-server` method.** These are **two distinct transports** (verified: `health` is `registerMethodHandler`, not in `ServiceRegistry`). The full report is served by a new `createDiagnosticsServices()` factory → `diagnostics.report`, auto-registered on all three platforms by the existing `registerAllServices(registry, deps)` plumbing (`core/services/index.ts:46-55`; server wires deps at `ServerAgentBootstrap.ts:408-412`). The webfront calls it exactly like `skills.list` (`serviceRequest<DoctorReport>('diagnostics.report')`). The `health` method/route is reused unchanged in *shape*; only its `status` *value* gets accurate.
3. **Platform-aware checks: filter on `platformId` at runtime; gate node-only *imports* on `__BUILD_MODE__`.** The registry runs `check.platforms.includes(ctx.platformId)`. But any module that statically imports node (`v8`, `fs`) must be `__BUILD_MODE__`-gated at the import site so Vite dead-code-eliminates it from the extension bundle (the established `core/storage/index.ts` pattern). `platformId` is the 3-value adapter union (no `'mobile'`); `__BUILD_MODE__` is 4 incl. `'mobile'` — use `platformId` for the check filter, `__BUILD_MODE__` for the heapdump import.
4. **Upgrade `status` via a cached `DiagnosticsMonitor`, NOT synchronously inside `getHealthStatus()`.** `getHealthStatus()` is synchronous and called on *every* unauthenticated HTTP probe; running async checks (MCP handshake, scheduler state) per probe would be slow and wrong. Instead, a `DiagnosticsMonitor` (mirroring `HealthMonitor`) runs `buildDoctorReport()` on an interval, computes the worst severity, and calls a new `setHealthDiagnostics(verdict)` setter; `getHealthStatus()`'s derivation reads that cached verdict plus `_agentReady`. Probe stays O(1) and shape-compatible; the enum becomes true. **This is a refinement of the prior draft's "feed the report into `health.ts:83-85`", which implied a synchronous call that would not work.**
5. **Ship a minimal in-track redactor; do NOT depend on Track 16.** The prior draft said redaction is "mandatory via Track 16". **Track 16 does not exist in code** (no `src/core/telemetry/`, no redactor; only `redactConfig()` — a 2-field, `ServerConfig`-typed, server-only function, `server-config.ts:238-247`). Track 17 ships `core/diagnostics/redact.ts` (deny-by-shape: API-key/token/bearer patterns, `userinfo@` URLs, the existing `[SECURED]` marker is already safe) applied to every `DiagnosticResult` before any cross-process emission. It is a single pure function so Track 16 can later subsume it. **Mandatory before any WS/HTTP/service emission.**
6. **Heapdump is node-only and written via `getDataDir()`, not the artifact store.** Port `captureMemoryDiagnostics`+`performHeapDump`. **Divergence from prior draft:** Track 09's `getToolResultStore()` is **inert in every shipped build** (`RepublicAgent.ts:74` passes `services: undefined`; `Session.getToolResultStore()` returns `undefined`). So write directly to `{getDataDir()}/diagnostics/` (server `dataDir` is solid: `server-config.ts:161-163`, `APPLEPI_DATA_DIR` override), never `~/Desktop`, never via the dead store. Surface the path over `emitLog('info', …, { artifact:{kind:'heapdump',path} })` (`logs.tail`, admin-scoped).
7. **`/doctor` uses the live webfront command path, not the dead typed surface and not the unbuilt Track 13 funnel.** The typed `src/core/commands/` hierarchy (`PromptCommand|LocalCommand`) is **dead code — entirely unwired** (grep: no importers). The live path is `src/webfront/commands/CommandRegistry.ts` + `builtinCommands.ts`. There is **no `local-jsx` equivalent**; the only command→view precedent is route navigation (`/settings` → `onOpenSettings` → `push('/settings')`). `/doctor` mirrors that exactly. Track 13's input funnel **does not exist** (status "READY TO IMPLEMENT", no `core/input/processUserInput.ts`); when it lands, the dispatch moves into it — a forward note, not a dependency.

## Implementation Plan (file-level, ordered; each phase independently shippable)

### Phase 1 (S) — core registry + redactor + 3 cross-platform checks. Pure `core/`, unit-testable, no surface.

New `src/core/diagnostics/` (module JSDoc header per house convention; `@/` aliases; module-singleton registry):

```ts
// src/core/diagnostics/types.ts
export type DiagnosticStatus = 'pass' | 'warn' | 'fail';
export type DiagnosticPlatform = 'extension' | 'desktop' | 'server';

export interface DiagnosticResult {
  id: string;
  title: string;
  status: DiagnosticStatus;
  detail: string;                       // human-readable; MUST be redacted before emission
  data?: Record<string, unknown>;       // structured; MUST be redacted before emission
}
export interface DiagnosticContext {
  platformId: DiagnosticPlatform;
  // Lazily-resolved handles; checks must tolerate undefined (uninitialized subsystem).
  agentConfig?: import('@/config/AgentConfig').AgentConfig;
  mcpManager?: import('@/core/mcp/MCPManager').MCPManager;
  skillRegistry?: { getAllSkillMetas(): unknown };
  scheduler?: { getSchedulerState(): Promise<unknown> };
  channelManager?: { getChannelInfo(): Array<{ channelId: string }> };
}
export interface DiagnosticCheck {
  id: string;
  title: string;
  platforms: DiagnosticPlatform[];
  run(ctx: DiagnosticContext): Promise<DiagnosticResult>;
}
export interface DoctorReport {
  overall: DiagnosticStatus;
  platformId: DiagnosticPlatform;
  generatedAt: number;
  durationMs: number;
  checks: DiagnosticResult[];
}
```

```ts
// src/core/diagnostics/DiagnosticRegistry.ts  — module-singleton, mirrors core/* registries
const _checks = new Map<string, DiagnosticCheck>();
export function registerDiagnosticCheck(c: DiagnosticCheck): void { _checks.set(c.id, c); }
export function getDiagnosticChecks(): DiagnosticCheck[] { return [..._checks.values()]; }

export async function buildDoctorReport(ctx: DiagnosticContext): Promise<DoctorReport> {
  const start = Date.now();
  const applicable = getDiagnosticChecks().filter(c => c.platforms.includes(ctx.platformId));
  const results = await Promise.all(applicable.map(async (c): Promise<DiagnosticResult> => {
    try {
      // Per-check hard timeout — a check must be fast & side-effect-free (Risks).
      return await withTimeout(c.run(ctx), 3000, c.id);
    } catch (err) {
      return { id: c.id, title: c.title, status: 'fail',
               detail: `check threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }));
  const overall: DiagnosticStatus =
    results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn' : 'pass';
  return { overall, platformId: ctx.platformId, generatedAt: Date.now(),
           durationMs: Date.now() - start, checks: results };
}
```

```ts
// src/core/diagnostics/redact.ts  — in-track; Track 16 may later subsume.
// Deny-by-shape on detail + every string in data. Returns a redacted clone.
export function redactDoctorReport(r: DoctorReport): DoctorReport { /* sk-…, Bearer …,
  api[-_]?key, token, userinfo@host, JWT-shaped — replaced with '***'. '[SECURED]' kept. */ }
```

Checks (`src/core/diagnostics/checks/`, all `platforms: ['extension','desktop','server']`), each reading the **`core/storage` singletons guarded by their `is*Initialized()`** (the `IPlatformAdapter` storage methods are stubs — verified — do NOT use them):

- `config-valid.ts` — `isConfigStorageInitialized()` guard → `AgentConfig.getInstance()` → `getConfig()` → `validateConfig()` (`src/config/validators.ts:30`, `ValidationResult.valid`). `fail` if invalid/absent.
- `credentials-present.ts` — `isCredentialStoreInitialized()` guard → for each provider in config, `agentConfig.getProviderApiKey(id)` non-null / `apiKey==='[SECURED]'`. Server-only sub-branch (`ctx.platformId==='server'`): `process.env.VITE_VAULT_SECRET` unset ⇒ `fail` (FileCredentialStore throws on every read without it — `FileCredentialStore.ts:36-39`).
- `channels-reachable.ts` — `ctx.channelManager.getChannelInfo()`. This is the **real** check the fake `health-monitor.ts:60-64` map should have been.

Register all three from a `registerCoreDiagnosticChecks()` barrel.

### Phase 2 (S) — server surface + truthful K8s probe (the marquee win).

- `src/core/services/diagnostics-services.ts`: `createDiagnosticsServices(deps): Record<string, ServiceHandler>` (factory shape verified against `skills-services.ts:37-45`):

```ts
import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
export interface DiagnosticsServiceDeps { buildCtx: () => DiagnosticContext; }
export function createDiagnosticsServices(deps: DiagnosticsServiceDeps): Record<string, ServiceHandler> {
  return {
    'diagnostics.report': async () => redactDoctorReport(await buildDoctorReport(deps.buildCtx())),
  };
}
```

- Wire it into `AllServiceDeps` (`src/core/services/index.ts:24-33`) + the factory list (`:46-55`: add `['diagnostics', createDiagnosticsServices]`) + re-export (`:72-79`). Each bootstrap that calls `registerAllServices` (server `ServerAgentBootstrap.ts:408`, desktop, extension service-worker) passes a `diagnostics: { buildCtx }` deps object assembled from its already-held singletons (`AgentConfig`, `MCPManager`, `SkillRegistry`, `Scheduler`, `getChannelManager()`). One-line-per-platform; auto-registered everywhere.
- `src/server/health/diagnostics-monitor.ts`: a `DiagnosticsMonitor` class mirroring `HealthMonitor` (start/stop/private refresh on an interval, e.g. 30s for readiness responsiveness). `refresh()` → `buildDoctorReport(serverCtx)` → `setHealthDiagnostics(report.overall)`.
- `src/server/handlers/health.ts`: add `let _diagnostics: DiagnosticStatus = 'pass'` + `export function setHealthDiagnostics(v: DiagnosticStatus): void`. Change the derivation (`:83-85`) — shape-compatible, only the value gets accurate:

```ts
const status: HealthStatus['status'] =
  _diagnostics === 'fail' ? 'error'
  : (!_agentReady || _diagnostics === 'warn') ? 'degraded' : 'ok';
```

  Start `DiagnosticsMonitor` in `ServerAgentBootstrap` next to `HealthMonitor` (`:282-283`). **Security:** `GET /health` (unauthenticated) keeps returning the same `HealthStatus` shape — now with a truthful `status` — but the *full report* is **only** the authenticated `diagnostics.report` service. Do not widen the unauthenticated HTTP payload. This realizes the K8s/Docker probe fix end-to-end.

### Phase 3 (S–M) — `/doctor` command + view; deeper checks; monitor fold-in.

- `src/core/skills/SkillRegistry.ts:7`: add `'doctor'` to `RESERVED_COMMAND_NAMES` (prevents a skill shadowing the builtin; same guard `new`/`help`/`settings` use).
- `src/webfront/commands/builtinCommands.ts`: add `onOpenDoctor: () => void` to `BuiltinCommandCallbacks` (`:5-9`); register a `doctor` command (`:47-54` pattern) whose `action` calls `activeCallbacks?.onOpenDoctor()`.
- `MessageInput.svelte` `ensureBuiltins()`: wire `onOpenDoctor: () => push('/doctor')` (mirrors `onOpenSettings`).
- `src/webfront/App.svelte` routes (`:28-46`): add `'/doctor': Doctor,`.
- `src/webfront/pages/diagnostics/Doctor.svelte`: structurally modeled on `pages/settings/Settings.svelte` (header+close → `push('/')`, `onMount` loader, theme block). `onMount`: `const c = await getInitializedUIClient(); report = await c.serviceRequest<DoctorReport>('diagnostics.report');` Render claudy's discrete pass/warn/fail panel, Svelte-rendered (pass=green, warn=yellow, fail=red; `detail` lines).
- Deeper checks (same `core/diagnostics/checks/` pattern): `mcp-connected.ts` (`MCPManager.getInstance().getConnections()` vs `getServers()`; `status==='error'`+`lastError`), `skills-loaded.ts` (`getAllSkillMetas()`, dedupe by `name` for collisions; optional per-file `validateSkill`), `scheduler-health.ts` (`scheduler.getSchedulerState()`; `fail` on `isPaused`/`missedCount>0`).
- Point `HealthMonitor.refresh()` (`health-monitor.ts:55-82`) at real channel state via the `channels-reachable` data instead of the hardcoded `'connected'`; incidentally remove dead `setHealthActiveRuns` or wire it from `AgentRegistry.listSessions()`.

### Phase 4 (S, server node-only) — heapdump + leak heuristics.

- `src/server/diagnostics/heapdump.ts` (server dir — node-only). Port claudy `captureMemoryDiagnostics` + `performHeapDump` + the `potentialLeaks[]` heuristic and the **diagnostics-JSON-before-snapshot** ordering. Write to `{getDataDir()}/diagnostics/{sessionId}-{ts}.heapsnapshot` + `-diagnostics.json` (NOT `~/Desktop`, NOT `getToolResultStore()`). Import gated by `__BUILD_MODE__==='server'`.
- Expose as `diagnostics.heapdump` service handler (admin) returning `{ heapPath, diagPath }`; also `emitLog('info','heapdump written',{artifact:{kind:'heapdump',path}})` so `logs.tail` subscribers see it.
- Run heapdump diagnostics JSON through `redactDoctorReport`'s primitive before logging the summary.

## Dependencies (verified status — read this before implementing)

- **Existing `server/health` / `HealthMonitor` / `log-streamer`** — real, server-only. Reuse, not rebuild.
- **Track 01 (Events)** — ✅ real. `makeEvent(event,payload,seq)` `packages/ws-server/src/frames.ts:256`. Phase 3 admin broadcast follows the `HealthMonitor` `getTrackedConnections()`+`shouldReceiveEvent` pattern. An optional `DiagnosticCheckFailed` `EventMsg` variant (`core/protocol/events.ts`) is *deferred* — not required for any phase.
- **Track 03 (Commands)** — ⚠️ the typed `core/commands/` surface is **built but dead/unwired**. Use the **live** `webfront/commands` path. No `local-jsx`. (decision 7)
- **Track 07 (Centralized State)** — ⚠️ `_DONE` dir but full substrate **not built** (no `src/core/state/`; only a narrow `modelStore`). No central store to read; `DiagnosticContext` injects the distributed singletons explicitly. (decision 1)
- **Track 09 (Persistence)** — ⚠️ `getDataDir()` is solid & server-only (`server-config.ts:161`); but `getToolResultStore()` is **inert in shipped builds**. Heapdump writes via `getDataDir()` directly. (decision 6)
- **Track 13 (Input funnel)** — ❌ **not built**. `/doctor` uses the existing builtin-callback path; forward-note only. (decision 7)
- **Track 16 (Telemetry/Redaction)** — ❌ **not built**. Ship the in-track redactor; Track 16 may later subsume. The "extension telemetry ring as a /doctor source" and "sink/queue-health check" from the prior draft are **removed** (those subsystems do not exist). (decision 5)

## Risks

- Checks must be fast & side-effect-free (no mutating/handshaking network calls); read cached state. Enforced by the 3s per-check timeout + `Promise.all` isolation in `buildDoctorReport` (one check failing/﻿hanging cannot break the report).
- Secret leakage — `redactDoctorReport` is mandatory before *any* WS/HTTP/service emission; `diagnostics.report` returns only the redacted clone; the unauthenticated `GET /health` never carries the report (status enum only).
- Probe-semantics regression — `HealthStatus` shape is unchanged; only the `status` *value* derivation changes (still the same 3-value enum). Existing probes keep parsing; they just start telling the truth.
- Cross-platform divergence — one registry filtered by `platformId`; never fork per-platform doctors. Node-only heapdump import gated by `__BUILD_MODE__` so the extension bundle never includes `v8`.
- Sequencing — Phases are independently shippable. Phase 1+2 deliver the K8s win with **zero** unbuilt-track dependencies. Phase 3 view depends only on the live webfront command path (exists today).
- `DiagnosticsMonitor` interval vs. probe freshness — at 30s, a just-expired credential is detected within ≤30s; acceptable for K8s readiness (default `periodSeconds` is 10s but failure thresholds tolerate this). Do not drop the interval low enough to make checks a load source.

## Validation Notes & Corrections vs. prior draft (2026-05-15, line-level verified)

Verified against claudy (`commands/{doctor,status,heapdump}/`, `screens/Doctor.tsx`, `utils/{doctorDiagnostic,heapDumpService}.ts`) and browserx source (every file:line below was read, not summarized):

1. **Confirmed:** `HealthStatus.status` derives only from `_agentReady` (`health.ts:83-85`), never `'error'`. Additionally found: `channels` map is faked to `'connected'` (`health-monitor.ts:60-64`), `setHealthActiveRuns` is dead (`health.ts:57`, no callers), `_agentModel` always `undefined`. The problem is *worse* than the prior draft stated.
2. **Confirmed:** the endpoint is not new — reuse `registerMethodHandler('health')` + `GET /health`. **Corrected:** `health` is an `@applepi/ws-server` *method*, not a `ServiceRegistry` service; the full report must go through a new `ServiceRegistry` `diagnostics.*` service — these are different transports (decision 2).
3. **Corrected:** the prior draft's "feed the report into `health.ts:83-85`" implied a synchronous call. `getHealthStatus()` is sync and on the unauthenticated probe path; checks are async. Use a cached `DiagnosticsMonitor` + `setHealthDiagnostics` (decision 4).
4. **Corrected (was a false premise):** "redaction mandatory via Track 16" — **Track 16 does not exist** (only `redactConfig()`, 2-field, server-only). Ship an in-track redactor (decision 5).
5. **Corrected (false premise):** "heapdump via Track 09 artifact store / dataDir" — `getToolResultStore()` is **inert in shipped builds** (`RepublicAgent.ts:74`). Write via `getDataDir()` directly (decision 6).
6. **Corrected (false premise):** "/doctor via Track 03 command + Track 13 funnel, shared webfront view" — the typed `core/commands` surface is **dead code**, Track 13 funnel **does not exist**, and there is **no `local-jsx`**. Use the live `webfront/commands` + `App.svelte` route path; `/settings` is the exact precedent (decision 7).
7. **Corrected (false premise):** "Track 07 centralized state / extension telemetry ring as data sources" — Track 07's central store and Track 16's telemetry ring **were never built**. `DiagnosticContext` injects distributed singletons; the ring-buffer check is removed.
8. **Confirmed:** checks must read the `core/storage` singletons (`getConfigStorage/getCredentialStore`, guarded by `is*Initialized()`), **not** `IPlatformAdapter.get*Storage()` — those adapter methods are stubs returning empty/null on server & desktop.
9. **Confirmed:** `platformId` (3 values, `IPlatformAdapter.ts:60`) vs `__BUILD_MODE__` (4, +`'mobile'`, `globals.d.ts:14`). Filter checks on `platformId`; gate node-only heapdump import on `__BUILD_MODE__`.
