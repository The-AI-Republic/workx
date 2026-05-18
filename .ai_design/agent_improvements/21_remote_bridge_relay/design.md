# Track 21: Remote Bridge & Relay (Apple Pi Desktop)

**Priority: P1** · **Effort: L** · **Status: DEFERRED (2026-05-15 — not P0; revisit when scheduled)**

> **Deferred 2026-05-15.** Not P0. The desktop-only rework below is architecturally decision-complete, but three turn-key blockers remain unresolved and should be closed *before* implementation starts: (1) **no client/reference-client spec** — the end-to-end goal is inherently client-side and the doc is host-only; (2) **Phase 2's Rust plan is unverified** — `src-tauri/` was not inspected (Tauri version, crate layout, command registration unknown); (3) **snapshot/seq/takeover internals + per-phase acceptance criteria are sketch-level**, and Track 07 dependency status is unconfirmed. Pick these up when the track is prioritized.

> Source: claudy↔browserx research (2026-05-14), implementation-readiness pass (2026-05-15), and a **desktop-only end-to-end rework (2026-05-15)** grounded in an implementation-grade read of claudy's `bridge/`/`remote/`/`cli/transports/` and browserx's desktop channel stack, core agent loop, scheduler, tool registry, and `@applepi/ws-server` — see "Validation Notes". **Scope narrowed to the Apple Pi *desktop* (Tauri) target.** The cloud relay does not exist yet; this track makes the desktop side genuinely remote-drivable over LAN *now* and one config-flip away from internet relay *later*, with every phase functionally complete on its own.

## Scope & Non-Goals

- **In scope:** Apple Pi **desktop** (Tauri app) as a remote-drivable agent host.
- **Out of scope (this track):** the Apple Pi headless **server** (already has a seq/handshake/auth substrate; revisit separately) and the **extension** (Chrome MV3 SW cannot host a long-lived listener — client-only by construction). Both may act as remote *clients* of a desktop host; no host work lands in them here.
- **Cloud relay is deferred but designed for.** "Ready for the cloud" is made concrete: a frozen wire contract plus an in-process **LoopbackRelay** so the entire relay path is functionally exercised end-to-end with no hosted infra. Phase 5 flips from `loopback` to `remote` by URL only.

## Problem

"Drive my desktop browser-agent from my phone." Today this is **not** actually possible on desktop, even on LAN:

1. **The desktop WebSocket server has no backend.** `WebSocketServer.ts` calls Tauri commands `ws_server_start`/`ws_server_stop`/`ws_send`/`ws_disconnect` (`WebSocketServer.ts:132,185,209,270`) that are **not implemented in `src-tauri`**. `WebSocketChannel` is also never instantiated — `DesktopAgentBootstrap` only ever creates `TauriChannel` (`DesktopAgentBootstrap.ts:115`). So the LAN path is a stub, not a working feature. *(This is the single largest hidden cost in the track; the prior multi-platform draft missed it entirely and asserted "LAN already covered.")*
2. **No late-join.** `WebSocketChannel.eventToWSMessage` returns `null` for every event when there is no active turn (`WebSocketChannel.ts:300-303`) and is keyed by a per-turn `turnId`. A client connecting mid-run sees nothing. There is no snapshot-at-connect and no replay anywhere on the desktop path.
3. **No viewer/driver distinction, no driver arbitration.** Any connected client can submit; nothing gates concurrent drivers.
4. **No off-network reach.** No outbound dial / rendezvous; leaving the LAN ends access.

Session *teleport* (relocating a live session) remains **out of scope (P3)**: browser/DOM live state is not git-bundleable; browserx has no teleport (grep).

## What Claudy Does (idea source, not transplant)

**Outbound bridge.** A local process `registerBridgeEnvironment → {environment_id, environment_secret}`, then **long-polls** `pollForWork`/`acknowledgeWork`/`heartbeatWork`/`stopWork` (`bridge/types.ts:18-31` `WorkResponse`; `bridge/bridgeMain.ts:600-900`). The phone never connects to the laptop — both rendezvous through Anthropic's Environments API. Backoff: conn 2s→120s, general 0.5s→30s, give-up 600s, **sleep-detect at 240s** (`bridgeMain.ts:59-79`); poll 2s not-at-capacity / 600s at-capacity, reclaim 5s (`bridge/pollConfigDefaults.ts:44-82`). `SpawnMode` is a purely *local* decision (`bridge/types.ts:64-69`); the relay is agnostic to it.

