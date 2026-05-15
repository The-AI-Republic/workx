# Track 17: Operational Diagnostics

**Priority: P1** · **Effort: S–M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's doctor/heapdump and browserx's server health surface — see "Validation Notes". Realizes plan.md "Priority 7", never tracked. Incremental, not greenfield: the health primitives exist.

## Problem

BrowserX has good server-mode health *primitives* but no unified, user-invokable, cross-platform self-diagnosis. `getHealthStatus()` reports `status: 'ok' | 'degraded' | 'error'` but in practice only ever returns `'ok'`/`'degraded'` from a single binary `_agentReady` flag (`server/handlers/health.ts:83-85`) — it never validates config, credentials, channels, MCP, or skills, never returns `'error'`, only exists on the server, and has no `/doctor`-style command. There is no on-demand heapdump.

## What Claudy Does

`/doctor` (`commands/doctor/index.ts`) is a `type: 'local-jsx'` command (`load: () => import('./doctor.js')`, gated by `DISABLE_DOCTOR_COMMAND`) rendering `screens/Doctor.tsx` (575 lines) — a panel of **discrete installation/config/validation checks**, each pass/warn/fail. `/status` (`commands/status/index.ts`) is a `local-jsx`, `immediate: true` command reusing the Settings "Status" view (one operational picture: version, model, account, API connectivity, tool statuses). `/heapdump` → `utils/heapDumpService.ts`: `captureMemoryDiagnostics(trigger, dumpNumber)` + `performHeapDump()` (`:221`) using node `v8` (`writeHeapSnapshot`, `getHeapStatistics`, `getHeapSpaceStatistics`) → writes heap snapshot + a diagnostics summary to `~/Desktop`. Pattern: **discrete diagnostic commands feeding a shared status view; heapdump is node-only, on demand.**

## BrowserX Mapping

### The real seam — health primitives exist, server-only & binary

| Concern | BrowserX location | State |
|---|---|---|
| Health snapshot | `HealthStatus` (`server/handlers/health.ts:16-37`): status/uptime/version/connections/sessions/channels/agent/memory/timestamp | Good shape; **`status` derived only from `_agentReady`** (`:83-85`) — no real checks |
| Mutable state + setters | `_agentReady/_agentModel/_agentTools/_activeRuns/_channels/...` + `setHealth*()` (`:39-72`) | Push model; no validation logic |
| Transport | `registerHealthHandlers()` → `registerMethodHandler('health', …)` (`:115-124`) (WS method + HTTP GET /health) | Reuse this seam — don't add a parallel endpoint |
| Periodic broadcast | `HealthMonitor` 60s `refresh()` → `makeEvent('health', status)` to authenticated admin conns (`server/health/health-monitor.ts:25-83`) | Server-only |
| Log streaming | `installStructuredLogging()` wraps `console.*` → `emitLog` → `logs.tail` (`server/health/log-streamer.ts:16-40`) | Server-only |
| `/doctor` / diagnostics cmd | none (grep: only `sessionSummary/telemetry.ts`, `HookRegistry.ts`) | Missing entirely |

### Key design decisions (and divergences from claudy)

1. **A platform-shared `DiagnosticRegistry` of discrete checks — reuse, don't replace, `server/health`.** `core/diagnostics/`: each `DiagnosticCheck` returns `{ id, status: 'pass'|'warn'|'fail', detail, platforms }`. Checks: config valid, model credentials present/valid, channels reachable, MCP servers connected, skills/plugins loaded + collisions. `getHealthStatus()` becomes **one input** to the aggregate `DoctorReport`; the existing `server/handlers/health.ts` and `HealthMonitor` stay and are fed by it (their binary `status` is *upgraded* to use `'error'` when a critical check fails — the type already allows it).

2. **One report, three surfaces (mirror claudy's "discrete checks → shared view").** `/doctor` Track 03 command (the browserx analog of claudy's `local-jsx`), a channel `diagnostics` service request, and the **existing** `health` WS method/HTTP endpoint extended to carry the report. **Divergence:** claudy renders Ink; browserx renders the report in the Svelte UI and serializes it for server/channel — same data, platform-rendered.

