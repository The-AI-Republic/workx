# Track 17: Operational Diagnostics

**Priority: P1** · **Effort: S–M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's doctor/heapdump and browserx's server health surface across all three deploy targets — see "Validation Notes". Realizes plan.md "Priority 7". Incremental, not greenfield: the health primitives exist.

## Problem

BrowserX has good server-mode health *primitives* but no unified, user-invokable, cross-platform self-diagnosis. `getHealthStatus()` reports `status:'ok'|'degraded'|'error'` but in practice only ever returns `'ok'`/`'degraded'` from a single binary `_agentReady` flag (`server/handlers/health.ts:83-85`) — it never validates config, credentials, channels, MCP, or skills, never returns `'error'`, only exists on the server, and has no `/doctor`-style command. There is no on-demand heapdump. **Operationally this bites hardest on Apple Pi Server:** GET `/health` is the conventional Docker/K8s liveness/readiness probe target, and a binary-from-`_agentReady` status means a container with expired credentials or a dead MCP/channel reports healthy forever — it is never restarted or depooled.

## What Claudy Does

`/doctor` (`commands/doctor/index.ts`) is a `type:'local-jsx'` command (`load: () => import('./doctor.js')`, gated by `DISABLE_DOCTOR_COMMAND`) rendering `screens/Doctor.tsx` (575 lines) — a panel of **discrete installation/config/validation checks**, each pass/warn/fail. `/status` (`commands/status/index.ts`) is `local-jsx`, `immediate:true`, reusing the Settings "Status" view (version, model, account, API connectivity, tool statuses). `/heapdump` → `utils/heapDumpService.ts`: `captureMemoryDiagnostics(trigger, dumpNumber)` + `performHeapDump()` (`:221`) using node `v8` (`writeHeapSnapshot`, `getHeapStatistics`, `getHeapSpaceStatistics`) → writes heap snapshot + diagnostics summary to `~/Desktop`. Pattern: **discrete diagnostic commands feeding a shared status view; heapdump is node-only, on demand.**

## BrowserX Mapping

### The real seam — health primitives exist, server-only & binary

| Concern | BrowserX location | State |
|---|---|---|
| Health snapshot | `HealthStatus` (`server/handlers/health.ts:16-37`): status/uptime/version/connections/sessions/channels/agent/memory/timestamp | Good shape; **`status` derived only from `_agentReady`** (`:83-85`) |
| Mutable state + setters | `_agentReady/_agentModel/_agentTools/_activeRuns/_channels/...` + `setHealth*()` (`:39-72`) | Push model; no validation logic |
| Transport | `registerHealthHandlers()` → `registerMethodHandler('health',…)` (`:115-124`) (WS method + HTTP GET /health) | Reuse — don't add a parallel endpoint |
| Periodic broadcast | `HealthMonitor` 60s `refresh()` → `makeEvent('health',status)` to admin conns (`server/health/health-monitor.ts:25-83`) | Server-only |
| Log streaming | `installStructuredLogging()` → `emitLog` → `logs.tail` (`server/health/log-streamer.ts:16-40`) | Server-only |
| `/doctor` / diagnostics cmd | none (grep: only `sessionSummary/telemetry.ts`, `HookRegistry.ts`) | Missing entirely |
| Platform discriminator | `IPlatformAdapter.platformId` (`IPlatformAdapter.ts:60`) | Per-check applicability gate |

### Per-Platform Behavior

One `DiagnosticRegistry`; each check declares `platforms`. What differs is the *check set available*, the *surface*, and the *operational consequence*.