**Transport contract.** A common `Transport` interface: `write`/`writeBatch`/`close`/`connect`/`setOnData`/`setOnClose`/`setOnConnect`/`getLastSequenceNum`. `HybridTransport` = WS reads + batched HTTP POST writes (100 ms window, batch 500, queue 100k, retry 0.5→8 s via `SerialBatchEventUploader`). `SSETransport` resumes with `from_sequence_num=` + `Last-Event-ID:` and a client-side `lastSequenceNum` high-water mark + `seenSequenceNums` dedup set that **survives transport rebuilds** (`cli/transports/SSETransport.ts:244-248`).

**Remote client.** `remote/RemoteSessionManager.ts` `viewerOnly` gates *interrupt send*, *reconnect timeout*, and *title update* only. **There is no driver lock anywhere in claudy** — concurrency is prevented server-side by session locking, not by a client/host protocol.

## Corrections to the prior draft (verified against source)

These are load-bearing; the rework depends on them.

1. **claudy *does* have seq-based resume.** Prior draft: "claudy's SDK stream has no comparable built-in seq/snapshot pairing at all." False — `SSETransport` implements `from_sequence_num`/`Last-Event-ID` resume with a dedup window (`SSETransport.ts:174,213-248,357-384`). The defensible (narrower) claim: claudy has *resume-from-seq* but **no explicit state snapshot**; browserx's advantage is pairing a **snapshot-at-connect** with seq replay. Use the narrow claim.
2. **Single-driver lock + takeover is NET-NEW, not "mirrors claudy."** claudy has no driver arbitration (`RemoteSessionManager.ts` — only `viewerOnly`). Frame this as a deliberate browserx improvement, designed here, not ported.
3. **The server's seq is NOT a replay substrate.** `agent-events.ts:17-25`: `nextSeq()` is a process-global `_globalSeq++`, fire-and-forget, **no retained history, not run-scoped**. Prior draft's "every event already seq'd — replay substrate exists (server only)" is overstated: a seq *stamp* exists; the *buffer to replay from does not*. Replay requires a **new, per-session bounded ring** regardless of platform.
4. **There is no "shared-substrate lift" of `handshake.ts`.** `server/connection/handshake.ts` is entangled with `@applepi/ws-server`'s connect flow, `node:crypto`, and `getHealthStatus` (server-only). It is *not* cleanly liftable and we will *not* lift it. What is genuinely shared and reusable is (a) the **`@applepi/ws-server`** workspace package — a zod-only, transport-agnostic *protocol* layer whose `ConnectRequestSchema.params.resume {sessionKey,lastSeq}` and `HelloOkPayload.{snapshot,sessionKey}` **already define the late-join wire contract** (`packages/ws-server/src/frames.ts`), and (b) the **pure auth-decision logic** in `server/connection/auth.ts:16-65`, which the analysis confirms is cleanly liftable. We lift only (b), reuse (a) as-is, and build the replay buffer fresh in core.
5. **Scheduler is fully wired on desktop already.** `DesktopAgentBootstrap.initializeScheduler()` constructs `ScheduleManager`/`JobExecutor`/`Scheduler` with `DesktopSchedulerAlarms` + `TauriSQLiteAdapter`, `setRegistry`, and a `jobLauncher` that submits `UserInput` (`DesktopAgentBootstrap.ts:532-655`). Phase 1 (RemoteTrigger) is fully desktop-native with no "server-primary" caveat.

## Architecture (system-consistent)

The desktop already has the right seam: **`ChannelAdapter`** (`core/channels/ChannelAdapter.ts:46-131`) decouples the agent core from any transport. `ChannelManager` already supports **multiple simultaneously-registered channels** (proven in tests). Events flow `RepublicAgent.emitEvent → eventDispatcher → ChannelManager.dispatchEvent({msg,sessionId},channelId) → channel.sendEvent`; input flows `channel → SubmissionHandler(op,ctx) → agentHandler → registry.getSession(sessionId).agent.submitOperation(op,{tabId})` (`RepublicAgent.ts:512-617`).

So **all remote work lands behind `WebSocketChannel`**, registered alongside `TauriChannel` — no change to the core loop, no change to `TauriChannel`, no new agent path. New shared concerns (replay buffer, connect/resume, roles, relay worker) live in **`core/`** so they are channel-agnostic and unit-testable, and are *consumed* by `WebSocketChannel`. We reuse `@applepi/ws-server` frame/error/method types for the wire so the desktop speaks the same protocol the server already speaks (future convergence is free; not required here).

