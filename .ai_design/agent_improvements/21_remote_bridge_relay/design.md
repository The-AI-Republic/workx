# Track 21: Remote Bridge & Relay

**Priority: P1** · **Effort: L** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a read of claudy's bridge/remote/transports and browserx's server + desktop connection/streaming across all three deploy targets — see "Validation Notes". Distinct from Track 04's sub-agent system (Track 06 abandoned 2026-05-14): this is *one* running agent driven from another device.

## Problem

"Drive my desktop browser-agent from my phone." BrowserX server mode already covers the **LAN** case (and the desktop has a `WebSocketChannel` for LAN drive too). Genuinely missing:

1. **Relay / rendezvous** — phone ↔ cloud ↔ desktop with no inbound port (NAT traversal). No outbound long-poll worker.
2. **Viewer vs driver multi-client + mid-stream replay** — a late-joining client should see current state then live events; no observer/driver distinction or takeover.

Session *teleport* (relocate a live session) is **out of scope** (P3): browser/DOM live state doesn't bundle like claudy's git bundle; browserx has no teleport; value is weak.

## What Claudy Does

**Bridge** (`bridge/`, `bridgeMain.ts` 3001 lines). `bridge/types.ts`: a local process calls `registerBridgeEnvironment(config) → {environment_id, environment_secret}` (`:134-137`), then **long-polls** `pollForWork`/`acknowledgeWork`/stop (`:138-149`). The phone never connects to the laptop — both rendezvous through Anthropic's relay. `SpawnMode='single-session'|'worktree'|'same-dir'` (`:69`). Env-less variant: `remoteBridgeCore.ts` + `envLessBridgeConfig.ts`. Auth via `jwtUtils.ts`/`trustedDevice.ts`/`workSecret.ts`.

**Remote** (`remote/RemoteSessionManager.ts`) — the client/viewer. `SessionsWebSocket` subscribe; `viewerOnly?:boolean` (`:61`) distinguishes observers (no interrupt, reconnect disabled) from drivers; filters all but `control_request`/`control_response`; reconnect backoff.

**Transports** (`cli/transports/`): `WebSocketTransport`, `HybridTransport` (WS reads + batched HTTP POST writes via `SerialBatchEventUploader`), `SSETransport`, `WorkerStateUploader`.

## BrowserX Mapping

### The real seam — LAN already covered; two precise gaps

