# Track 16: Centralized Telemetry & Analytics

**Priority: P1** · **Effort: M–L** · **Status: IMPLEMENTATION-READY (end-to-end, verification-grounded)**

> Provenance: claudy↔browserx research (2026-05-14), multi-platform pass (2026-05-15), centralization re-scope (2026-05-15), and a **deep end-to-end verification pass (2026-05-15)** that traced every load-bearing integration claim against actual browserx source and re-read claudy's full bootstrap/runtime wiring. Every architectural claim below carries a `file:line`. Claims that could **not** be verified are explicitly marked **UNVERIFIED**. This doc supersedes the "subscribe to the event bus" framing of earlier drafts, which was wrong about the seam — see §3 and "Corrections".

---

## 1. Problem

Browserx has **no centralized telemetry** — it has four scattered, unstructured, privacy-unmodeled diagnostic surfaces with no shared contract:

1. **1,243 raw `console.*` call sites** — no structure, no levels, no sink, no privacy model.
2. **`GeminiLogger`** (`utils/logger.ts`) — a `GEMINI_DEBUG`-gated console tracer. **Verified:** only **2 live calls** exist (`core/models/client/GoogleCompletionClient.ts:215,216`); the other ~15 raw-string/JSON-dump methods are **dead code, never wired**.
3. **`core/sessionSummary/telemetry.ts`** — a `SessionSummaryTelemetry` channel (8 names) that pushes to the engine queue and is **consumed by nobody** (verified: zero readers of `type==='SessionSummaryTelemetry'` outside its own emitter; on server it only lands in the transcript store). Its header already says it "mirrors claudy's `logEvent` pattern" — a correct but isolated precursor.
4. **Server `emitLog`** (`server/handlers/logs.ts:39`) + **`installStructuredLogging()`** (`server/health/log-streamer.ts:16`, called `server/index.ts:68`) — a real structured WS sink, fed by a global `console.*` monkey-patch and exactly one explicit caller.

There is no single API, no privacy enforcement, no platform-pluggable sink. `config/types.ts:274` declares `telemetryEnabled?: boolean` (`configSchema.ts:145`; runtime default `false` via `config/defaults.ts:11`) — a privacy switch **with no consumer**. This track builds the one centralized, privacy-safe system every diagnostic signal flows through, and gives that switch its consumer.

## 2. Goal & definition of "end-to-end done"

The track is functionally complete when, after implementation:

1. A single `logEvent(name, metadata)` core exists, **no-op unless `telemetryEnabled` is true**, with privacy enforced at compile time (marker types + sanitizers).
2. A **`TelemetryBridge`** observes the real central event chokepoint **and a second tap on the scheduler emitter**, emitting a curated, numeric/boolean-only allowlist **without hand-instrumenting call sites**.
3. The four scattered surfaces are subsumed: `SessionSummaryTelemetry` dual-emits through the core; the live `GeminiLogger` call becomes a marker-typed event; `emitLog` becomes a pluggable sink.
4. Each platform has a working sink attached at its bootstrap: server → `emitLog`/`logs.tail`; desktop → rotating file; extension → in-memory ring.
5. With `telemetryEnabled:true` on the server, an operator tailing `logs.tail` sees structured events for tool failures, approvals, aborts, compaction, token/rate-limit pressure, **and scheduled-job lifecycle + abort cause (including pre-session failures)** — and with it `false`, nothing is emitted and the turn loop is provably unaffected. The *"why did a scheduled job abort"* goal is genuinely answered, not partially (see §6 "Second tap").
6. Tests: an injectable fake sink + reset hook verifies exact event names/metadata; a disabled-path test proves the turn loop is uninjured.

## 3. The real integration seam (verified — this was the blocking unknown)

**Earlier drafts said "the bridge subscribes to `IEventRouter` + `HookDispatcher`." That is wrong.** `IEventRouter` is a per-sub-agent transform, not an emitter (`core/events/IEventRouter.ts:11-23`); `Session.eventEmitter` (`core/Session.ts:96,474`) and `HookDispatcher.eventEmitter` (`core/hooks/HookDispatcher.ts:46,56`) are single slots, not pub/sub. There is nothing to "subscribe" to.

**The actual centralized chokepoint is `RepublicAgent.emitEvent` (`core/RepublicAgent.ts:956-977`)** — one private synchronous method that **every** event for a session passes through before transport:

- Session events: `Session.setEventEmitter(async e => this.emitEvent(e.msg))` (`RepublicAgent.ts:76`).
- Hook events (`HookFired`/`HookBlocked`): `hookDispatcher.setEventEmitter(msg => this.emitEvent(msg))` (`RepublicAgent.ts:82`) — so hooks need **no separate wiring**.
- Engine-only + sub-agent events: the `ENGINE_ONLY_EVENTS` whitelist (`RepublicAgent.ts:920-932`) → `emitEvent` via `wireEngineEvents` (`RepublicAgent.ts:934-944`).

`emitEvent` builds the `Event`, pushes to its queue, notifies the user-notifier, then calls a **single swappable `eventDispatcher` slot** (`RepublicAgent.ts:949-951,968-973`). That dispatcher is installed **per session, in one place: `AgentRegistry.createSession`** (`core/registry/AgentRegistry.ts:228-238`) — the `if` branch (`:230`, desktop/server, from `eventDispatcherFactory`) and the `else` branch (`:233-237`, extension, inline ChannelManager).

### Decision: decorator at the `eventDispatcher`, **zero Track-01 change**

The bridge is a **decorator** wrapping the dispatcher that `AgentRegistry` installs. One splice point, both branches:

```ts
// core/registry/AgentRegistry.ts:230 / :233 — wrap whatever dispatcher would be set
const base = /* existing factory result OR inline ChannelManager dispatcher */;
agent.setEventDispatcher(withTelemetry(base, session.sessionId));

// withTelemetry — the ONLY new wiring needed
function withTelemetry(real: EventDispatcher, sessionId: string): EventDispatcher {
  return (event) => {
    try { telemetryBridge.observe(event, sessionId); } catch { /* never propagate */ }
    real(event);                       // real delivery ALWAYS runs, regardless
  };
}
```

Why decorator, not a multiplexer in Track 01:

- **No edits** to `Session.ts` / `HookDispatcher.ts` / `RepublicAgentEngine.ts` — a multiplexer there would duplicate one that effectively already exists upstream (`RepublicAgent.emitEvent`) and widen blast radius on a DONE track.
- One decorator on the per-session dispatcher sees the **complete** stream for that session — session events, hook events, and sub-agent events (they rejoin via `SubAgentEventRouter` → `parentEngine.pushEvent` → `onEvent` → `emitEvent`, `tools/AgentTool/SubAgentRunner.ts:289-327`, `core/events/SubAgentEventRouter.ts:28-49`).

### Verified constraints the implementation MUST honor

- **Latency.** `emitEvent` is synchronous `void` and the dispatcher is fire-and-forget (`RepublicAgent.ts:968`), **but** the Session-side adapter `async e => this.emitEvent(e.msg)` is `await`-ed by `Session.sendEvent`/`emitEvent` callers (`Session.ts:497,1558,1755,2669`). So a synchronous-slow tap **adds turn-loop latency**. → `observe()` must do *enqueue + sample only*, never `await` network/disk inline. This is exactly why the core uses claudy's queue-then-drain + fire-and-forget (§4).
- **Error isolation.** `emitEvent`'s own try/catch (`RepublicAgent.ts:969-973`) would swallow the *real* event if the decorator threw before forwarding. → the decorator wraps its telemetry call in its own try/catch and **always** calls `real(event)` (shown above). The sink contract must also never throw to the caller (§4).
- **Sub-agent coverage limit.** Sub-agent **delta** events are suppressed by default (`SubAgentEventRouter.ts:18-25`) and only `ENGINE_ONLY_EVENTS` (`RepublicAgent.ts:920-932`, includes `SubAgentStart/Complete/Error`) are forwarded. Sub-agent lifecycle/cost telemetry works; inner sub-agent token-level telemetry is intentionally not available via this seam. Documented limit, not a bug. `_subAgent.{engineId,parentEngineId,depth}` are safe numeric/id dimensions when present.
- **Scheduler is a separate emitter family — handled by a designed second tap, not excluded.** `Scheduler`/`JobExecutor` events feed `channelManager` directly and **do not pass through `RepublicAgent.emitEvent`** (verified). Because the *"why did a scheduled job abort"* goal lives almost entirely here (unattended fleet jobs), the bridge gets a **second tap on the scheduler emitter** — see §6 "Second tap". Per-job cost remains Track 18's via `handleSchedulerEventCompletion` (`ServerAgentBootstrap.ts:692-726`); the scheduler tap is lifecycle/abort-cause, complementary.

## 4. The centralized core (Phase 1) — ported from claudy, hardened for our hot seam

New leaf module `core/telemetry/` (no imports from app code → no cycles; claudy `index.ts:6-9` rationale, verified `AgentConfig.ts:5-29` has no telemetry import so the dependency direction is clean).