```
phone/tablet (client)                desktop (Tauri host)
  │                                    ┌────────────────────────────────────────┐
  │  ws:// (LAN, Phase 2–4)            │ src-tauri: Rust WS server (Phase 2)     │
  ├───────────────────────────────────┤  ws_server_start/stop/send/disconnect   │
  │                                    │  emits ws_client_connected/_message/_…  │
  │                                    ├────────────────────────────────────────┤
  │                                    │ WebSocketChannel (ChannelAdapter)       │
  │                                    │  • connect/hello-ok (@applepi/ws-server)│
  │                                    │  • AuthMode (lifted core/connection)    │
  │                                    │  • role: viewer|driver + driver lock    │
  │                                    │  • run-scoped seq'd EventFrame stream   │
  │                                    ├────────────────────────────────────────┤
  │                                    │ core/session/SessionReplayBuffer        │
  │                                    │ core/session/SnapshotProvider           │
  │                                    ├────────────────────────────────────────┤
  └─ (Phase 5) ── LoopbackRelay ───────┤ core/remote/relay/RelayWorker (outbound │
       or future hosted relay          │   dial + backoff; ConnectorBridge shape)│
                                       └──────────┬─────────────────────────────┘
                                                  │ ChannelManager (multi-channel)
                                                  │ + TauriChannel (unchanged)
                                                  ▼  RepublicAgent / AgentRegistry
```

## Implementation Plan (file-level, ordered, each phase functionally complete)

### Phase 1 (P2/S) — RemoteTrigger tool. *Independent; no transport work.*

A token-safe agent tool over the **already-wired desktop scheduler** so the model can manage scheduled remote runs without ever seeing credentials or stored job input.

