# Track 16: Telemetry & Analytics

**Priority: P1** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's analytics core and browserx's logging/event/log-streaming surface across all three deploy targets — see "Validation Notes".

## Problem

BrowserX has **near-zero field observability**. The only logging is `GeminiLogger` (`src/utils/logger.ts`) — a `console.log` debug tracer gated on `GEMINI_DEBUG` (env on node, `localStorage` in the extension SW — `:12,18,157`), no structure, no sink, no privacy model. (`core/sessionSummary/telemetry.ts` is an unrelated session-summary helper.) The one exception is Apple Pi Server, which already has `installStructuredLogging()` + a `logs.tail` WS fan-out (`src/server/health/log-streamer.ts:16`, `src/server/handlers/logs.ts:39`) — but nothing structured *feeds* it. An unattended multi-platform agent cannot answer "which tools fail in the field, where do approvals stall, why do scheduled jobs abort."

## What Claudy Does

### Zero-dependency public API — `services/analytics/index.ts`

`logEvent(name, metadata)` / `logEventAsync` (`:133-164`). The metadata type is the crux:

```ts
type LogEventMetadata = { [key: string]: boolean | number | undefined }   // NO strings
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

A string can only enter telemetry via an explicit `value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` cast — a **compile-time forced review**. PII routes through `_PROTO_*` keys; `stripProtoFields()` (`:45-58`) removes them before any general-access sink.

**Queue-then-drain** (`:80-123`): events buffer in `eventQueue` until `attachAnalyticsSink(sink)` (idempotent, `:95-123`) drains them via `queueMicrotask`. No sink ⇒ events queued, never lost, never block startup. The module has **no imports** to avoid cycles. `_resetForTesting()` (`:170`).

### Sink fan-out — `services/analytics/sink.ts`

`initializeAnalyticsSink()` (`:109-114`) attaches `{logEvent: logEventImpl, logEventAsync}`. `logEventImpl` (`:48-72`): sampling, per-backend gate with **stale-cache fallback** (`shouldTrackDatadog` `:29-43`) and a JSON **kill-switch** (`isSinkKilled('datadog')`), then fan-out to Datadog (PROTO-stripped) + 1P (full). Fire-and-forget.

### Privacy levels — `utils/privacyLevel.ts`

Ordered `'default' < 'no-telemetry' < 'essential-traffic'` (`:18-28`), most-restrictive-wins from env (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). `isTelemetryDisabled()`/`isEssentialTrafficOnly()` gate every telemetry call site.

## BrowserX Mapping

### The real seam — tap the existing event bus, don't re-instrument

| Concern | BrowserX location | State |
|---|---|---|
| Only logging today | `GeminiLogger` (`utils/logger.ts:12,18,157`) | console-only, `GEMINI_DEBUG` (env on node / `localStorage` in SW) |
| Structured event stream | Track 01: `core/events/` (`EventMapping.ts`, `IEventRouter.ts`, `SubAgentEventRouter.ts`); `EventMsg` via `Session.sendEvent` (SQ/EQ) | **Already a centralized structured firehose** |
| Hook stream | Track 01: `core/hooks/HookDispatcher.ts` (`PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, …) | Already fires structured hook events |
| Privacy/config | `config/AgentConfig` (no `process.env` in the extension SW) | Privacy level must come from config (ext) / config+env (desktop/server) |
| Server observability surface | `src/server/health/log-streamer.ts:16` `installStructuredLogging()` (stdout + tail); `src/server/handlers/logs.ts:39` `emitLog(level,msg,data)` → level-gated WS `_subscribers` | **A real sink already exists server-side, unused by structured telemetry** |
| Unrelated | `core/sessionSummary/telemetry.ts` | Session-summary helper — do **not** conflate |

### Per-Platform Behavior

The core (queue-then-drain + marker-type metadata + bridge) is **one shared module**. The **sink** and the **privacy-level source** are what diverge — and the divergence is large enough that "one telemetry system" only works because the sink is pluggable.