| Concern | BrowserX location | State |
|---|---|---|
| Event stream (server) | `server/streaming/agent-events.ts` `nextSeq()`/`resetSeq()`, `toAgentEvent→EventFrame` **seq'd** (`:19-157`) | **Every event already seq'd** — replay substrate exists (server only) |
| Connect snapshot (server) | `server/connection/handshake.ts` `HandshakeSnapshotProviders`+`setHandshakeSnapshotProviders` (`:57-63`), challenge/connect (`:91-210`) | **Snapshot-at-connect hook exists** (server only; uses `@applepi/ws-server`) |
| Auth (server) | `server/connection/auth.ts` `AuthMode='none'|'token'|'password'|'trusted-proxy'` | Reusable for the relay leg |
| Desktop WS | `src/desktop/channels/WebSocketChannel.ts:52` wrapping `./websocket/WebSocketServer` | LAN drive works; **does NOT use `@applepi/ws-server` seq/snapshot/handshake** |
| Desktop default channel | `DesktopAgentBootstrap` creates `TauriChannel` (`:115`), not `WebSocketChannel` | Desktop is UI-driven by default; WS is opt-in |
| Outbound-connect pattern | `server/channel-connectors/connector-bridge.ts:46-76` outbound connect + backoff state machine | Structural sibling for a relay worker (chat-channel purpose — don't build on it) |
| Scheduler | `core/scheduler/` (`ScheduleManager`/`Scheduler`/`JobExecutor`, rrule) | RemoteTrigger substrate |
| Teleport | none (grep) | Out of scope |

### Per-Platform Behavior — relay topology roles

The three targets play **different roles** in the topology; the work lands differently per role.

- **Apple Pi Server (headless).** The full **relay-able agent host**. It already has `@applepi/ws-server` + per-event `nextSeq` (`agent-events.ts`) + `HandshakeSnapshotProviders` (`handshake.ts`) + `auth.ts` + watchdog. Phase 2 (viewer/driver + `sinceSeq` replay) lands here directly with the smallest delta. The scheduler is fully wired in `ServerAgentBootstrap`, so RemoteTrigger (Phase 1) is most natural here. Phase 3's outbound relay worker also belongs here for servers behind NAT (home-lab, on-prem).
- **Apple Pi (desktop, Tauri).** The canonical *target* of "drive my desktop from my phone" (home NAT). It is a relay-host **candidate**: it has a `WebSocketChannel`/`WebSocketServer` (LAN drive already works) but runs `TauriChannel` by default and **does not consume** the `@applepi/ws-server` seq/snapshot/handshake substrate (server-only today). **Concrete consequence:** Phase 2's "rides existing seq + snapshot" is true *for the server*; for the desktop to be a replay-capable host or a Phase-3 relay host, that substrate (`nextSeq`/`resetSeq`/`HandshakeSnapshotProviders`/handshake) must be **lifted from `src/server` into a shared module** (core or `@applepi/ws-server`) that both `src/server` and the desktop `WebSocketChannel` consume. This shared-substrate lift is the single largest hidden cost in the track and is a hard prerequisite for the canonical use case. Phase 3's outbound relay worker matters most here (desktop dials out through the relay so the phone never touches the home network).
- **BrowserX (extension, Chrome MV3).** **Client-only** in this topology — a viewer/driver UI connecting to a remote host/relay. It cannot be a relay host: there is no extension WS server, and the MV3 service worker cannot hold a long-poll/outbound relay connection (same eviction constraint as Tracks 12/16). The relay worker (Phase 3) is therefore **desktop/server only**; the extension participates purely as a remote client (and is an excellent driver UI for a remote Apple Pi Server).

### Key design decisions (and divergences from claudy)

1. **Mid-stream replay rides the EXISTING seq + snapshot hooks — on the server; a shared-substrate lift is required for the desktop host path.** The server already (a) seq-numbers every event (`agent-events.ts:nextSeq`) and (b) has `HandshakeSnapshotProviders` at connect. Late-join = snapshot digest + "replay events since `seq N`": a `sinceSeq` subscribe param + a bounded per-run event ring. **Refined divergence (corrects first-pass over-optimism):** this is a small delta *for the server only*. The desktop `WebSocketChannel` lacks this substrate; making the desktop a replay host requires moving the seq/snapshot/handshake code into a shared module first. claudy's SDK stream has no comparable built-in seq/snapshot pairing at all.
2. **Viewer/driver roles + takeover on the existing stream.** Add `role:'viewer'|'driver'` to the connection (mirrors claudy's `viewerOnly`): viewers get events only; a single driver lock gates `UserInput`/`Interrupt`; explicit takeover protocol. Layers onto `handshake.ts`/`watchdog.ts` connection records (server) and, post-lift, the shared substrate (desktop). No new transport.
3. **Relay/rendezvous is the real cost (Phase 3, infra-gated).** A hosted broker so a host (server or desktop) dials *out* and long-polls — port claudy's `registerBridgeEnvironment`/`pollForWork`/`acknowledgeWork` shape (`bridge/types.ts:134-149`). **Reuse the `ConnectorBridge` outbound-connect-with-backoff pattern** (`connector-bridge.ts:46-76`) as the structural sibling + the existing WS `auth.ts`/handshake for the relay leg. **Divergence:** claudy rides Anthropic's Environments API + relay; browserx needs its own hosted relay — an explicit infra decision, Phase 3 gated. Do **not** build it on the chat-channel `ConnectorBridge` path (different purpose). The relay worker exists in *both* server and desktop bootstraps (shared core state machine, two host integrations); never in the extension.
4. **RemoteTrigger = thin token-safe tool over the existing scheduler (Phase 1, independent quick win).** Expose a tool wrapper over `core/scheduler/ScheduleManager` so the agent manages scheduled remote runs without leaking credentials to the model — mirrors claudy's `RemoteTriggerTool`. Lands first; server-primary (full scheduler wired there).
5. **Teleport explicitly deferred (P3).** Browser/DOM live state is not git-bundleable; no existing browserx teleport.

## Implementation Plan (file-level, ordered)

**Phase 1 (P2/S) — RemoteTrigger.**
- `core/scheduler/remoteTrigger/RemoteTriggerTool.ts`: token-safe tool over `ScheduleManager`/`Scheduler`; register on server (and desktop) agents. Independent of relay infra.

**Phase 2a (P1/M) — shared substrate lift (prerequisite for desktop host + clean reuse).**
- Move `nextSeq`/`resetSeq`/`toAgentEvent` (`server/streaming/agent-events.ts`) + `HandshakeSnapshotProviders`/handshake (`server/connection/handshake.ts`) into a shared module (core or `@applepi/ws-server`). `src/server` consumes it unchanged; the desktop `WebSocketChannel` (`src/desktop/channels/WebSocketChannel.ts`) gains it. Pure refactor, behavior-preserving, test-pinned.

**Phase 2b (P1/M) — viewer/driver + replay.**
- Add `role:'viewer'|'driver'` + single-driver lock + takeover to the connection record (`handshake.ts`/`watchdog.ts`, shared post-lift).
- `sinceSeq` subscribe param + bounded per-run event ring buffer; late-join = `HandshakeSnapshotProviders` digest then replay-since-seq.

**Phase 3 (P1/L, infra-gated) — outbound relay worker.**
- `core/remote/relay/RelayWorker.ts`: `registerEnvironment`/`pollForWork`/`ack` shape, reusing the `ConnectorBridge` connect+backoff state machine and WS `auth.ts`. Integrate into `ServerAgentBootstrap` and `DesktopAgentBootstrap` (two host integrations, one core worker). Hosted-relay infra decision is an explicit gate; Phases 1–2 deliver value without it. Never in the extension.

## Dependencies

- Existing `server/streaming/agent-events.ts`, `server/connection/{handshake,auth,watchdog}.ts`, `server/channel-connectors/connector-bridge.ts` (pattern), `src/desktop/channels/WebSocketChannel.ts`, `core/scheduler/` — reuse, not rebuild.
- **Track 01** (Events): replay rides the `EventMsg`→`EventFrame` seq stream.
- **Track 04** (Typed Tasks): a relay session is a task family.
- **Track 07** (Centralized State): the late-join state digest.
- **Track 20** (Managed Settings): the shared remote fetch/auth pattern overlaps the relay registration leg.

## Risks

- **Shared-substrate lift (Phase 2a)** is a prerequisite the first pass missed: replay is "free" only on the server; the desktop host path costs a refactor first. Sequence 2a before 2b/3.
- Hosted relay = operational + security + cost surface — Phase 3 strictly gated on an infra decision.
- Multi-driver conflict — explicit single-driver lock + takeover; viewers strictly read-only.
- Event ring sizing: bounded per run; "snapshot then live" fallback when a client is too far behind.
- Don't build the relay on the chat-channel `ConnectorBridge` — same outbound pattern, different purpose.
- Extension must never be wired as a relay host (MV3 SW can't sustain it) — client-only by construction.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `bridge/types.ts:69,134-149`; `bridge/` (`remoteBridgeCore.ts`, `envLessBridgeConfig.ts`, `jwtUtils.ts`, `trustedDevice.ts`, `workSecret.ts`); `remote/RemoteSessionManager.ts:30-61`; `cli/transports/`.
- browserx server: `server/streaming/agent-events.ts:19-157`; `server/connection/handshake.ts:36-210` (`HandshakeSnapshotProviders` `:57-63`); `server/connection/auth.ts:16-19`; `server/channel-connectors/connector-bridge.ts:46-76`; `@applepi/ws-server` consumed only under `src/server` (grep); `core/scheduler/`.
- browserx desktop/extension: `src/desktop/channels/WebSocketChannel.ts:52,56,65` + `./websocket/WebSocketServer` (LAN WS, no `@applepi/ws-server` substrate); `src/desktop/agent/DesktopAgentBootstrap.ts:115` (`TauriChannel` default); extension — no WS server, MV3 SW cannot host a relay (client-only).

Corrections vs the first-pass draft:
1. browserx **already** pairs per-event `nextSeq` with a `HandshakeSnapshotProviders` hook — replay is a `sinceSeq` param + ring buffer **on the server**.
2. `ConnectorBridge` is the structural sibling for the outbound relay worker; explicitly not the build base (chat-channel purpose).
3. No browserx teleport (grep) — P3 deferral justified.
4. **Multi-platform (2026-05-15):** clarified topology roles — server = full relay host (replay is a small delta); desktop = host *candidate* whose `WebSocketChannel` lacks the `@applepi/ws-server` seq/snapshot/handshake substrate, so a **shared-substrate lift (new Phase 2a)** is a hard prerequisite for the canonical "drive my desktop from my phone" case; extension = client-only (MV3 SW cannot host a relay). The relay worker spans server+desktop bootstraps (one core worker, two integrations), never the extension.
