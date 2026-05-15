# Track 16: Telemetry & Analytics

**Priority: P1** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's analytics core and browserx's logging/event surface — see "Validation Notes".

## Problem

BrowserX has **zero field observability**. The only logging is `GeminiLogger` (`src/utils/logger.ts`) — a `console.log` debug tracer gated on `GEMINI_DEBUG`, hard-wired to Gemini streaming, no structure, no sink, no privacy model. (`core/sessionSummary/telemetry.ts` is an unrelated session-summary helper, not a telemetry system.) An unattended multi-platform agent (extension/desktop/server) cannot answer "which tools fail in the field, where do approvals stall, why do sessions abort."

## What Claudy Does

### Zero-dependency public API — `services/analytics/index.ts`

`logEvent(name, metadata)` / `logEventAsync` (`:133-164`). The metadata type is the crux:

```ts
type LogEventMetadata = { [key: string]: boolean | number | undefined }   // NO strings
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never
```

A string can only enter telemetry by an explicit `value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` cast — a **compile-time forced review** that the value is not code/paths/PII. PII routes through `_PROTO_*` keys; `stripProtoFields()` (`:45-58`) removes them before any general-access sink.

**Queue-then-drain** (`:80-123`): events buffer in `eventQueue` until `attachAnalyticsSink(sink)` (idempotent, `:95-123`) drains them via `queueMicrotask`. No sink ⇒ events queued, never lost, never block startup. The module has **no imports** to avoid cycles. `_resetForTesting()` (`:170`).

### Sink fan-out — `services/analytics/sink.ts`

`initializeAnalyticsSink()` (`:109-114`) attaches `{logEvent: logEventImpl, logEventAsync}`. `logEventImpl` (`:48-72`): sampling (`shouldSampleEvent`), per-backend gate with **stale-cache fallback** (`shouldTrackDatadog` `:29-43`) and a JSON **kill-switch** (`isSinkKilled('datadog')`), then fan-out to Datadog (PROTO-stripped) + 1P (full). Fire-and-forget.

### Privacy levels — `utils/privacyLevel.ts`

Ordered `'default' < 'no-telemetry' < 'essential-traffic'` (`:18-28`), most-restrictive-wins from env (`DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`). `isTelemetryDisabled()` / `isEssentialTrafficOnly()` gate every network/telemetry call site.

## BrowserX Mapping

### The real seam — tap the existing event bus, don't re-instrument

| Concern | BrowserX location | State |
|---|---|---|
| Only logging today | `GeminiLogger` (`utils/logger.ts`) | console-only, `GEMINI_DEBUG`-gated debug tracer |
| Structured event stream | Track 01: `core/events/` (`EventMapping.ts`, `IEventRouter.ts`, `SubAgentEventRouter.ts`); `EventMsg` via `Session.sendEvent` (SQ/EQ) | **Already a centralized structured event firehose** |
| Hook stream | Track 01: `core/hooks/HookDispatcher.ts` (`PermissionRequest`, `PermissionDenied`, `UserPromptSubmit`, …) | Already fires structured hook events |
| Privacy/config | `config/AgentConfig` (no `process.env` in the extension service worker) | Privacy level must come from config, not only env |
| Unrelated | `core/sessionSummary/telemetry.ts` | Session-summary helper — do **not** conflate |

### Key design decisions (and divergences from claudy)

1. **Port the zero-dep queue-then-drain core almost verbatim.** `core/telemetry/analytics.ts`: no imports, `eventQueue`, idempotent `attachSink()`, `queueMicrotask` drain, `NoopSink` default, `_resetForTesting()`. This shape is correct as-is for a multi-platform agent.

2. **Copy the privacy marker-type discipline exactly — this is the highest-value port.** `metadata: {[k]: boolean|number|undefined}`, strings only via an explicit `…_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` cast, `stripProtoFields()` for PII keys. For a browser agent that sees URLs, DOM, form values and credentials, a *compile-time* guarantee that telemetry can't accidentally carry them is non-negotiable. Keep the long ugly type name — its ugliness is the point.

3. **Tap the Track 01 event bus instead of hand-instrumenting (major divergence from claudy).** Claudy sprinkles `logEvent(...)` across hundreds of call sites. BrowserX already centralized a structured `EventMsg`/hook firehose in Track 01. Add a `TelemetryBridge` that subscribes to `IEventRouter` + `HookDispatcher` and maps a curated allowlist of events → `logEvent`. Net-new `logEvent` calls only where no event exists yet (rate-limit waits → Track 12, cost → Track 18, migrations → Track 19). Far less code, far less drift, and impossible to "forget to instrument."

