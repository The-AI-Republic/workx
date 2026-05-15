# Track 21: Remote Bridge & Relay

**Priority: P1** · **Effort: L** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a read of claudy's bridge/remote/transports and browserx's server connection+streaming — see "Validation Notes". Distinct from Track 04's sub-agent system (multi-agent coordination; Track 06 was abandoned 2026-05-14, its coordinator/worker primitives live in Track 04's `SubAgentRegistry`): this is *one* running agent driven from another device. Scope narrowed to the genuinely missing parts.

## Problem

"Drive my desktop browser-agent from my phone." BrowserX server mode already covers the **LAN** case. Genuinely missing:

1. **Relay / rendezvous** — phone ↔ cloud ↔ desktop with no inbound port (NAT traversal). browserx's server expects clients to reach it directly; there is no outbound long-poll worker.
2. **Viewer vs driver multi-client + mid-stream replay** — a late-joining client should see current state then live events; no observer/driver distinction or takeover today.

Session *teleport* (relocate a live session to another device) is **out of scope** (P3): browser/DOM live state doesn't bundle like claudy's git bundle, browserx has no teleport, value is weak.

## What Claudy Does

**Bridge** (`bridge/`, `bridgeMain.ts` 3001 lines). `bridge/types.ts`: a local process calls `registerBridgeEnvironment(config) → {environment_id, environment_secret}` (`:134-137`), then **long-polls** `pollForWork(envId, secret, …)` / `acknowledgeWork` / stop (`:138-149`). The phone never connects to the laptop — both rendezvous through Anthropic's relay. `SpawnMode = 'single-session' | 'worktree' | 'same-dir'` (`:69`). Env-less variant: `remoteBridgeCore.ts` + `envLessBridgeConfig.ts` (direct session-ingress, no Environments API). Auth via `jwtUtils.ts` / `trustedDevice.ts` / `workSecret.ts`.

**Remote** (`remote/RemoteSessionManager.ts`) — the client/viewer. `SessionsWebSocket` subscribe; `viewerOnly?: boolean` (`:61`) distinguishes observers (no interrupt, reconnect disabled) from drivers; filters all but `control_request`/`control_response`; reconnect backoff.

**Transports** (`cli/transports/`): `WebSocketTransport` (reads), `HybridTransport` (WS reads + batched HTTP POST writes via `SerialBatchEventUploader`), `SSETransport`, `WorkerStateUploader`.

## BrowserX Mapping

### The real seam — LAN already covered; two precise gaps

| Concern | BrowserX location | State |
|---|---|---|
| Event stream | `server/streaming/agent-events.ts` `nextSeq()`/`resetSeq()`, `toAgentEvent(EventMsg)→EventFrame` **sequence-numbered** (`:19-157`) | **Every event already has a seq** — replay substrate exists |
| Connect snapshot | `server/connection/handshake.ts` `HandshakeSnapshotProviders` + `setHandshakeSnapshotProviders` (`:57-63`); challenge/connect (`:91-210`) | **Snapshot-at-connect hook already exists** |
| Auth | `server/connection/auth.ts` `AuthMode='none'|'token'|'password'|'trusted-proxy'` | Reusable for the relay leg |
| Connection tracking | `server/connection/watchdog.ts`, `rate-limiter.ts` | |
| Outbound-connect pattern | `server/channel-connectors/connector-bridge.ts` `ConnectorBridge implements ChannelAdapter` — per-account outbound connect + backoff state machine (`:46-76`) | Pattern sibling for a relay worker — but it bridges **chat channels**, not agent-driving |
| RemoteTrigger analog | `core/scheduler/` (`ScheduleManager`, `Scheduler`, `JobExecutor`, rrule) | Full scheduler exists |
| Teleport | none (grep) | Out of scope |

### Key design decisions (and divergences from claudy)

1. **Mid-stream replay rides the EXISTING seq + snapshot hooks — not new infra.** This is the headline correction: browserx *already* (a) sequence-numbers every event (`agent-events.ts:nextSeq`) and (b) has `HandshakeSnapshotProviders` at connect. Late-join = `HandshakeSnapshotProviders` state digest + "replay events since `seq N`." Net change: a `sinceSeq` param on subscribe + a bounded per-run event ring buffer. Small protocol addition on existing streaming — **divergence from claudy**, whose SDK-message stream has no comparable built-in seq/snapshot pairing.