- **BrowserX (extension, MV3).** Privacy/opt-in from `AgentConfig` only (**no `process.env`**; `GEMINI_DEBUG` itself falls back to `localStorage` — `logger.ts:18`). Default sink = `NoopSink`. Optional: a **bounded in-memory ring buffer** sink surfaced via `/doctor` (Track 17) — local only. A *remote* sink from a browser extension is a Web-Store-policy + privacy liability and the MV3 service worker is evicted long before a reliable remote flush completes (same constraint as Track 12) → remote sink is opt-in, flag-gated (Track 22), and never default. The marker-type discipline matters **most here**: the extension sees URLs, DOM, form values, credentials.
- **Apple Pi (desktop, Tauri).** `process.env` available → claudy's env-based privacy model partially applies (env override on top of `AgentConfig`). Long-lived process + filesystem → a **local rotating-file sink** is the natural default-capable option; OTEL/OTLP optional and flag-gated. Can also surface a desktop diagnostics view (out of scope; the bridge is the contract).
- **Apple Pi Server (headless, Docker/K8s).** Where field observability actually matters (operators run scheduled jobs unattended). **The sink already exists:** a `ServerLogSink` implementing `AnalyticsSink` simply calls the existing `emitLog()` (`handlers/logs.ts:39`), which `installStructuredLogging()` (`log-streamer.ts:16`) already mirrors to **stdout** (scraped by Docker/K8s collectors — the standard cloud-native pattern) **and** to `logs.tail` WS subscribers (the channel operators already use). So on the server this track is mostly *wiring the bridge into infra that is already there* — zero new transport. Privacy level from `APPLEPI_*` env + server config; OTLP to a collector is an optional flag-gated add-on, not required for basic observability.

### Key design decisions (and divergences from claudy)