- **`core/telemetry/analytics.ts`** — port claudy `services/analytics/index.ts:19-173` near-verbatim: `logEvent(name, metadata)` / `logEventAsync`; `LogEventMetadata = {[k]: boolean|number|undefined}`; marker types `TelemetryMeta_VERIFIED_NOT_CONTENT` / `TelemetryMeta_VERIFIED_PII_TAGGED` (= `never`); `stripProtoFields()`; idempotent `attachSink`; `queueMicrotask` drain (FIFO within the pre-attach batch — claudy `index.ts:103-121`); `_resetForTesting()`.
- **Divergence from claudy — bounded queue (mandatory, not optional).** Claudy's `eventQueue` is **unbounded with no drop policy** (verified `index.ts:81,140`); it survives only because every entrypoint guarantees an attach. Our bridge taps a *hot* event stream, so the pre-attach queue **must** be bounded (e.g. cap 1000) with **drop-oldest** + a dropped-count counter. This is the single most important hardening over a verbatim port.
- **`core/telemetry/sanitize.ts`** — port claudy `metadata.ts` discipline: every helper that yields a string for telemetry returns the marker type. `sanitizeToolName` (builtin pass-through; non-builtin/MCP → `'mcp_tool'`), `boundedEnum`, `numericOnly`, `errorClass(err)` (→ `err.constructor.name`, never the message). Strings enter telemetry *only* via these.
- **Error isolation (replicate claudy's guarantee, verified `datadog.ts:182-278`, `firstPartyEventLogger.ts:198-206`):** `logEvent` is sync-void and never throws; the sink interface `write(event)` is sync-void; every sink implementation self-contains exceptions; any async work inside a sink is `void`-ed/fire-and-forget. Net: a telemetry fault can never interrupt a turn.
- **Privacy/test gate placement.** Claudy gates *per-backend, after the sink*, leaving the queue privacy-agnostic (verified — no gate in `index.ts`/`sinks.ts`; gate in `config.ts:19-27`). **Divergence:** because our queue must stay bounded and our seam is hot, gate **at `logEvent` entry** (and additionally short-circuit `observe()` in the bridge). If `getPrivacyLevel()==='no-telemetry'`, return before enqueueing — don't fill a bounded queue with work that will be discarded.

## 5. Privacy model (verified against the real config API)

`core/telemetry/privacy.ts` — **zero-dep, pure**; the *caller* reads config and passes the value in (keeps the core acyclic; `AgentConfig` is async-acquired and must not be imported by the leaf core):

```ts
export type PrivacyLevel = 'no-telemetry' | 'essential-traffic';

export function resolvePrivacyLevel(
  telemetryEnabled: boolean | undefined,   // from AgentConfig (read by caller)
  envOptOut: boolean,                       // from readEnvOptOut()
): PrivacyLevel {
  if (envOptOut) return 'no-telemetry';                 // env can only LOWER (fail-closed)
  return telemetryEnabled === true ? 'essential-traffic' : 'no-telemetry';
}

export function readEnvOptOut(): boolean {              // extension-safe guard, lifted from logger.ts:12
  if (typeof process !== 'undefined' && process.env?.APPLEPI_NO_TELEMETRY) {
    return process.env.APPLEPI_NO_TELEMETRY !== 'false' && process.env.APPLEPI_NO_TELEMETRY !== '0';
  }
  return false;
}
```

Verified facts driving this:

- Access: `(await AgentConfig.getInstance()).getConfig().preferences.telemetryEnabled` — async once, sync read (`AgentConfig.ts:53-60,122-125`); runtime default `false` from `config/defaults.ts:11` (the Zod `.default(false)` at `configSchema.ts:145` is **not** applied by `getConfig()`).
- **Read live, not cached:** no `preferences`-section change event fires on toggle (`AgentConfig.ts:148-151`), and server hot-reload mutates `currentConfig` in place via `config.reload()` (`ServerAgentBootstrap.ts:349`). A live sync read picks up changes; a cached boolean goes stale.
- Env: extension never reads `process.env` (guard makes `readEnvOptOut()` a safe no-op); server has dotenv (`server/index.ts:27`); **desktop `process.env` availability is UNVERIFIED** (zero `process.env` in `src/desktop/**`) — the guard makes it a safe config-only no-op there. New env var `APPLEPI_NO_TELEMETRY` (matches the existing `APPLEPI_*` convention; no telemetry env var exists today).
- **No managed/policy/`lockedKeys` layer exists today** (verified: zero matches across `src/`). Track 20 is entirely future; **the baseline must not depend on it.** When Track 20 lands it can lock this key — additive, not required.

## 6. The bridge (Phase 2) — concrete allowlist

`core/telemetry/TelemetryBridge.ts`. `observe(event, sessionId)`: privacy-gate → match `event.msg.type` against the allowlist → extract **only** the listed numeric/boolean/bounded-enum fields via `sanitize.ts` → `logEvent(name, meta)`. Bounded internal handling, drop-on-overflow, never awaits. Curated allowlist (full per-field privacy classification verified against `core/protocol/events.ts:28-819` and `core/hooks/types.ts:16-192`):

| EventMsg `type` | Telemetry name | Safe metadata extracted | Excluded (unsafe) |
|---|---|---|---|
| `TaskStarted` | `task.started` | `model` (enum), `tabId`, `review_mode`, `auto_compact`, `compaction_threshold`, `tools` (names), `turn_type` | `*_policy` objects, `reasoning_*`, `submission_id` |
| `TaskComplete` | `task.completed` | `turn_count`, `token_usage.*` (numeric), `compaction_performed`, `aborted`, `abort_reason` (enum) | `last_agent_message`, `input_messages` |
| `TurnStarted`/`TurnComplete`/`TurnAborted`/`TurnRetry` | `turn.*` | `success`, `reason` (enum), `turn_count`, `attempt` | `message`, free-text `reason` |
| `CompactionCompleted` | `compaction.completed` | `success`, `tokensBefore`, `tokensAfter`, `itemsTrimmed`, `compactionCount`, `triggerReason` | `error` |
| `ToolExecutionStart/End/Error/Timeout` | `tool.exec.*` | `tool_name` (sanitized), `success`, `duration`, `timeout_ms` | `params`, `error` string |
| `McpToolCallEnd` | `tool.mcp.end` | `tool_name` (sanitized), `duration_ms` | `result`, `error` |
| `ApprovalRequested/Granted/Denied/AutoApproved/PolicyChanged` | `approval.*` | `tool_name`, `risk_score`, `risk_level`, `risk_factors` (enums), `mode`, `previousMode`, `timestamp` | `explanation`, `command`, free-text `reason` |
| `HookFired` / `HookBlocked` | `hook.fired` / `hook.blocked` | `hook_event_name` (enum), `hook_count`, `tool_name` | `stop_reason` |
| `TokenCount` | `usage.tokens` | all token counts + all `rate_limits` percentages/ratios/windows (all numeric) | — (none) |
| `WebSearchEnd` | `web_search.completed` | `results_count` | `query`, `result`, `error` |
| `ExecCommandEnd` | `exec.completed` | `exit_code`, `duration_ms` | (begin/output deltas excluded entirely) |
| `SubAgentStart/Complete/Error` | `subagent.*` | `subAgentType` (enum), `turnCount`, `tokenUsage.*`, `duration`, `_subAgent.depth` | `description`, `error` |
| `BackgroundTaskStateChanged/Terminated` | `bg_task.*` | `status` (enum), `prevStatus`, `durationMs`, `kindCounts.*` | `description`, `summary` |
| `Error` / `StreamError` / `TaskFailed` | `error.occurred` | `code` (enum), `retrying`, `attempt`, `errorClass` (via `sanitize.errorClass`) | `message`, `error`, `reason` (raw) |

**Hard-excluded categories (never bridged):** all message/reasoning/delta events (`AgentMessage*`, `UserMessage`, `*ReasoningDelta`, `AgentReasoningRawContent*`), `ExecCommandOutputDelta`, `*ApprovalRequest` raw `command`/`patch`, `Patch*`/`TurnDiff` paths/diffs, `DOM/Storage/NavigationActionStart` selectors/urls/keys, `*Snapshot*`/history blobs, `Notification` text. The bridge is an **allowlist** — unknown/new event types are ignored by default, so adding events to Track 01 later cannot accidentally leak.

### Second tap — the scheduler emitter (closes the "why did a scheduled job abort" goal)

The agent-side decorator cannot see scheduler events (verified: scheduler is a parallel emitter family). The scheduler emitter surface is **exactly one slot**: `Scheduler.eventEmitter` (`core/scheduler/Scheduler.ts:60`, type `SchedulerEventEmitter = (event: Record<string,unknown>) => void` `:33-35`, single-slot/sync/fire-and-forget). `Scheduler.setEventEmitter` (`:98-106`) also funnels `JobExecutor`'s emitter back through that same slot, so **one tap captures the entire scheduler+executor stream** (`JobExecutor.setEventEmitter` needs no separate tap; `ScheduleManager` has no emitter — verified). All three platforms wire it **only** via `Scheduler.connectToChannel()` (`Scheduler.ts:119-135`), called at `ServerAgentBootstrap.ts:619`, `DesktopAgentBootstrap.ts:567`, `service-worker.ts:487`.

**Mechanism (decorator-consistent with the agent side):** add one optional `tap?: (e: Record<string,unknown>) => void` parameter to `Scheduler.connectToChannel` (`Scheduler.ts:119`), invoked inside the existing emitter closure *before* `dispatchEvent` (`Scheduler.ts:123-134`). One small core change; the three platforms pass `withSchedulerTelemetry(...)` at the three cited call sites. Reuse a shared `withTelemetry(emitter, allowlist)` helper so both taps stay consistent. The scheduler stream is **already telemetry-clean** — verified: only two event shapes, **no free-text fields** (error strings/summaries go to storage, never the emitter):

| Telemetry name | Source (verified) | Safe metadata |
|---|---|---|
| `scheduler.execution` | Shape A, `JobExecutor.ts:420-429` | `status` (enum `running\|completed\|failed\|cancelled`), `timestamp` (num), `executionId`/`scheduleEventId` (ids) |
| `scheduler.state` | Shape B, `Scheduler.ts:466-470` | `isPaused` (bool), `currentJobId` (id\|null) |

**Honest gap — the tap alone does NOT fully deliver the goal.** Verified: the highest-value pre-session abort causes emit **no event at all** — session/agent-create failure is swallowed (`JobExecutor.ts:150-153,313-323`), null/throwing launcher (`:398-405`), connectivity/paused gate (`:288-290`), mutex deferral (`:127-133`, `'pending'` never emitted), missed/mis-fired instances (`ScheduleManager.getMissedInstances` — count-logged only), concurrent-trigger rejection (`:120-122`). The only failure signal is a post-hoc generic `status:'failed'` with **no machine-readable cause**. Therefore closing the goal requires, in addition to the tap, a **bounded core scheduler change**: add a numeric/enum `failureReason` (`session_create_failed | no_launcher | offline | mutex_queued | missed | concurrent | launcher_error | stale_recovered | agent_error`) to the emitted event and emit it at those ~6 currently-silent sites. This is enum-only (privacy-clean) and small, but it **does touch the scheduler core**, not just the bootstrap seam — called out so the track owner accepts that scope consciously. Without it the tap answers "did the job run / succeed / fail" but not "why did it abort before a turn ran"; with it the §2 goal is genuinely met.

> **As built (implementation outcome):** `failureReason` is emitted where there is an execution record and control flow is unchanged: `launcher_error` (launcher throws — the goal-closing "aborted at launch" case), `session_create_failed` (tagged on the `running` emit, first-run + pending paths), `stale_recovered`, `agent_error` (external `failJob` default), `mutex_queued` (on the deferred pending record). The **null-launcher** path is left **silent residue** — routing it through `failExecution` regressed the documented "no-launcher = silent" scheduler contract (and an existing FIFO test); `no_launcher` stays a reserved-but-unemitted enum value. `concurrent`/`offline`/`missed` remain residue (no execution record at the point they occur). Net: the high-value pre-turn cause (**launcher failure**) is attributable; the goal is met for every case with a clean, regression-free representation.

`handleSchedulerEventCompletion` (`ServerAgentBootstrap.ts:692-726`; desktop `DesktopAgentBootstrap.ts:662-696`; **no extension equivalent** — verified) optionally enriches the `completed`/`failed` event with `duration` + Track-18 `token_usage.total` (numeric) on server/desktop.

## 7. Subsuming the four scattered surfaces (verified specifics)

- **`SessionSummaryTelemetry` — dual-emit, zero behavior change.** `createTelemetryEmitter` (`core/sessionSummary/telemetry.ts:26-51`) gains an optional 3rd param `telemetryCore` (default no-op so `NO_OP_TELEMETRY`/tests are untouched, callers like `SessionSummaryHook.ts:101` need no change). `emit()` keeps the existing `parentEngine.pushEvent(...)` **exactly as-is** (server transcript-store consumer preserved), and *additionally* calls `logEvent('session_summary.'+event, sanitized)`. The 8 events' payloads are known (`SessionSummaryHook.ts:155,232,329,375,392`; `CompactService.ts:117,124,141,212`); pass numerics through (`duration_ms`, `content_length`, `token_count`, `tokens_before/after`, `summary_token_count`, `waited_ms`, `success`, `manual`, `stale`), keep bounded `trigger`/`final_status`, and **strip** the three privacy-sensitive fields: `memoryRoot` (fs path), `config` (full snapshot), `error` (→ `errorPresent:boolean` + `errorClass`).
- **`GeminiLogger` — tiny, mostly dead.** Only 2 live calls (`GoogleCompletionClient.ts:215` `stateReset()`, `:216` `streamStart(model, convId)`). Replace `:216` with `logEvent('gemini.stream_start', { model })` (drop the synthetic `'conversation-'+Date.now()`); drop `:215`. Optionally add one numeric `logEvent('gemini.stream_end', { chunkCount, accumulatedTextLen, toolCallCount, finishReason })` at `GoogleCompletionClient.ts:447` (all values in scope there). The ~15 dead raw-string methods are **not** ported. Keep `GeminiLogger` itself as the opt-in, `GEMINI_DEBUG`, console-only path (never reaches a sink) for verbose local debugging.
- **Server `emitLog` → `ServerLogSink`.** Implements the sink contract; maps a marker event → `emitLog(level, markerName, sanitizedPayload)` where `level` is `'error'/'warn'` for failure markers else `'info'`, `message` is the bounded marker name, `data` is the **already-core-sanitized** numeric payload. Attach **after** `registerLogsHandlers()` (`ServerAgentBootstrap.ts:477`) so the subscriber map is live. It calls `emitLog` directly and is **independent of** the `installStructuredLogging()` console monkey-patch — that raw-`console` leak (`server/index.ts:68`) is **left untouched and explicitly out of scope** (narrowing it is separate work).

## 8. Per-platform sinks (Phase 3) — real APIs, honest constraints

- **Server** — `src/server/telemetry/ServerLogSink.ts` → `emitLog` (above). Optional spill: `join(getDataDir(), 'telemetry')` (`server-config.ts:161-163`; **not** "Track 09" — that is unrelated tool-result persistence; prior draft's "reuse Track 09 dataDir" was wrong). Attach at `ServerAgentBootstrap.ts:477`; privacy from `agentConfig` already loaded at `:144`. Default-capable (in-infra, no egress).
- **Desktop** — rotating-file sink. **Verified constraint:** no JS append API exists; `@tauri-apps/api/path` gives directories only and the only generic JS→disk write is `invoke('skills_write_file', {path, content})` which is **overwrite-only** (`tauri/src/skills_commands.rs:59-63`). → implement rotation **TS-side**: in-memory buffer, periodic `skills_read_file`+`skills_write_file` rewrite, roll filename on size cap; directory from `getLogPath()`→`appLogDir()` (`src/desktop/platform/paths.ts:135`). **UNVERIFIED/flagged:** true append would need a new Rust command — the TS-rewrite approach avoids that and stays within existing APIs. Attach in `DesktopAgentBootstrap.initialize()` after `config` at `:93`, before `registry.initialize(config)` at `:155`.
- **Extension** — bounded in-memory ring (module-singleton). **Verified:** no fs in the SW; no existing ring/diagnostic buffer; SW is evicted ~30s idle (`service-worker.ts:1517-1539`) so the buffer is **best-effort/ephemeral by design**. Default sink stays `NoopSink`; the ring is opt-in. Attach in `doInitialize()` after `agentConfig` at `service-worker.ts:211`, before `registry.initialize` at `:232`. **`/doctor`/Track 17 do not exist yet (UNVERIFIED future work)** — when built, it reads the ring via the established `serviceRegistry.register('diagnostics.dump', …)` pattern (`service-worker.ts:443-600`). Baseline does **not** depend on Track 17.
- All platforms: `NoopSink` default; the platform attaches its sink only if `resolvePrivacyLevel(...) !== 'no-telemetry'`.

## 9. Optional OTEL (Phase 4, flag-gated, not required for done)

Dynamically-imported OTLP sink behind a Track 22 `feature()` flag, mirroring claudy's per-protocol lazy-import isolation (`init.ts:305-311`, `instrumentation.ts:165-193`); never bundled by default; desktop/server only. Not part of the end-to-end definition of done (§2).

## 10. End-to-end test strategy & definition of done

- **Injectable fake sink + reset** (claudy's testability contract, `index.ts:170`): `_resetForTesting()` in `beforeEach`, then `attachSink({write: spy})`; assert exact event names + numeric/boolean metadata and FIFO drain order.
- **Disabled-path test:** `telemetryEnabled:false` → drive a full turn with tool calls/approvals/compaction; assert zero `write` calls **and** the turn completes uninjured (the §3/§4 isolation guarantee). Also assert a throwing sink does not break the turn.
- **Bridge mapping test:** feed representative `EventMsg` values through `observe()`; assert allowlist mapping and that excluded/unknown types produce nothing.
- **Scheduler tap test:** drive the scheduler through `running`/`completed`/`failed`/`cancelled` and each `failureReason` site; assert `scheduler.*` events with enum/numeric metadata only. A pre-session failure (e.g. session-create failure path) produces a `scheduler.execution` event with the right `failureReason` — the goal-closing assertion.
- **Server integration test:** `telemetryEnabled:true`, attach `ServerLogSink`, drive a session **and a scheduled job that aborts pre-session**, assert `logs.tail` receives the marker events (incl. the scheduler abort cause) with sanitized payloads and **no raw strings**.
- **Privacy unit tests:** `resolvePrivacyLevel` truth table; `readEnvOptOut` guarded no-op without `process`.

"Done" = §2 items 1–6 all green in CI.

## 11. Implementation plan (ordered; every phase independently buildable)

1. **Phase 1 — core.** `core/telemetry/{analytics,sanitize,privacy}.ts` + `NoopSink` + `_resetForTesting`. **Bounded** queue. Unit tests (privacy table, marker discipline, error isolation, bounded-drop). No wiring → all builds still emit nothing. *Buildable & testable in isolation.*
2. **Phase 2 — bridge + both taps + subsumption.** `TelemetryBridge` + allowlist; the `withTelemetry` decorator at `AgentRegistry.ts:230/233`; the **scheduler tap** (`connectToChannel` `tap?` param `Scheduler.ts:119` + 3 call sites) and the **bounded `failureReason` enum** at the ~6 silent scheduler sites (the only scheduler-core change — enum-only, privacy-clean); rewire `createTelemetryEmitter` (dual-emit) and the 2 `GeminiLogger` calls. Bridge mapping + scheduler + disabled-path tests. *After this, signal is centralized; with no sink attached it's still a no-op.*
3. **Phase 3 — per-platform sinks + attach.** `ServerLogSink` (+ attach `ServerAgentBootstrap.ts:477`), desktop rotating-file (+ attach `DesktopAgentBootstrap.ts:~93`), extension ring (+ attach `service-worker.ts:~211`); privacy read at each. Server integration test (incl. a scheduled-job abort visible on `logs.tail`). **End-to-end goal achieved here.**
4. **Phase 4 (optional) — OTEL** behind Track 22 flag.

## 12. Dependencies (reconciled)

- **Track 01 (DONE):** the seam is `RepublicAgent.emitEvent`/`AgentRegistry` dispatcher — **no Track-01 change required** (decorator). Hard reuse, verified.
- **Track 12:** `RateLimitWaiting/Warning/ModelDowngraded` are Track 01 `EventMsg` (`12_rate_limit:107`) → **bridged for free**, not net-new instrumentation.
- **Track 18:** cost counter / per-job cost is genuinely non-evented → net-new `logEvent`; server cost rides `ServerLogSink`. The scheduler tap's optional `handleSchedulerEventCompletion` enrichment (`duration` + `token_usage.total`) is shared seam with Track 18 — coordinate so the cost extraction isn't duplicated.
- **Scheduler (Track 01-adjacent, separate emitter):** second tap via `Scheduler.connectToChannel` `tap?` param — verified single-slot, telemetry-clean. The `failureReason` enum is the one in-scope scheduler-core change.
- **Track 17 (does not exist yet):** baseline is independent. Bidirectional later: `/doctor` reads sink/queue health + the extension ring; Track 17's diagnostic-output redaction reuses `core/telemetry/sanitize.ts` (shared export).
- **Track 20 (does not exist yet):** baseline is independent. Later, `telemetryEnabled`/privacy level can become a locked key — additive.
- **Track 22 (future):** OTEL sink ships dark via its `feature()` seam (Phase 4 only).

## 13. Risks & explicitly flagged UNVERIFIED items

- **Turn-loop latency** if `observe()` does anything but enqueue/sample — the Session adapter is awaited (`Session.ts:497` etc.). Mitigation: synchronous-cheap tap + bounded queue + fire-and-forget drain (§3/§4). **Highest-attention risk.**
- **Privacy:** marker types + sanitizers are the enforcement; the bridge is allowlist-only; never route the `installStructuredLogging` console monkey-patch through the sink.
- **Bounded queue is mandatory** (claudy's is unbounded; our seam is hot) — drop-oldest + counter.
- **UNVERIFIED — desktop `process.env`:** none found in `src/desktop/**`; env opt-out is a guarded no-op there (config-only, fail-closed) — acceptable.
- **UNVERIFIED — desktop append:** no append API; rotation must be TS-side rewrite or a new Rust command (flagged, avoided).
- **UNVERIFIED — `/doctor`/Track 17 & Track 20/managed settings:** do not exist; baseline must not depend on them (it doesn't).
- **Scheduler `failureReason` touches the scheduler core** (not just the bootstrap seam) — the only core change beyond the decorator pattern. Bounded (enum-only, ~6 emit sites) and privacy-clean, but the track owner must accept modifying the scheduler subsystem. Without it the goal is only partially met (see §6 "Second tap"). **This is the one conscious scope decision in the track.**
- **UNVERIFIED — pre-turn-1 rate-limit/auth → scheduler:** whether such a failure reliably produces a `TaskFailed`/`TurnAborted`/`Error` reaching `handleSchedulerEventCompletion` is unverified (comment at `ServerAgentBootstrap.ts:715` says `TaskFailed` is "currently not emitted by TaskRunner"). The `agent_error` `failureReason` covers what does reach it; the rest is the documented residue.
- **Flagged pre-existing bug (out of scope):** extension scheduled-job completion (`webfront/pages/chat/Main.svelte:882-885`) sends a shape that violates `JobResultRecord` (`Scheduler.ts:35-48`) → extension scheduled jobs carry no `tokenUsage`/`duration` regardless of the tap. Note, don't fix here.
- **Out of scope:** narrowing the pre-existing console monkey-patch leak.
- **Sub-agent telemetry** is lifecycle-level only (delta events suppressed; only `ENGINE_ONLY_EVENTS` forwarded) — documented limit.

## 14. Validation notes / corrections vs prior drafts

- **Verified browserx (2026-05-15):** chokepoint `core/RepublicAgent.ts:956-977` (wiring 76/82, dispatcher 949-951/968, engine bridge 920-944); splice `core/registry/AgentRegistry.ts:228-238`; emitter single-slots `Session.ts:96/474`, `HookDispatcher.ts:46/56`; sub-agent `SubAgentEventRouter.ts:18-49`, `SubAgentRunner.ts:289-327`; events `core/protocol/events.ts:28-819`; hooks `core/hooks/types.ts:16-192`; config `AgentConfig.ts:53-60/122-125/148-151`, `config/defaults.ts:11`, `config/types.ts:274`, `configSchema.ts:145`; bootstrap attach `service-worker.ts:211/232`, `DesktopAgentBootstrap.ts:93/146-153/155`, `ServerAgentBootstrap.ts:144/198-215/477`; subsumption `core/sessionSummary/telemetry.ts:26-51`, `GoogleCompletionClient.ts:215-216/447`; sinks `server/handlers/logs.ts:39`, `server/health/log-streamer.ts:16`, `paths.ts:135`, `tauri/src/skills_commands.rs:59-63`, `server-config.ts:161-163`.
- **Verified scheduler emitter (2026-05-15):** `core/scheduler/Scheduler.ts:33-35/60/98-106/119-135/261-267/466-470`; `core/scheduler/JobExecutor.ts:50-55/64/97-99/120-133/145-156/166/198/227/256/288-290/313-323/331/359/388-405/420-429`; `ScheduleManager` has no emitter (verified); platform wiring `ServerAgentBootstrap.ts:619/692-726`, `DesktopAgentBootstrap.ts:567/662-696`, `service-worker.ts:487` (no extension `handleSchedulerEventCompletion`); pre-existing shape bug `webfront/pages/chat/Main.svelte:882-885` vs `Scheduler.ts:35-48`.
- **Verified claudy (2026-05-15):** core `services/analytics/index.ts:19-173` (queue unbounded `:81/140`, drain `:103-121`, `_resetForTesting :170`); bootstrap order `utils/sinks.ts:13-16`, `setup.ts:371`; error isolation `datadog.ts:182-278`, `firstPartyEventLogger.ts:198-206`; gate placement `config.ts:19-27`, `privacyLevel.ts:42-44`; **confirmed no central event-bridge exists in claudy (1091 hand-instrumented sites)** — our bridge is genuine net-new design, not a port.
- **Corrections vs prior drafts:** (1) the seam is `RepublicAgent.emitEvent`+decorator, **not** "subscribe to IEventRouter/HookDispatcher" — that earlier claim was false; (2) bounded queue is mandatory (claudy's is unbounded); (3) privacy/test gate moves to `logEvent` entry (claudy gates per-backend; our queue is bounded so we can't fill-then-discard); (4) GeminiLogger subsumption is trivial (mostly dead code), not a large port; (5) telemetry sink target is `getDataDir()`/`emitLog`, **not** "Track 09 dataDir"; (6) baseline is fully independent of Tracks 17/20 (neither exists); (7) Phase 3 — not Phase 4 — is where the end-to-end goal is achieved; (8) **scheduler telemetry moved from "out of scope" to a designed second tap** — verified the scheduler emitter is a single telemetry-clean slot, but the *"why did a scheduled job abort"* goal additionally requires a bounded enum `failureReason` in the scheduler core (the one conscious scope decision; without it the goal is only partially met).