2. **Viewer/driver roles + takeover on the existing stream.** Add a `role: 'viewer' | 'driver'` to the connection (mirrors claudy's `viewerOnly`): viewers get events only; a single driver lock gates `UserInput`/`Interrupt`; explicit takeover protocol. Layers onto `handshake.ts`/`watchdog.ts` connection records — no new transport.

3. **Relay/rendezvous is the real cost (Phase 3, infra-gated).** A hosted broker so a desktop agent behind NAT dials *out* and long-polls — port claudy's `registerBridgeEnvironment`/`pollForWork`/`acknowledgeWork` shape (`bridge/types.ts:134-149`). **Reuse the `ConnectorBridge` outbound-connect-with-backoff pattern** (`connector-bridge.ts:46-76`) as the structural sibling and the existing WS `auth.ts`/handshake for the relay leg. **Divergence:** claudy rides Anthropic's Environments API + relay; browserx needs its own hosted relay — an explicit infra decision, Phase 3 gated, not a code-only change. Do **not** build it on the chat-channel `ConnectorBridge` path (different purpose: that bridges Slack/Telegram-style connectors, not agent-driving).

4. **RemoteTrigger = thin token-safe tool over the existing scheduler (Phase 1, independent quick win).** `core/scheduler/ScheduleManager` exists; expose a tool wrapper so the agent manages scheduled remote runs without leaking credentials to the model — mirrors claudy's `RemoteTriggerTool` (small, ships first).

5. **Teleport explicitly deferred (P3).** Documented out of scope; browser/DOM live state is not git-bundleable; no existing browserx teleport to extend.

### Phase plan

- **Phase 1 (P2/S):** RemoteTrigger-style in-process tool over `core/scheduler` (token-safe) — independent.
- **Phase 2 (P1/M):** `role: viewer|driver` + single-driver lock + takeover on existing `handshake`/`watchdog`; `sinceSeq` subscribe param + bounded per-run event ring + late-join snapshot via `HandshakeSnapshotProviders`.
- **Phase 3 (P1/L, infra-gated):** outbound relay worker (`registerEnvironment`/`pollForWork`/`ack` shape, reusing `ConnectorBridge` connect pattern + WS auth) + hosted relay decision.

## Dependencies

- Existing `server/streaming/agent-events.ts` (`nextSeq`), `server/connection/{handshake,auth,watchdog}.ts`, `server/channel-connectors/connector-bridge.ts` (pattern), `core/scheduler/` — reuse, not rebuild
- **Track 01** (Events): replay rides the `EventMsg`→`EventFrame` seq stream
- **Track 04** (Typed Tasks): a relay session is a task family
- **Track 07** (Centralized State): the late-join state digest
- **Track 20** (Managed Settings): the shared remote fetch/auth pattern overlaps the relay registration leg

## Risks

- Hosted relay = operational + security + cost surface (auth, abuse, NAT broker) — Phase 3 strictly gated on an infra decision; Phases 1–2 deliver value without it.
- Multi-driver conflict — explicit single-driver lock + takeover; viewers strictly read-only (claudy's `viewerOnly` precedent).
- Event ring sizing: replay buffer must be bounded per run (memory) — cap + "snapshot then live" fallback when a client is too far behind.
- Don't build the relay on the chat-channel `ConnectorBridge` — same outbound pattern, different purpose; conflating them couples agent-driving to channel connectors.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `bridge/types.ts:69` (`SpawnMode`), `:134-149` (`registerBridgeEnvironment`/`pollForWork`/`acknowledgeWork`); `bridge/` (`remoteBridgeCore.ts`, `envLessBridgeConfig.ts`, `jwtUtils.ts`, `trustedDevice.ts`, `workSecret.ts`); `remote/RemoteSessionManager.ts:30-61` (`viewerOnly`, control-message filter, reconnect); `cli/transports/` (`WebSocketTransport`, `HybridTransport`+`SerialBatchEventUploader`, `SSETransport`).
- browserx: `server/streaming/agent-events.ts:19-157` (`nextSeq`/`resetSeq`/`toAgentEvent` — every event seq'd); `server/connection/handshake.ts:36-210` (`HandshakeResult`, `HandshakeSnapshotProviders` snapshot-at-connect, challenge/connect); `server/connection/auth.ts:16-19` (`AuthMode`); `server/channel-connectors/connector-bridge.ts:46-76` (outbound connect + backoff state machine — pattern sibling, chat-channel purpose); `core/scheduler/` (`ScheduleManager`/`Scheduler`/`JobExecutor`); no teleport (grep).

Corrections vs the first-pass draft:
1. Strengthened with a concrete find: browserx **already** pairs per-event `nextSeq` with a `HandshakeSnapshotProviders` snapshot hook — mid-stream replay is a `sinceSeq` param + ring buffer, not "build snapshot/replay." The draft said "layer onto existing streaming" without knowing the snapshot hook already exists.
2. Identified `ConnectorBridge` as the structural sibling for the outbound relay worker (reuse its connect/backoff pattern) **and** explicitly warned not to build the relay on the chat-channel connector path — a distinction the draft didn't make.
3. Confirmed no browserx teleport exists (grep) — P3 deferral is firmly justified, not assumed.