- **BrowserX (extension, MV3).** No fs, no node `v8`, no `~/Desktop`. Available checks: config validity (`chrome.storage`/`AgentConfig`), model credentials present, MCP bridge (if any), skills loaded + collisions, Track 16 telemetry-ring health. **No heapdump** (only coarse `performance.memory`; optional, low value). Surface: shared `webfront` Svelte `/doctor` view (popup/sidepanel), triggered via the Track 13 funnel. Consequence: self-service "why is my extension misbehaving" — diagnostic, not orchestration.
- **Apple Pi (desktop, Tauri).** Node-capable via the Tauri sidecar runtime → fs config checks, real heapdump (`v8.writeHeapSnapshot`) written through the storage/artifact layer (not `~/Desktop`). Surface: same shared `webfront` view. Consequence: local troubleshooting + memory-leak capture for a long-lived desktop process.
- **Apple Pi Server (headless, Docker/K8s).** Richest target and the highest-value one. Full check set: config file (`FileConfigStorageProvider`), credentials (`FileCredentialStore`), connector/channel reachability, MCP (`NodeMCPBridge`), skills, scheduler health, plus the existing `HealthMonitor`/`getHealthStatus`. Surfaces: **extend the existing** `health` WS method + HTTP GET /health (no parallel endpoint) and a `diagnostics` WS service; heapdump via the server `dataDir`/artifact store (reuse Track 09's `dataDir`), referenced over `logs.tail`. **Key operational win:** upgrading `HealthStatus.status` to reflect real checks (and actually emit `'error'`) makes GET /health a *meaningful* K8s/Docker liveness/readiness probe — a credential-expired or MCP-dead container now fails readiness and gets depooled/restarted instead of silently serving broken. Redaction (Track 16) is **mandatory** before any WS/HTTP emission here (network-exposed, possibly multi-tenant).

### Key design decisions (and divergences from claudy)

1. **A platform-shared `DiagnosticRegistry` of discrete checks — reuse, don't replace, `server/health`.** `core/diagnostics/`: each `DiagnosticCheck` returns `{ id, status:'pass'|'warn'|'fail', detail, platforms }`. `getHealthStatus()` becomes **one input** to the aggregate `DoctorReport`; the existing `server/handlers/health.ts` + `HealthMonitor` stay and are fed by it — their binary `status` is *upgraded* to use `'error'` when a critical check fails (the type already allows it; this is what makes the K8s probe meaningful).
2. **One report, three surfaces (mirror claudy's "discrete checks → shared view").** `/doctor` Track 03 command, a channel `diagnostics` service request, and the **existing** `health` WS method/HTTP endpoint extended to carry the report. **Divergence:** claudy renders Ink; browserx renders in shared `webfront` Svelte and serializes for server/channel — same data, platform-rendered.
3. **Platform-aware checks (net-new vs claudy).** Each check declares applicable platforms; the registry filters by `IPlatformAdapter.platformId` at runtime. **Refinement vs first draft:** discriminate on `platformId` (injected, testable, consistent with Tracks 12–14) rather than the raw `__BUILD_MODE__` define. Claudy is single-platform and needs no such filtering.
4. **Heapdump is node-only (server/desktop), via the storage/artifact layer.** Port `captureMemoryDiagnostics` + `performHeapDump` but **divergence:** no node `v8`/`~/Desktop` in the extension; gate on `platformId !== 'extension'` and write the snapshot via the storage layer / downloadable artifact (Track 09 conventions, server `dataDir`), never a hardcoded desktop path.
5. **Redact diagnostic output (net-new vs claudy).** Config/health can contain URLs, tokens, account info. Diagnostic output runs through Track 16 redaction before it leaves the process. Mandatory on server/channel surfaces; claudy's local terminal has no equivalent need.

## Implementation Plan (file-level, ordered)

**Phase 1 (S) — registry + core checks + status upgrade.**
- `core/diagnostics/DiagnosticRegistry.ts` + `DiagnosticCheck` type (`{id,status,detail,platforms}`); `core/diagnostics/checks/` for config-valid, credentials-present/valid, channels-reachable. Aggregate `buildDoctorReport()`.
- Feed the report into `server/handlers/health.ts`: replace the `_agentReady`-only derivation at `:83-85` so `status` reflects the worst check severity and can return `'error'`. This alone fixes the K8s-probe gap on Apple Pi Server.

**Phase 2 (S–M) — surfaces.**
- `/doctor` Track 03 command → shared `webfront` Svelte report view (ext + desktop), routed via the Track 13 funnel.
- Channel `diagnostics` service request; extend the existing `registerMethodHandler('health')` + HTTP GET /health payload to optionally carry the full report (back-compat: status field unchanged shape, richer value).

**Phase 3 (S) — deeper checks + monitor fold-in.**
- Add MCP-connected, skills/plugins-loaded + collision, scheduler-health checks. Point `HealthMonitor.refresh()` (`health-monitor.ts:25-83`) at the aggregate so the 60s broadcast carries real status.

**Phase 4 (S, node-only) — heapdump + redaction.**
- Port `heapDumpService` for `platformId !== 'extension'`; write via server `dataDir`/Track 09 artifact path; expose reference over `logs.tail`. Run all server/channel-bound diagnostic output through Track 16 redaction.

## Dependencies

- Existing `server/handlers/health.ts` / `HealthMonitor` / `log-streamer` — reuse, not rebuild.
- **Track 01** (Events): check-failure events ride the bus; `HealthMonitor` already uses `makeEvent`.
- **Track 03** (Commands): `/doctor`, `/status`.
- **Track 07** (Centralized State): report reads operational state where available.
- **Track 16** (Telemetry): redaction of diagnostic output; sink/queue health is itself a check; the extension telemetry ring buffer is a `/doctor` data source.
- **Track 09** (Persistence): heapdump artifact storage / server `dataDir`.

## Risks

- Checks must be fast and side-effect-free (no mutating network calls) — read cached state where possible.
- Cross-platform divergence — single registry filtered by `platformId`; never fork per-platform doctors.
- Secret leakage in diagnostic output — Track 16 redaction mandatory before any server/channel emission.
- Don't reimplement `HealthStatus`/`HealthMonitor` — extend; duplicating creates two drifting truths.
- Probe-semantics regression: changing GET /health `status` derivation must stay shape-compatible (same enum) so existing probes keep parsing — only the *value* gets more accurate.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `commands/doctor/index.ts` (`local-jsx`, `DISABLE_DOCTOR_COMMAND`), `commands/status/index.ts` (`local-jsx`, `immediate:true`), `screens/Doctor.tsx` (discrete-check panel); `utils/heapDumpService.ts:85-235` (`captureMemoryDiagnostics`, `performHeapDump`, node `v8`, `~/Desktop`).
- browserx: `server/handlers/health.ts:16-37,39-72,79-109,115-124`; `server/health/health-monitor.ts:19-83`; `server/health/log-streamer.ts:16-40`; `core/platform/IPlatformAdapter.ts:60` (`platformId` check gate); no diagnostics command anywhere (grep).

Corrections vs the first-pass draft:
1. The precise gap: `HealthStatus.status` derives **only** from binary `_agentReady` (`health.ts:83-85`) — no real diagnosis, never `'error'`.
2. The endpoint is **not** new — extend the existing `registerMethodHandler('health')` + HTTP GET /health; a parallel `/api/health` would duplicate.
3. Heapdump strictly node-only; artifact path via storage, not `~/Desktop`.
4. Added a browserx-specific redaction requirement (Track 16).
5. **Multi-platform (2026-05-15):** the highest-value consequence is on Apple Pi Server — upgrading `status` to real checks turns GET /health into a meaningful K8s/Docker readiness/liveness probe (broken containers get depooled/restarted instead of silently serving). Extension has the thinnest check set (no fs/`v8`); desktop gets heapdump via Tauri's node sidecar. Check applicability filters on `platformId` (refined from raw `__BUILD_MODE__`).
