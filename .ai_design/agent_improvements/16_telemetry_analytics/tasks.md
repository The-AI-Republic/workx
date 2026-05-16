# Track 16 — Tasks

See `design.md` for the verified seam, allowlist, and per-claim `file:line` evidence. Phases mirror design §11; every phase is independently buildable. All `file:line` anchors below are the verified ones from design §14 — do not re-derive.

Convention: `- [ ] N.M` work item; `Test:` lines are required acceptance checks. **UNVERIFIED** items are explicit spikes/decisions, not assumptions.

## Phase 1 — Zero-dep core (no wiring; all builds still emit nothing)

- [ ] 1.1 Create `src/core/telemetry/analytics.ts`: port claudy `services/analytics/index.ts:19-173` — `logEvent(name, meta)` / `logEventAsync`, `LogEventMetadata = {[k]: boolean|number|undefined}`, marker types `TelemetryMeta_VERIFIED_NOT_CONTENT` / `TelemetryMeta_VERIFIED_PII_TAGGED` (= `never`), `stripProtoFields()`, idempotent `attachSink`, `queueMicrotask` FIFO drain, `_resetForTesting()`. No imports from app code.
- [ ] 1.2 **Bounded queue (mandatory divergence from claudy's unbounded `index.ts:81,140`):** cap (e.g. 1000) + drop-oldest + monotonically increasing `droppedCount`. The core exposes `droppedCount` for later `/doctor` (Track 17, future — do not depend on it).
- [ ] 1.3 Define the `TelemetrySink` contract: `write(event): void` — sync, never throws to caller; any async work inside an impl is `void`-ed/fire-and-forget (replicate claudy isolation `datadog.ts:182-278`, `firstPartyEventLogger.ts:198-206`). `NoopSink` default.
- [ ] 1.4 Create `src/core/telemetry/sanitize.ts`: marker-returning helpers only — `sanitizeToolName` (builtin pass-through; MCP/non-builtin → `'mcp_tool'`), `boundedEnum`, `numericOnly`, `errorClass(err)` → `err.constructor.name` (never the message). Strings reach telemetry *only* through these.
- [ ] 1.5 Create `src/core/telemetry/privacy.ts` (zero-dep, pure): `PrivacyLevel = 'no-telemetry' | 'essential-traffic'`; `resolvePrivacyLevel(telemetryEnabled, envOptOut)` (env can only lower; fail-closed); `readEnvOptOut()` with the `typeof process !== 'undefined'` guard lifted from `utils/logger.ts:12`, reading `APPLEPI_NO_TELEMETRY`. Do **not** import `AgentConfig` here (verified acyclic: `AgentConfig.ts:5-29`).
- [ ] 1.6 Gate at `logEvent` entry: if resolved level is `no-telemetry`, return before enqueueing (divergence from claudy's per-backend gate — our queue is bounded, so don't fill-then-discard).
- [ ] Test 1.a: marker discipline — a raw `string` in metadata fails to compile without a sanitizer cast.
- [ ] Test 1.b: queue-then-drain FIFO within the pre-attach batch; idempotent `attachSink`; `_resetForTesting` clears sink+queue.
- [ ] Test 1.c: bounded queue drops oldest and increments `droppedCount` past cap.
- [ ] Test 1.d: a sink whose `write` throws does not propagate out of `logEvent`.
- [ ] Test 1.e: `resolvePrivacyLevel` truth table; `readEnvOptOut()` is a safe no-op when `process` is undefined.

## Phase 2 — Bridge + decorator + scattered-surface subsumption

> After this phase signal is centralized; with no sink attached it is still a no-op.

- [ ] 2.1 Create `src/core/telemetry/TelemetryBridge.ts` with `observe(event, sessionId)`: privacy-gate → match `event.msg.type` against the design §6 allowlist → extract only listed numeric/boolean/enum fields via `sanitize.ts` → `logEvent`. Allowlist-only: unknown/new `EventMsg` types produce nothing.
- [ ] 2.2 Implement the §6 allowlist mapping table verbatim (events verified vs `core/protocol/events.ts:28-819`, hooks vs `core/hooks/types.ts:16-192`). Honor the hard-exclude categories (all message/reasoning/delta, raw command/patch/path/url/selector, snapshots, notification text).
- [ ] 2.3 Add the `withTelemetry(realDispatcher, sessionId)` decorator and apply it at the **single** splice in `core/registry/AgentRegistry.ts:228-238` — wrap the `if`-branch dispatcher (`:230`, desktop/server) and the `else`-branch inline ChannelManager dispatcher (`:233-237`, extension). Decorator wraps its telemetry call in its own try/catch and **always** calls `real(event)` regardless (the `RepublicAgent.ts:969-973` catch would otherwise swallow the real event). **Zero changes to `Session.ts` / `HookDispatcher.ts` / `RepublicAgentEngine.ts`.**
- [ ] 2.4 Confirm in code that hook events need no extra wiring (they already reach the chokepoint via `RepublicAgent.ts:82` → `emitEvent` `:956-977`) and that sub-agent lifecycle events arrive tagged with `_subAgent.{depth}` (`SubAgentEventRouter.ts:28-49`). Document the coverage limit (sub-agent deltas suppressed; only `ENGINE_ONLY_EVENTS` `RepublicAgent.ts:920-932` forwarded). Scheduler emitter family is out of scope (separate path).
- [ ] 2.5 Subsume `SessionSummaryTelemetry` — dual-emit, zero behavior change. Add optional 3rd param `telemetryCore` to `createTelemetryEmitter` (`core/sessionSummary/telemetry.ts:26-51`), default no-op so `NO_OP_TELEMETRY`/tests/callers (`SessionSummaryHook.ts:101`) are untouched. Keep `parentEngine.pushEvent(...)` exactly as-is; additionally `logEvent('session_summary.'+event, sanitized)`. **Strip** `memoryRoot`, `config`, `error` (→ `errorPresent` + `errorClass`); pass numerics/bounded strings through (payloads verified `SessionSummaryHook.ts:155,232,329,375,392`; `CompactService.ts:117,124,141,212`).
- [ ] 2.6 Subsume the live `GeminiLogger` calls: replace `GoogleCompletionClient.ts:216` with `logEvent('gemini.stream_start', { model })` (drop synthetic conv-id); drop `:215`. Optionally add `logEvent('gemini.stream_end', { chunkCount, accumulatedTextLen, toolCallCount, finishReason })` at `GoogleCompletionClient.ts:447`. Do **not** port the ~15 dead raw-string methods; leave `GeminiLogger` as the `GEMINI_DEBUG` console-only path.

### Second tap — scheduler emitter (closes the "why did a scheduled job abort" goal)

- [ ] 2.7 Add an optional `tap?: (e: Record<string, unknown>) => void` parameter to `Scheduler.connectToChannel` (`core/scheduler/Scheduler.ts:119`), invoked inside the existing emitter closure **before** `dispatchEvent` (`Scheduler.ts:123-134`). Single core change; one tap covers both Scheduler + JobExecutor events (`Scheduler.setEventEmitter:98-106` funnels JobExecutor back through the same slot — no separate `JobExecutor` tap).
- [ ] 2.8 Pass `withSchedulerTelemetry(...)` at the 3 platform call sites: `ServerAgentBootstrap.ts:619`, `DesktopAgentBootstrap.ts:567`, `service-worker.ts:487`. Reuse the shared `withTelemetry`/allowlist helper from 2.1 for consistency with the agent-side decorator.
- [ ] 2.9 Map the two verified scheduler shapes (no free-text fields — stream is telemetry-clean): `scheduler.execution` ← Shape A (`JobExecutor.ts:420-429`: `status` enum, `timestamp`, `executionId`/`scheduleEventId` ids); `scheduler.state` ← Shape B (`Scheduler.ts:466-470`: `isPaused` bool, `currentJobId`).
- [ ] 2.10 **CORE SCHEDULER CHANGE (the one conscious scope decision — get owner sign-off):** add a bounded enum `failureReason` (`session_create_failed | no_launcher | offline | mutex_queued | missed | concurrent | launcher_error | stale_recovered | agent_error`) to the emitted event and emit it at the ~6 currently-silent sites: session/agent-create failure (`JobExecutor.ts:150-153,313-323`), null/throwing launcher (`:388-405`), connectivity/paused gate (`:288-290`), mutex deferral (`:127-133`), concurrent-trigger rejection (`:120-122`), stale-recovery (`:359`); missed/mis-fired via `ScheduleManager.getMissedInstances`. Enum-only, privacy-clean. Without this the tap answers "ran/succeeded/failed" but not "why it aborted pre-session" → goal only partially met.
- [ ] 2.11 Optional (server/desktop only): enrich `completed`/`failed` with `duration` + `token_usage.total` from `handleSchedulerEventCompletion` (`ServerAgentBootstrap.ts:692-726`, `DesktopAgentBootstrap.ts:662-696`) — coordinate with Track 18 to avoid duplicate cost extraction. No extension equivalent (verified) — note, don't build one.
- [ ] Test 2.e: drive scheduler through `running`/`completed`/`failed`/`cancelled` + each `failureReason` site → `scheduler.*` events with enum/numeric only. **Goal-closing assertion:** a pre-session (session-create) failure yields `scheduler.execution` with the correct `failureReason`.
- [ ] Test 2.a: representative `EventMsg` values through `observe()` → exact allowlist mapping; excluded/unknown types produce nothing.
- [ ] Test 2.b: decorator always forwards to `real(event)` even when the telemetry call throws; event ordering to transport preserved.
- [ ] Test 2.c: disabled-path — `telemetryEnabled:false`, drive a full turn (tool calls + approvals + compaction): zero `write` calls **and** turn completes uninjured; a throwing sink does not break the turn.
- [ ] Test 2.d: `SessionSummaryTelemetry` still pushes the engine event unchanged; the added `logEvent` carries no `memoryRoot`/`config`/raw `error`.

## Phase 3 — Per-platform sinks + bootstrap attach (end-to-end goal achieved here)

- [ ] 3.1 `src/server/telemetry/ServerLogSink.ts`: implements `TelemetrySink`; maps marker → `emitLog(level, markerName, sanitizedPayload)` (`server/handlers/logs.ts:39`); `level` = `error/warn` for failure markers else `info`; `data` is the already-core-sanitized payload. Calls `emitLog` directly — independent of the `installStructuredLogging` console monkey-patch (out of scope, untouched).
- [ ] 3.2 Attach `ServerLogSink` in `ServerAgentBootstrap.initialize()` **after** `registerLogsHandlers()` at `ServerAgentBootstrap.ts:477`; read privacy from `agentConfig` already loaded at `:144`. Optional spill: `join(getDataDir(), 'telemetry')` (`server-config.ts:161-163`) — **not** "Track 09".
- [ ] 3.3 Desktop rotating-file sink. **UNVERIFIED constraint:** no JS append API; only overwrite `invoke('skills_write_file',{path,content})` (`tauri/src/skills_commands.rs:59-63`). Implement rotation TS-side (in-mem buffer + periodic `skills_read_file`+`skills_write_file` rewrite + size-cap roll); dir from `getLogPath()`→`appLogDir()` (`src/desktop/platform/paths.ts:135`). Decision task: TS-rewrite (default) vs propose a new Rust append command — record the choice in this file.
- [ ] 3.4 Attach desktop sink in `DesktopAgentBootstrap.initialize()` after `config` at `:93`, before `registry.initialize(config)` at `:155`.
- [ ] 3.5 Extension bounded in-memory ring sink (module-singleton; best-effort/ephemeral — SW evicted ~30s idle `service-worker.ts:1517-1539`). Default stays `NoopSink`; ring is opt-in.
- [ ] 3.6 Attach extension sink in `doInitialize()` after `agentConfig` at `service-worker.ts:211`, before `registry.initialize` at `:232`. (Future Track 17 `/doctor` reads the ring via the `serviceRegistry.register('diagnostics.dump',…)` pattern `service-worker.ts:443-600` — do not build now.)
- [ ] 3.7 All platforms: attach the platform sink only when `resolvePrivacyLevel(...) !== 'no-telemetry'`; read the preference live (`(await AgentConfig.getInstance()).getConfig().preferences.telemetryEnabled`, default `false` via `config/defaults.ts:11`).
- [ ] Test 3.a: server integration — `telemetryEnabled:true` + `ServerLogSink`, drive a session, `logs.tail` receives marker events with sanitized payloads and **no raw strings**.
- [ ] Test 3.b: with `telemetryEnabled:false` on each platform, no sink is attached and nothing is emitted.
- [ ] Test 3.c: desktop file sink rotates at the size cap without an append API (TS-rewrite path).

## Phase 4 — OTEL (optional, flag-gated; NOT part of end-to-end DoD)

- [ ] 4.1 Dynamically-imported OTLP sink behind a Track 22 `feature()` flag (mirror claudy lazy-isolation `init.ts:305-311`, `instrumentation.ts:165-193`); never bundled by default; desktop/server only.

## Exit criteria (design §2 / §10 — "done" = all green in CI)

- [ ] One `logEvent` core exists, no-op unless `telemetryEnabled` true, privacy enforced at compile time.
- [ ] `TelemetryBridge` emits the curated numeric/boolean allowlist with **zero** hand-instrumented call sites; allowlist-only (new Track 01 events can't leak).
- [ ] **Scheduler tap live + `failureReason` enum emitted at the silent sites** → a scheduled job that aborts *before a session starts* produces a `scheduler.execution` telemetry event with a machine-readable cause (the "why did a scheduled job abort" goal genuinely met, not partial).
- [ ] The four scattered surfaces are subsumed (SessionSummaryTelemetry dual-emits; live GeminiLogger call is a marker event; `emitLog` is a pluggable sink) with no behavior regression for existing consumers.
- [ ] Each platform has a working sink attached at its bootstrap.
- [ ] Server with `telemetryEnabled:true`: operator tailing `logs.tail` sees structured tool-failure/approval/abort/compaction/token-pressure events **and scheduled-job lifecycle + abort cause**; with `false`, nothing emitted and the turn loop provably unaffected.
- [ ] Tests: injectable fake sink + `_resetForTesting` assert exact names/metadata; disabled-path proves the turn loop is uninjured.

## Dependencies / non-dependencies

- **Track 01 (DONE):** seam is `RepublicAgent.emitEvent`/`AgentRegistry` dispatcher — **no Track-01 change**.
- **Track 12:** rate-limit events are Track 01 `EventMsg` → bridged free (no net-new instrumentation).
- **Scheduler:** separate emitter, second tap (2.7–2.11). `failureReason` (2.10) is the only scheduler-core change — needs owner sign-off. Cost-enrichment (2.11) shares a seam with **Track 18** — coordinate.
- **Track 17 / Track 20:** do **not** exist; baseline must not depend on them (it doesn't). Additive later.
- **Track 22:** Phase 4 only.