4. **Privacy level from config, not env.** `getPrivacyLevel()` reads `AgentConfig` (with an env override on desktop/server where env exists). Same ordered `default < no-telemetry < essential-traffic` semantics; can be policy-locked by Track 20. The bridge is inert unless level is `default` *and* a sink is attached.

5. **No-op by default; ships dark.** `NoopSink` until startup explicitly attaches one *and* config opts in. Default browserx build emits nothing.

6. **Skip Datadog / 1P / BigQuery / GrowthBook entirely** (claudy-infra-specific). The only concrete sink worth an optional adapter is OTEL, **dynamically imported** behind a Track 22 feature flag (claudy's `utils/telemetry/` already isolates OTEL exporters per-protocol — mirror that lazy-load, not the BQ machinery).

### Phase plan

- **Phase 1:** zero-dep `core/telemetry/analytics.ts` (queue-then-drain, `NoopSink`, marker-type metadata, privacy level from config); no sink wired.
- **Phase 2:** `TelemetryBridge` subscribing to Track 01 `IEventRouter` + `HookDispatcher`; curated event allowlist (tool exec/fail, approval ask/grant/deny, session start/abort/compact).
- **Phase 3:** pluggable sink + JSON kill-switch + sampling; net-new `logEvent` for non-evented signals (Track 12 rate-limit, Track 18 cost, Track 19 migrations).
- **Phase 4 (optional, flag-gated):** dynamically-imported OTEL sink (no BQ/Datadog).

## Dependencies

- **Track 01** (Hooks/Events): the bridge subscribes to `IEventRouter`/`HookDispatcher` — hard reuse
- **Track 12/18/19**: emit telemetry for signals that aren't already events (rate-limit waits, cost, migrations)
- **Track 20** (Managed Settings): privacy level can be a policy-locked key
- **Track 22** (Feature Flags): OTEL sink ships dark via `feature()`
- **Track 17** (Diagnostics): `/doctor` surfaces sink/queue health

## Risks

- Privacy is existential for a browser agent: default-exclude strings, hard-gate PII via `_PROTO_*`+strip, **never** log URLs/page bodies/DOM/form values. The marker-type discipline is the enforcement — do not relax it for convenience.
- The bridge must never block the turn loop or event delivery: bounded queue, drop-on-overflow, fully async drain (claudy's `queueMicrotask` model).
- Scope creep: this is *signal infrastructure*, not an observability platform — resist BQ/Datadog/dashboards.
- Event-allowlist drift: a curated allowlist (not "forward everything") prevents accidental PII forwarding when new events are added in other tracks.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `services/analytics/index.ts:19-58` (marker types + `stripProtoFields`), `:60-78` (`LogEventMetadata`/`AnalyticsSink`), `:80-123` (queue + idempotent `attachAnalyticsSink` + `queueMicrotask` drain), `:133-164` (`logEvent`/`logEventAsync` queue-if-no-sink); `services/analytics/sink.ts:29-43` (gate + stale-cache + kill-switch), `:48-72` (`logEventImpl` sampling/strip/fan-out), `:109-114` (`initializeAnalyticsSink`); `utils/privacyLevel.ts:18-44` (ordered levels, most-restrictive-wins).
- browserx: `utils/logger.ts:1-185` (`GeminiLogger` — the only logging, console+`GEMINI_DEBUG`); `core/events/{EventMapping,IEventRouter,SubAgentEventRouter}.ts` + `core/hooks/HookDispatcher.ts` (Track 01 structured stream — the bridge target); `core/sessionSummary/telemetry.ts` (unrelated — excluded); `config/AgentConfig` (privacy-level source; no service-worker `process.env`).

Corrections vs the first-pass draft:
1. The draft proposed porting claudy's hand-instrumented `logEvent` pattern. Reading Track 01's `core/events`/`core/hooks` showed browserx **already centralized a structured event firehose** — the design now *bridges* that bus instead of re-instrumenting hundreds of call sites (less code, no drift, can't forget to instrument). This is the biggest divergence and a browserx advantage.
2. Privacy level must read from `AgentConfig`, not `process.env` — the extension service worker has no env; the draft assumed claudy's env model.
3. Confirmed `core/sessionSummary/telemetry.ts` is unrelated (session-summary helper), so "browserx has nothing" stands for *analytics*; clarified to avoid a false "partial" reading.