1. **Port the zero-dep queue-then-drain core almost verbatim.** `core/telemetry/analytics.ts`: no imports, `eventQueue`, idempotent `attachSink()`, `queueMicrotask` drain, `NoopSink` default, `_resetForTesting()`. Correct as-is for a multi-platform agent (the SW-suspension case is exactly why queue-if-no-sink + non-blocking drain is mandatory, not optional).
2. **Copy the privacy marker-type discipline exactly — highest-value port.** `metadata:{[k]:boolean|number|undefined}`, strings only via the explicit `…_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` cast, `stripProtoFields()` for `_PROTO_*` PII keys. For a browser agent a *compile-time* guarantee that telemetry can't carry URLs/DOM/credentials is non-negotiable. Keep the long ugly type name — its ugliness is the enforcement.
3. **Tap the Track 01 event bus instead of hand-instrumenting (major divergence from claudy).** Claudy sprinkles `logEvent(...)` across hundreds of call sites. BrowserX already centralized a structured `EventMsg`/hook firehose in Track 01. Add a `TelemetryBridge` subscribing to `IEventRouter` + `HookDispatcher`, mapping a **curated allowlist** of events → `logEvent`. Net-new `logEvent` calls only where no event exists (rate-limit waits → Track 12, cost → Track 18, migrations → Track 19). Less code, no drift, impossible to "forget to instrument."
4. **Privacy level from config, with an env override only where env exists.** `getPrivacyLevel()`: extension reads `AgentConfig` *only*; desktop/server read `AgentConfig` with an env override (`APPLEPI_*` / `DISABLE_TELEMETRY`). Same ordered `default < no-telemetry < essential-traffic`, most-restrictive-wins; policy-lockable by Track 20. Bridge is inert unless level is `default` *and* a sink is attached.
5. **No-op by default; ships dark.** `NoopSink` until startup explicitly attaches one *and* config opts in. Default builds emit nothing. The *server* is the only platform where attaching a (local, in-infra) sink by default is reasonable — and even there it is the existing `emitLog`/stdout surface, not network egress.
6. **Skip Datadog / 1P / BigQuery / GrowthBook entirely** (claudy-infra-specific). Concrete sinks: `NoopSink` (all), in-memory ring (ext, for `/doctor`), rotating-file (desktop), `ServerLogSink`→`emitLog` (server), and an optional **dynamically-imported** OTEL/OTLP sink behind a Track 22 flag (mirror claudy's per-protocol OTEL isolation in `utils/telemetry/`, not the BQ machinery).

## Implementation Plan (file-level, ordered)

**Phase 1 — zero-dep core.**
- `core/telemetry/analytics.ts`: no imports; `eventQueue`, `logEvent`/`logEventAsync`, idempotent `attachSink`, `queueMicrotask` drain, `NoopSink`, `_resetForTesting`. Port marker types + `stripProtoFields` verbatim (rename only the project prefix).
- `core/telemetry/privacy.ts`: ordered levels; `getPrivacyLevel()` reading `AgentConfig`; platform-conditional env override (guard `typeof process !== 'undefined'` exactly like `logger.ts:12`).
- No sink wired yet → all builds still emit nothing.

**Phase 2 — the bridge.**
- `core/telemetry/TelemetryBridge.ts`: subscribe to Track 01 `IEventRouter` + `HookDispatcher`; curated allowlist (tool exec/fail, approval ask/grant/deny, session start/abort/compact). Maps event → `logEvent(name, {numeric/boolean only})`. Bounded internal queue, drop-on-overflow, never blocks event delivery.

**Phase 3 — per-platform sinks (pluggable; attached at each bootstrap).**
- Server: `src/server/telemetry/ServerLogSink.ts` implementing `AnalyticsSink` by delegating to existing `emitLog()` (`handlers/logs.ts:39`); attach in `ServerAgentBootstrap.initialize()` after `installStructuredLogging()`. **No new transport.**
- Desktop: rotating-file sink under the Tauri data dir; env-overridable privacy.
- Extension: optional bounded in-memory ring sink, read by Track 17 `/doctor`; default remains `NoopSink`.
- Add sampling + JSON kill-switch (port `sink.ts:29-72` shape, minus Datadog/1P).
- Net-new `logEvent` calls for non-evented signals: Track 12 rate-limit waits, Track 18 cost, Track 19 migrations.

**Phase 4 (optional, flag-gated) — OTEL.**
- Dynamically-imported OTLP exporter behind a Track 22 `feature()` flag; never bundled by default; desktop/server only.

## Dependencies

- **Track 01** (Hooks/Events): the bridge subscribes to `IEventRouter`/`HookDispatcher` — hard reuse.
- **Track 12/18/19**: emit telemetry for signals that aren't already events.
- **Track 17** (Diagnostics): `/doctor` surfaces sink/queue health; the extension ring-buffer sink *is* a `/doctor` data source.
- **Track 20** (Managed Settings): privacy level can be a policy-locked key.
- **Track 22** (Feature Flags): OTEL sink ships dark via `feature()`.
- Existing server `log-streamer`/`logs.tail` infra (server sink target — reuse, not build).

## Risks

- Privacy is existential for a browser agent: default-exclude strings, hard-gate PII via `_PROTO_*`+strip, **never** log URLs/page bodies/DOM/form values. The marker-type discipline is the enforcement — do not relax it.
- The bridge must never block the turn loop or event delivery: bounded queue, drop-on-overflow, fully async drain.
- Extension remote egress is a Web-Store/privacy liability and unreliable under MV3 SW eviction → never default; flag-gated opt-in only.
- Scope creep: this is *signal infrastructure*, not an observability platform — resist BQ/Datadog/dashboards.
- Event-allowlist drift: a curated allowlist (not "forward everything") prevents accidental PII forwarding when other tracks add events.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `services/analytics/index.ts:19-58,60-78,80-123,133-164`; `services/analytics/sink.ts:29-43,48-72,109-114`; `utils/privacyLevel.ts:18-44`.
- browserx core: `utils/logger.ts:1-185` (`:12` `process.env` guard, `:18,157` `localStorage` fallback); `core/events/{EventMapping,IEventRouter,SubAgentEventRouter}.ts`; `core/hooks/HookDispatcher.ts`; `core/sessionSummary/telemetry.ts` (unrelated — excluded); `config/AgentConfig`.
- browserx platforms: server `src/server/health/log-streamer.ts:5,16` (`installStructuredLogging` → stdout + tail), `src/server/handlers/logs.ts:15,25,34,39,48,62` (`emitLog` level-gated WS fan-out — the server sink target); desktop Tauri data-dir file sink; extension `AgentConfig`/`localStorage`-only privacy + MV3 SW eviction constraint.

Corrections vs the first-pass draft:
1. The draft proposed porting claudy's hand-instrumented `logEvent` pattern. Track 01's `core/events`/`core/hooks` already centralize a structured firehose — the design *bridges* that bus (less code, no drift). Biggest divergence; a browserx advantage.
2. Privacy level reads from `AgentConfig`, not `process.env` — the extension SW has no env (and even `GEMINI_DEBUG` falls back to `localStorage`).
3. Confirmed `core/sessionSummary/telemetry.ts` is unrelated.
4. **Multi-platform (2026-05-15):** Apple Pi Server already has a structured-log sink with stdout + `logs.tail` WS fan-out (`log-streamer.ts:16` / `handlers/logs.ts:39`) — the server work is wiring the bridge into existing infra (zero new transport), making this track's largest concrete payoff the headless one. Extension/desktop sinks differ materially (ring-buffer/Noop vs rotating-file) and the privacy source splits config-only (ext) vs config+env (desktop/server) — "one telemetry system" holds only because the sink is pluggable.