3. **Platform-aware checks (net-new vs claudy).** Each check declares applicable platforms. Extension service-worker cannot read fs config or heapdump; server can. One registry, filtered per `__BUILD_MODE__` runtime — claudy is single-platform and needs no such filtering.

4. **Heapdump is node-only (server/desktop), via the storage/artifact layer.** Port `captureMemoryDiagnostics` + `performHeapDump` but **divergence:** the extension has no node `v8` or `~/Desktop`; gate on platform and write the snapshot via the storage layer / a downloadable artifact (reuse Track 09 persistence conventions), not a hardcoded desktop path.

5. **Redact diagnostic output (net-new vs claudy).** A browser agent's config/health can contain URLs, tokens, account info. Diagnostic output runs through Track 16's redaction before it leaves the process. claudy (local terminal) doesn't need this; a server/channel-exposed agent does.

### Phase plan

- **Phase 1 (S):** `DiagnosticRegistry` + core checks (config/credentials/channels), aggregate `DoctorReport`; feed it into the existing `getHealthStatus()` so `status` reflects real checks (incl. `'error'`).
- **Phase 2 (S–M):** `/doctor` command (Track 03) + channel `diagnostics` service request + extend the existing `health` method/HTTP payload; Svelte report view.
- **Phase 3 (S):** add MCP + skills/plugins/collision checks; fold `HealthMonitor` broadcast to use the aggregate.
- **Phase 4 (S, node-only):** on-demand heapdump (server/desktop) via storage artifact + Track 16 redaction on all output.

## Dependencies

- Existing `server/handlers/health.ts` / `HealthMonitor` / `log-streamer` — reuse, not rebuild
- **Track 01** (Events): check-failure events ride the bus; `HealthMonitor` already uses `makeEvent`
- **Track 03** (Commands): `/doctor`, `/status`
- **Track 07** (Centralized State): report reads operational state where available
- **Track 16** (Telemetry): redaction of diagnostic output; sink/queue health is itself a check
- **Track 09** (Persistence): heapdump artifact storage

## Risks

- Checks must be fast and side-effect-free (no mutating network calls) — read cached state (`getHealthStatus`, channel manager) where possible.
- Cross-platform divergence — single registry filtered by platform; never fork per-platform doctors.
- Secret leakage in diagnostic output — Track 16 redaction is mandatory before any server/channel emission (claudy doesn't need this; browserx does).
- Don't reimplement `HealthStatus`/`HealthMonitor` — extend them; duplicating creates two drifting truths.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `commands/doctor/index.ts` (`local-jsx`, `DISABLE_DOCTOR_COMMAND` gate), `commands/status/index.ts` (`local-jsx`, `immediate:true`), `screens/Doctor.tsx` (575-line discrete-check status panel); `utils/heapDumpService.ts:85-235` (`captureMemoryDiagnostics`, `performHeapDump`, node `v8`, writes to `~/Desktop`).
- browserx: `server/handlers/health.ts:16-37` (`HealthStatus`), `:39-72` (mutable state + `setHealth*`), `:79-109` (`getHealthStatus`, status from `_agentReady` only), `:115-124` (`registerMethodHandler('health')`); `server/health/health-monitor.ts:19-83` (60s broadcast to admin conns); `server/health/log-streamer.ts:16-40` (`installStructuredLogging`); no diagnostics command anywhere (grep).

Corrections vs the first-pass draft:
1. Confirmed the precise gap: `HealthStatus.status` is derived **only** from a binary `_agentReady` (`health.ts:83-85`) — it never validates config/credentials/MCP/skills and never emits `'error'`. The draft said "partial — server health only"; the sharper truth is "primitives exist but do no real diagnosis."
2. The new endpoint is **not** new — extend the existing `registerMethodHandler('health')` + HTTP GET /health; a parallel `/api/health` (first-pass suggestion) would duplicate.
3. Heapdump is strictly node-only (`v8`); the draft's "server/desktop" is right but the artifact path must go through storage, not claudy's `~/Desktop`.
4. Added a browserx-specific redaction requirement (Track 16) — a server/channel-exposed diagnostic surface can leak secrets; claudy's local terminal model has no equivalent need.