- `src/tools/RemoteTriggerTool.ts`: `ToolDefinition` (`type:'function'`, `ResponsesApiTool {name:'remote_trigger', strict:true, parameters}`) per `BaseTool.ts:22-77`. Operations reference jobs **by id only**: `list` (id + rrule description + next time), `trigger(scheduleEventId)`, `enable/disable(scheduleEventId)`, `create(naturalTime, rrule?)`. The stored `input` string is **never** returned to the model and never accepted from it on `trigger` (it lives in `ScheduleManager`, retrieved host-side on fire — mirrors claudy's `RemoteTriggerTool` token-safety).
- Constructor takes `Scheduler` (DI, not singleton) → `scheduler.getScheduledJobs()`, `scheduler.triggerJob(id)`, `ScheduleManager.setEnabled`, `scheduler.scheduleJob` (`Scheduler.ts:161-293`, `ScheduleManager.ts:55-382`).
- Register on the desktop agent in the `agentFactory` alongside skills/sub-agent tools (`DesktopAgentBootstrap.ts` `registerSkillsToolOnAgent` pattern) via `ToolRegistry.register(def, handler, new StaticRiskAssessor(0))` (`ToolRegistry.ts:137-150`); pass the bootstrap's `this.scheduler`.
- **End-to-end checkpoint:** on desktop alone, the agent can enumerate, create, enable/disable, and fire scheduled jobs; no schedule input or credential is ever exposed to the model. Fully functional with zero remote infra.

### Phase 2 (P1/M) — Rust WebSocket server (the real prerequisite).

Implement the missing Tauri backend so `WebSocketServer.ts` stops being a stub.

- `src-tauri/src/ws_server.rs` (new): tokio + `tokio-tungstenite` listener. Tauri commands **`ws_server_start{port,host,maxConnections}`**, **`ws_server_stop`**, **`ws_send{clientId,message}`**, **`ws_disconnect{clientId}`**; emit events **`ws_client_connected{clientId,address}`**, **`ws_client_disconnected{clientId}`**, **`ws_message{clientId,message}`** — exact names/shapes already consumed at `WebSocketServer.ts:132,139-155,185,209,270`. Register in the Tauri builder `invoke_handler`.
- Bind defaults from `WebSocketServer.ts:75-83`: `127.0.0.1:8765`, `maxConnections:10`, ping 30 s, idle 60 s. Rust does **transport only** (accept, frame, per-client id, ping/idle reap); **all protocol/auth/routing stays in TS** (`WebSocketChannel`), consistent with how `@applepi/ws-server` separates protocol from transport.
- No TS protocol change in this phase: the existing turn-based JSON (`websocket/types.ts:208-228`) keeps working so the phase is independently shippable.
- **End-to-end checkpoint:** a LAN client connects to the desktop, sends `user_turn`, and receives `assistant_chunk`/`tool_use`/`assistant_turn_complete` — i.e. the *existing* protocol now actually works over the wire. (Still no late-join/roles yet — that's Phase 4.)

### Phase 3 (P1/M) — Real handshake + auth (lift only what's cleanly liftable).

Replace the apiKey-only, localhost-auto-auth model (`WebSocketServer.ts:386-425`) with the shared protocol + real auth modes.

- `src/core/connection/auth.ts` (new): move the **pure** decision logic from `server/connection/auth.ts:16-65` — `AuthMode='none'|'token'|'password'|'trusted-proxy'`, `verifyAuth(authParams,headers,isLoopback)`, timing-safe compares. No node-only deps (swap `crypto.timingSafeEqual` for a constant-time string compare so it runs in the Tauri TS runtime). `src/server/connection/auth.ts` re-exports from core — **behavior-preserving, test-pinned** (this is the only "lift," and it is genuinely shared, not desktop-only).
- `WebSocketChannel` adopts the `@applepi/ws-server` **`connect` handshake**: validate `ConnectRequestSchema`, `negotiateProtocolVersion`, run `verifyAuth` against desktop config, reply `HelloOkPayload` with `features`/`policy`/`auth.{role,scopes}` (`packages/ws-server/src/frames.ts`, `methods.ts`). Loopback stays zero-config (`AuthMode='none'` + `isLoopback`); LAN drive requires `token`/`password` from desktop settings (`AgentConfig`). Reuse `@applepi/ws-server` `errors` for close codes.
- Desktop config: add `remote.auth.{mode,token,password}` to `AgentConfig` desktop schema; surface in settings UI (out-of-band of this doc, but the config keys are defined here).
- **End-to-end checkpoint:** authenticated LAN drive — a remote client completes a real `connect`/`hello-ok` handshake with token auth and drives the agent; unauthenticated non-loopback is rejected with a typed error. Loopback dev flow unchanged.

### Phase 4 (P1/M) — Replay buffer + viewer/driver + takeover. *The headline capability.*

Make a late-joining client see current state then live, and arbitrate control.

- `src/core/session/SessionReplayBuffer.ts` (new): per-`sessionId` bounded ring of seq-stamped `EventFrame`s (`@applepi/ws-server` `EventFrame {type:'event',event,payload,seq}`). **Run-scoped monotonic seq per session** (explicitly *not* the server's process-global `_globalSeq` — Correction 3). Bound by count + bytes; on overflow mark `truncatedBeforeSeq` so a too-far-behind client gets "snapshot-then-live" instead of a partial replay.
- `src/core/session/SnapshotProvider.ts` (new): channel-agnostic provider interface (shape mirrors `HandshakeSnapshotProviders` at `handshake.ts:57-65` but lives in core, not lifted). Desktop registers a provider that returns `{ sessions: AgentRegistry summaries, current: <digest of in-flight turn/last assistant message/pending approvals> }`. Wired in `DesktopAgentBootstrap` next to the registry.
- `WebSocketChannel` rework (`WebSocketChannel.ts:295-371`): events become **run-scoped seq'd `EventFrame`s pushed to every connection regardless of active turn** — delete the `if (!turnId) return null` drop (`:300-303`) and the per-turn keying; route by `sessionId`. Each connection tracks its own delivered-seq. The legacy turn-shaped messages can be derived for back-compat but the stream is the source of truth. On `connect.params.resume{sessionKey,lastSeq}` (already in `ConnectRequestSchema`): send `HelloOkPayload.snapshot` then replay `SessionReplayBuffer` events with `seq > lastSeq`; client dedups via the seq it already has (claudy's model, `SSETransport.ts:357-384`).
- Roles & lock: `connect.params.role:'viewer'|'driver'` (extend params; default `viewer`). Per-`sessionId` **single-driver lock** in the `WebSocketChannel` connection record (modeled on `watchdog.ts:25-39` `TrackedConnection`, but desktop-local — *not* lifted). Viewers: stream only; `UserInput`/`UserTurn`/`Interrupt`/approvals rejected with a typed error. Driver: gated by the lock. **Takeover protocol** (net-new, Correction 2): `request_driver` → current driver notified, `grant`/`deny` with timeout → on grant or timeout the lock transfers and a `driver_changed` event is broadcast. Single writer per session is enforced by *this* lock (claudy relied on a server; the desktop is the authority here).
- **End-to-end checkpoint:** a phone on the LAN joins a desktop session that is **already mid-run**, immediately sees a state snapshot then the live seq stream, can request and take over the driver role; a second device joined as viewer is strictly read-only; driver handoff is explicit and observable. This is the track's core goal, fully functional over LAN, no cloud.

### Phase 5 (P1/L) — Relay-ready seam + LoopbackRelay (no hosted infra).

Make off-network reach a swappable transport, fully exercised without a cloud.

- `src/core/remote/relay/RelayProtocol.ts` (new): the **frozen wire contract** a future hosted relay must satisfy, reconstructed from claudy: `registerEnvironment → {id,secret}`; `pollForWork → WorkResponse|null` (`bridge/types.ts:18-31` shape); `acknowledgeWork`; `heartbeatWork → {lease_extended,state}`; `stopWork`. Session-ingress leg: WS subscribe (reads) + write path, bearer-JWT auth, **seq semantics identical to Phase 4's `SessionReplayBuffer`/resume** (so relay reuses the same replay machinery — no second mechanism). Documented as a stable interface, versioned.
- `src/core/remote/relay/RelayWorker.ts` (new): outbound dial + lifecycle. **Reuse the `ConnectorBridge` *shape*, not its code/purpose** (`connector-bridge.ts:32-110,270-290`): state enum `disconnected|connecting|connected|error`, `BACKOFF_SCHEDULE=[1,2,5,10,30,60]s`, `MAX_RESTART_ATTEMPTS=10`, `STABLE_RESET_MS=30min`, plus claudy's poll/heartbeat/sleep-detect defaults (poll 2 s, heartbeat lease, sleep-detect 240 s, reclaim 5 s — `bridgeMain.ts:59-79`, `pollConfigDefaults.ts:44-82`). It speaks `RelayProtocol`; on work it bridges the relay session-ingress to the same `WebSocketChannel`/`SessionReplayBuffer`/role machinery from Phase 4 (one mechanism, two front-doors). **Do not build on the chat-purpose `ConnectorBridge` itself.**
- `src/core/remote/relay/LoopbackRelay.ts` (new, test/dev): in-process implementation of `RelayProtocol` — a fake broker queue. Lets a test/dev client drive the desktop *through the full relay code path* with zero hosted infra. This is what makes the track "ready for the cloud" concrete and **end-to-end testable now**.
- `DesktopAgentBootstrap`: construct `RelayWorker` when `remote.relay.mode ∈ {loopback,remote}` (default `off`); inject the same `SnapshotProvider`/registry. Never in server/extension bootstraps (scope).
- **End-to-end checkpoint:** with `relay.mode=loopback`, the entire register→poll→ack→heartbeat→drive→snapshot→replay→takeover→stop flow runs in tests and dev against the in-process relay — i.e. the track is functionally complete. Switching to `mode=remote` requires only a relay base URL; the only deferred work is standing up the hosted broker, which now has a frozen contract and a reference (loopback) implementation to conform to.

## Cross-phase consistency

Each phase is independently shippable and leaves the system working: P1 needs no transport; P2 makes the *existing* protocol real; P3 hardens it; P4 delivers the headline LAN capability; P5 extends reach with no new event/replay mechanism (it reuses P4's `SessionReplayBuffer`/resume/roles). There is exactly **one** seq/replay/role implementation, one auth implementation, one channel — used by both the LAN front-door (P2–4) and the relay front-door (P5). No phase invalidates a prior phase's contract; `@applepi/ws-server` frames are the stable spine throughout.

## Dependencies

- Reuse (not rebuild): `core/channels/{ChannelAdapter,ChannelManager,types}`, `desktop/channels/{WebSocketChannel,websocket/*}`, `core/RepublicAgent`+`AgentRegistry`, `core/scheduler/*` (desktop-wired), `tools/{BaseTool,ToolRegistry}`, `@applepi/ws-server` (workspace, zod-only protocol pkg), `server/connection/auth.ts` (lift pure logic to core).
- Track 01 (Events): replay rides the `EventMsg`→`EventFrame` stream. Track 04 (Typed Tasks): a relay session is a task family. Track 07 (Centralized State): feeds `SnapshotProvider`. Track 20 (Managed Settings): shares the remote fetch/auth pattern with the relay registration leg.

## Risks

- **Rust WS server (Phase 2) is the largest hidden cost** — net-new `src-tauri` code, not a "lift." It is now an explicit, sequenced phase with its own checkpoint; do not start Phase 3+ until P2's checkpoint passes.
- **`SessionReplayBuffer` sizing** — bound by count+bytes per run; expose `truncatedBeforeSeq` and fall back to snapshot-then-live for clients too far behind (claudy's behavior).
- **Driver-lock correctness** — net-new (claudy has none). Single writer per `sessionId`, explicit timed takeover, viewers hard read-only at the op gate (not just UI).
- **Auth lift must stay behavior-preserving** — pin `server/connection/auth.ts` behavior with tests before re-pointing it at `core/connection/auth.ts`; the only intended change is dropping the `node:crypto` dependency.
- **Relay contract drift** — `LoopbackRelay` is the conformance reference; the future hosted relay must pass the same suite. Version `RelayProtocol`.
- **Do not build on chat-channel `ConnectorBridge`** — copy the backoff/state *shape* only.

## Validation Notes (verified vs source, desktop-only rework 2026-05-15)

- browserx desktop: `core/channels/ChannelAdapter.ts:46-131`; `core/channels/types.ts:17-22,53-71`; `desktop/channels/TauriChannel.ts:68-271`; `desktop/channels/WebSocketChannel.ts:52-386` (event drop `:300-303`, map `:295-371`); `desktop/channels/websocket/WebSocketServer.ts:75-83,132,139-155,185,209,270,386-425` (Tauri cmds **unimplemented in `src-tauri`**); `desktop/channels/websocket/types.ts:208-228`; `desktop/agent/DesktopAgentBootstrap.ts:115` (only `TauriChannel`), `:532-655` (scheduler fully wired); `core/RepublicAgent.ts:54-102,512-617`; `core/engine/RepublicAgentEngine.ts:129-139`; `core/protocol/types.ts:38-123`.
- browserx shared/server: `server/streaming/agent-events.ts:17-25` (process-global `_globalSeq`, no history), `:35-46`; `server/connection/handshake.ts:57-65,218-267` (entangled w/ `@applepi/ws-server`+`node:crypto`+health — not lifted); `server/connection/auth.ts:16-65` (cleanly liftable); `server/connection/watchdog.ts:25-39`; `packages/ws-server/src/frames.ts` (`ConnectRequestSchema.params.resume{sessionKey,lastSeq}`, `EventFrame:48-53`, `HelloOkPayload`), `methods.ts`, `errors.ts`; `server/channel-connectors/connector-bridge.ts:32-110,270-290` (backoff *shape*); `core/scheduler/{ScheduleManager.ts:55-382,Scheduler.ts:161-293,JobExecutor.ts:113-178}`; `tools/{BaseTool.ts:22-180,ToolRegistry.ts:137-150}`; `server/tools/registerServerTools.ts`.
- claudy: `bridge/types.ts:18-31,64-69`; `bridge/bridgeMain.ts:59-79,600-900`; `bridge/pollConfigDefaults.ts:44-82`; `cli/transports/{SSETransport.ts:174,213-248,357-384,HybridTransport,SerialBatchEventUploader}`; `remote/RemoteSessionManager.ts` (`viewerOnly` only — no driver lock).

Corrections vs the prior (multi-platform) draft, all source-verified:
1. claudy **has** seq-based resume — narrow the claim to "resume-from-seq, no state snapshot."
2. Single-driver lock + takeover is **net-new**, not a claudy port.
3. Server seq is process-global & history-less — **not** a replay substrate; a new per-session ring is required on any platform.
4. No `handshake.ts` "lift" — reuse `@applepi/ws-server` (already transport-agnostic) + lift only pure `auth.ts` logic.
5. Desktop scheduler is **already fully wired** — Phase 1 has no "server-primary" caveat.
6. Desktop WS server **has no Rust backend** — explicit Phase 2, the track's largest cost.
7. `WebSocketChannel` currently **drops events without an active turn** and is turn-scoped — incompatible with viewers; reworked to a run-scoped seq stream in Phase 4.
