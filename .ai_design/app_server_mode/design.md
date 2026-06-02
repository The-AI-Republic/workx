# Apple Pi App-Server Mode Design

Status: Ready for implementation
Date: 2026-06-02

## Goal

Enable one installed Apple Pi desktop app to serve both roles:

1. Normal interactive UI app.
2. Local callable app-server that another process, program, script, or agent can call.

The first production target is local machine automation through a loopback WebSocket endpoint exposed by the desktop runtime sidecar. The design should also keep the headless server path functional and make future Unix socket/named pipe support straightforward.

## Non-goals

- Do not implement A2A server mode as part of this work. `src/core/a2a/A2AServer.ts` remains separate.
- Do not use the stale desktop WebSocket path in `src/desktop/channels/WebSocketChannel.ts` and `src/desktop/channels/websocket/WebSocketServer.ts`.
- Do not move runtime ownership from the Node sidecar to Rust/Tauri.
- Do not build a second agent process just for app-server mode.
- Do not replace the current `@applepi/ws-server` protocol in the MVP.

## Executive Summary

Apple Pi already has most of the server-mode pieces:

- A headless WebSocket/HTTP server in `src/server/index.ts`.
- A typed protocol package in `packages/ws-server`.
- Server handlers for chat, sessions, config, credentials, approvals, tools, logs, and health.
- A shared runtime bootstrap in `src/server/agent/ServerAgentBootstrap.ts`.
- A desktop Node sidecar in `src/desktop-runtime`.
- A channel abstraction that already supports multiple channel types through `ChannelManager`.

The main gap is that the desktop runtime currently registers one channel only: `StdioRuntimeChannel`, which talks to the Tauri UI. App-server mode should add a second runtime channel inside the same Node sidecar. That channel should expose the existing server protocol over a local WebSocket listener and submit work through the same `ChannelManager` and agent runtime.

The most important implementation change is to make `ServerAgentBootstrap` multi-channel capable. Once the bootstrap can register more than one `ChannelAdapter`, the desktop app can keep the UI channel and add an app-server channel without creating a second agent runtime.

Codex's app-server implementation provides the stability lessons Apple Pi should copy:

- Explicit initialize/connect handshake per connection.
- Strong local transport security: reject browser `Origin` requests and require auth for non-loopback.
- Bounded queues and overload errors instead of unbounded task spawning.
- Slow-consumer protection.
- Per-connection state and disconnect cleanup.
- Request serialization by resource, so conflicting mutations do not race.
- A connection RPC gate so queued requests do not start after a connection closes.
- Health and readiness endpoints.
- Tests that verify per-connection isolation and shutdown behavior.

## Current Apple Pi Architecture

### Headless Server

Current server mode exists as a standalone Node entrypoint:

- `src/server/index.ts`
- `src/server/config/server-config.ts`
- `src/server/connection/handshake.ts`
- `src/server/connection/rate-limiter.ts`
- `src/server/connection/watchdog.ts`
- `src/server/limits/resource-limits.ts`
- `src/server/auth/authorize.ts`
- `src/server/channels/ServerChannel.ts`
- `src/server/handlers/*.ts`

The server listens on WebSocket/HTTP and has a default documented port of `18100`. It already serves a `/health` endpoint and performs handshake, method dispatch, scope checks, rate limiting, and connection cleanup.

The protocol lives in:

- `packages/ws-server/src/frames.ts`
- `packages/ws-server/src/methods.ts`
- `packages/ws-server/src/errors.ts`

Important protocol facts:

- `PROTOCOL_VERSION = 1`.
- Server starts with `connect.challenge`.
- Client sends `connect`.
- Server replies with `hello-ok` (the wire/schema value is `hello-ok`, not `hello.ok`; see `packages/ws-server/src/frames.ts:203`).
- Method registry includes:
  - `chat.send`
  - `chat.abort`
  - `chat.history`
  - `chat.inject`
  - `sessions.list`
  - `sessions.get`
  - `sessions.patch`
  - `sessions.reset`
  - `sessions.delete`
  - `sessions.compact`
  - `sessions.turns`
  - `sessions.rewind`
  - `config.get`
  - `config.set`
  - `config.patch`
  - `health`
  - `tools.catalog`
  - `logs.tail`
  - `credentials.list`
  - `credentials.set`
  - `credentials.delete`
  - `exec.approval.resolve`

This is enough protocol surface to make app-server mode useful immediately.

### Desktop Runtime

The desktop app already runs the agent in a Node sidecar:

- `src/desktop-runtime/index.ts`
- `src/desktop-runtime/PiRuntimeBootstrap.ts`
- `src/desktop-runtime/channels/StdioRuntimeChannel.ts`
- `src/desktop-runtime/protocol/stdioCarrier.ts`
- `src/desktop-runtime/protocol/controlBridge.ts`
- `src/desktop-runtime/host.ts`
- `tauri/src/runtime_supervisor.rs`

Rust/Tauri supervises the sidecar process, sends length-prefixed JSON frames over stdio, and relays runtime events to the web UI.

`PiRuntimeBootstrap` is a desktop specialization of `ServerAgentBootstrap`. It passes a `StdioRuntimeChannel` into the shared bootstrap.

### Shared Bootstrap Gap

`src/server/agent/ServerAgentBootstrap.ts` currently stores a single channel:

```ts
private channel: ChannelAdapter | null = null;
```

During initialization it does:

```ts
this.channel = this.options.channel ?? new ServerChannel();
channelManager.registerChannel(this.channel);
```

Its event dispatcher sends every agent event only to that one channel:

```ts
channelManager.dispatchEvent(
  { msg: event.msg, sessionId },
  this.channel!.channelId
);
```

This is the core reason an installed Apple Pi app cannot yet behave as both UI and app-server through the same runtime. The runtime is structurally single-channel even though `ChannelManager` already supports multiple channels.

### Stale Desktop WebSocket Path

Do not build on these files:

- `src/desktop/channels/WebSocketChannel.ts`
- `src/desktop/channels/websocket/WebSocketServer.ts`

That path uses old `user_turn`/`assistant_chunk` style events and invokes Tauri commands such as `ws_server_start`, `ws_send`, `ws_server_stop`, and `ws_disconnect` that are not present in the current Rust runtime. It is not aligned with `packages/ws-server` or the desktop sidecar architecture.

## Current Codex App-Server Architecture

Codex app-server lives across these crates:

- `/home/rich/dev/study/codex/codex-rs/app-server`
- `/home/rich/dev/study/codex/codex-rs/app-server-protocol`
- `/home/rich/dev/study/codex/codex-rs/app-server-transport`
- `/home/rich/dev/study/codex/codex-rs/app-server-client`
- `/home/rich/dev/study/codex/codex-rs/app-server-daemon`
- `/home/rich/dev/study/codex/codex-rs/app-server-test-client`

Codex uses JSON-RPC 2.0 semantics without the `"jsonrpc": "2.0"` field on the wire. It supports stdio by default, Unix sockets, experimental WebSocket, and off mode.

Key implementation patterns to copy:

### Transport Abstraction

`codex-rs/app-server-transport/src/transport/mod.rs` defines transport events:

- `ConnectionOpened`
- `ConnectionClosed`
- `IncomingMessage`

Transport code only accepts bytes/connections and forwards normalized events to the processor. The processor owns protocol behavior.

Apple Pi should copy the separation:

- WebSocket listener accepts and authenticates connections.
- Connection registry tracks authenticated clients.
- Request processor validates frames and dispatches methods.
- Channel submits work to the agent runtime.

### Bounded Queues

Codex uses bounded channels with `CHANNEL_CAPACITY = 128`.

If inbound request queues are full, Codex returns JSON-RPC error code `-32001` with message `Server overloaded; retry later.`

Apple Pi should add an equivalent overload path in `packages/ws-server/src/errors.ts` and never let an external caller create an unbounded queue of work.

### Origin Rejection

Codex's WebSocket transport rejects any HTTP request with an `Origin` header. This prevents random browser pages from calling a local app-server through loopback.

Apple Pi app-server mode should reject `Origin` by default. Browser-origin access should require an explicit allowlist later, not be enabled by accident.

### Auth Policy

Codex refuses unauthenticated non-loopback WebSocket listeners. It also supports capability-token and signed-bearer-token auth modes.

Apple Pi MVP should:

- Bind only to `127.0.0.1` by default.
- Require a generated capability token for app-server mode.
- Keep LAN binding disabled by default.
- Require explicit config to bind anywhere other than loopback.

### Per-Connection State

Codex tracks initialized state, experimental API state, opt-out notification methods, client info, and outbound writer state per connection.

Apple Pi already tracks connection metadata in the server path. Desktop app-server mode should use the same concept and avoid global connection flags.

### Slow Consumer Protection

Codex's outbound router disconnects slow connections when the outbound queue is saturated.

Apple Pi should enforce:

- Maximum WebSocket `bufferedAmount`.
- Maximum per-connection outbound queue length.
- Close slow clients with a protocol close code.

### Request Serialization

Codex serializes requests by resource key. Mutating requests against the same thread/process/config resource are exclusive. Non-conflicting reads can run in parallel.

Apple Pi should introduce the same idea before exposing desktop app-server mode broadly. At minimum:

- Chat mutation requests for the same session are serialized.
- Config and credential writes are serialized globally.
- Session mutations for the same session are serialized.
- Health and read-only queries can run concurrently.

### Connection RPC Gate

Codex has a `ConnectionRpcGate` that prevents queued handlers from starting after a connection closes while allowing in-flight handlers to finish.

Apple Pi needs this because a local tool may disconnect while a request is queued. The server must not start the queued request later with no active requester.

### In-Process Mode

Codex's `in_process.rs` keeps app-server semantics but removes socket transport. This is important conceptually for Apple Pi: app-server behavior is an API surface, not just a WebSocket listener.

Apple Pi desktop app-server should run in-process inside the same Node runtime sidecar. The WebSocket transport is just one caller transport.

## Target Architecture

```text
                Installed Apple Pi desktop app

  Web UI <-> Tauri runtime_supervisor <-> Node sidecar process
                                            |
                                            v
                               PiRuntimeBootstrap
                                            |
                                            v
                                  ChannelManager
                                  /            \
                                 /              \
                                v                v
                StdioRuntimeChannel       AppServerChannel
                channelId:                channelId:
                desktop-runtime-main      desktop-app-server
                channelType: tauri        channelType: websocket
                       |                         ^
                       v                         |
                Tauri UI events          WebSocket listener
                                         ws://127.0.0.1:18101
                                         /readyz, /healthz, /health
```

The agent runtime remains single. Only the caller channels multiply.

## Core Decisions

### 1. The Listener Lives In The Node Sidecar

The app-server listener should be started from `src/desktop-runtime/index.ts` after the runtime bootstrap is initialized.

Reasons:

- The Node sidecar already owns the agent runtime.
- The sidecar already has `ChannelManager`, services, config, sessions, and tools.
- Rust/Tauri already supervises sidecar lifecycle.
- Starting a second standalone `src/server/index.ts` process would duplicate the agent runtime and create session/config contention.

### 2. Reuse The Existing Protocol For MVP

Use `packages/ws-server` protocol v1 for the first implementation.

Reasons:

- The protocol already has connect challenge, method registry, scopes, events, and errors.
- The existing server handlers can be reused.
- Existing headless server clients stay compatible.

Future API cleanup can introduce a v2 protocol with resource/method names closer to Codex, for example `thread/start` and `turn/start`. That should not block the MVP.

### 3. Add Multi-Channel Runtime Support

`ServerAgentBootstrap` should support more than one registered channel.

Minimal API:

```ts
export interface ServerAgentBootstrapOptions {
  profile?: ServerAgentProfile;
  dataDir?: string;
  channel?: ChannelAdapter;
  channels?: ChannelAdapter[];
}

export class ServerAgentBootstrap {
  async registerChannel(channel: ChannelAdapter): Promise<void>;
  async unregisterChannel(channelId: string): Promise<void>;
}
```

Implementation guidance:

- Preserve `channel` for backward compatibility.
- Treat `channel` as the primary channel.
- Register `channels` during `initialize()`.
- Allow additional channels to be registered after initialization.
- Keep `ChannelManager` as the single router.

### 4. Keep App-Server Disabled By Default

Installed app-server mode is powerful. The default desktop app behavior should be no listening socket unless enabled by config or explicit UI setting.

Default config:

```ts
appServer: {
  enabled: false,
  transport: 'websocket',
  bindHost: '127.0.0.1',
  port: 18101,
  requireAuth: true,
  rejectBrowserOrigins: true,
  allowLan: false,
  maxConnections: 16,
  maxPayloadBytes: 1_048_576,
  maxBufferedBytes: 4_194_304,
  requestQueueCapacity: 128,
}
```

Port `18101` avoids colliding with the existing headless server default of `18100`.

### 5. Require Capability Token Auth

Even on loopback, a generated token should be required for app-server mode. Loopback alone is not enough when browsers, local malware, or unrelated developer tools can reach local ports.

Token storage:

- Prefer the desktop keychain through the existing runtime control bridge (`controlBridge.keychain.get/set/delete` is available).
- Fall back to the desktop runtime data directory only if keychain is unavailable. The fallback file must be written with `0600` permissions, and the UI must surface a warning that secure (keychain) storage is unavailable, because a local process that can read this file gains the connection's full scope set.
- Never print the token in normal logs.
- Provide an explicit UI/service action to rotate or reveal/copy the token.

Layering constraint: `AppServerAuth` lives in the host-agnostic `src/app-server/connection/` layer, so it must accept an **injected token provider/store** (interface) rather than importing the desktop control bridge directly. `DesktopAppServerManager` constructs the keychain-backed token store and injects it. This keeps `src/app-server/` reusable for the later headless migration.

Capability-token role/scope mapping (Phase 1): the design must specify which role/scopes a capability-token connection receives — this is currently unspecified, and the existing default is dangerous. `resolveScopes(role, requested)` grants the **full role defaults** when the client requests no scopes (`src/server/auth/roles.ts:63-71`), and the `operator` role defaults include `config.write`, `credentials.read`, `credentials.write`, and `admin` (`roles.ts:20-35`). If a capability-token connection is treated as `operator` with no requested scopes, it silently gets full credential and config write access. Phase 1 must therefore either map the capability token to a narrow role or require an explicit reduced scope set by default, with credential/config-write scopes opt-in. Broad per-client scope configuration remains Phase 2.

Handshake:

- Continue using `connect.challenge` and `connect`.
- A `'token'` auth mode already exists with constant-time verification (`src/server/connection/auth.ts:16` defines `AuthMode = 'none' | 'token' | 'password' | 'trusted-proxy'`; `verifyToken()` at `auth.ts:50-94` does the constant-time compare; the token arrives via `req.params.auth` at `handshake.ts:191`). **Decision needed:** either reuse the existing `'token'` mode for app-server (smaller change, the constant-time-compare task is already satisfied) or add a distinct `'capability-token'` variant if per-capability semantics are wanted. The challenge currently advertises a single mode (`authModes: [config.server.auth.mode]`, `handshake.ts:101`); the app-server transport must source its mode from `IAppServerConfig`, not `config.server.auth`.
- Bind the authenticated identity to connection state.

### 6. Reject Browser Origins

For desktop app-server mode:

- Reject any HTTP/WebSocket upgrade request with an `Origin` header by default.
- Return `403`.
- Do not accept browser-origin local calls unless an explicit allowlist is added later.

This is a direct Codex lesson and should be part of Phase 1, not deferred.

### 7. Do Not Crash The App On App-Server Failure

If app-server mode fails to start because the port is already in use, auth config is invalid, or TLS/keychain setup fails:

- The desktop UI and agent runtime should continue running.
- Runtime status should report `appServer.status = 'error'`.
- The error should be visible in settings/logs.
- A restart action should retry the listener.

## New Module Layout

Create a reusable app-server layer instead of copying all of `src/server/index.ts` into desktop runtime.

Recommended layout:

```text
src/app-server/
  AppServerManager.ts
  AppServerChannel.ts
  AppServerRequestProcessor.ts
  AppServerConnectionRegistry.ts
  appServerConfig.ts
  connection/
    AppServerAuth.ts
    ConnectionRpcGate.ts
    ConnectionWatchdog.ts
    rateLimiter.ts
  transport/
    AppServerWebSocketTransport.ts
    httpHealth.ts
  scheduling/
    RequestScheduler.ts
    requestSerialization.ts
  status/
    AppServerStatus.ts
```

Responsibility boundary between the two managers (define this explicitly to avoid duplicated logic):

- `AppServerManager` (in `src/app-server/`) is **host-agnostic**. It owns the transport, request processor, connection registry, request scheduler, and status controller. It accepts its config and an `AppServerAuthProvider` as injected dependencies and knows nothing about the desktop control bridge, keychain, or Tauri.
- `DesktopAppServerManager` (in `src/desktop-runtime/`) does **only desktop wiring**: read `IAgentConfig.appServer`, obtain/rotate the capability token via the control-bridge keychain, build the desktop `AppServerAuth`, construct an `AppServerManager` with those deps, register the `AppServerChannel` on the bootstrap, and publish status to runtime services.

The same `AppServerManager` is what a later headless migration reuses.

Desktop integration:

```text
src/desktop-runtime/app-server/
  DesktopAppServerManager.ts
```

Headless integration can be migrated later:

```text
src/server/index.ts
  imports reusable app-server transport/processor modules
```

Do not make the first implementation depend on headless refactor completion. The desktop app-server can use the new reusable layer first, then headless server can be migrated to the same layer in a later cleanup.

## Config Design

Add config types in `src/config/types.ts`:

```ts
export type AppServerTransport = 'websocket';

export interface IAppServerConfig {
  enabled: boolean;
  transport: AppServerTransport;
  bindHost: string;
  port: number;
  requireAuth: boolean;
  rejectBrowserOrigins: boolean;
  allowLan: boolean;
  maxConnections: number;
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  requestQueueCapacity: number;
}

export interface IAgentConfig {
  // existing fields
  appServer?: IAppServerConfig;
}
```

Add defaults in `src/config/defaults.ts`.

Add validation in `src/config/configSchema.ts`. This file uses Zod plus per-field `llm_access` metadata organized by `SECTIONS`. The new `appServer` fields must be added as a new section with `llm_access` set to **no LLM write access** (the agent must not be able to enable its own server or change its bind/auth settings); read access can also be withheld to avoid exposing the token surface. Validation rules:

- `enabled`: boolean.
- `transport`: only `'websocket'` for MVP.
- `bindHost`: default `127.0.0.1`.
- `port`: integer `0..65535`; `0` allowed only if UI can show assigned port.
- `requireAuth`: boolean. There is no development-override field in `IAppServerConfig`; either add an explicit `devAllowNoAuth?: boolean` field guarded by a dev build flag, or drop the "unless development override" caveat. Do not silently treat `false` as valid in production.
- `rejectBrowserOrigins`: boolean; default true.
- `allowLan`: boolean; if false, reject non-loopback bind hosts.
- `maxConnections`: integer `1..256`.
- `maxPayloadBytes`: integer `1024..67108864`.
- `maxBufferedBytes`: integer `65536..67108864`.
- `requestQueueCapacity`: integer `1..4096`.

Desktop app-server must not use `src/server/config/server-config.ts`. That file is for the standalone server environment variables and `.applepi-server/config.json`.

## Runtime Status And Services

Expose app-server status through runtime services so the UI can render status and control it.

Extend `src/core/services/runtime-services.ts`:

```ts
runtime.getStateSnapshot -> {
  // existing fields
  appServer: {
    enabled: boolean;
    status: 'disabled' | 'starting' | 'ready' | 'error' | 'stopping';
    url?: string;
    bindHost?: string;
    port?: number;
    authMode?: 'capability-token';
    connections: number;
    lastError?: string;
  };
}
```

Add service handlers:

```text
appServer.getStatus
appServer.setConfig
appServer.restart
appServer.stop
appServer.rotateToken
```

These services are for UI control only. External WebSocket clients should use protocol methods from `packages/ws-server`.

## Bootstrap Implementation

### Step 1: Make Bootstrap Multi-Channel

Modify `src/server/agent/ServerAgentBootstrap.ts`:

```ts
private channels = new Map<string, ChannelAdapter>();
private primaryChannelId: string | null = null;
```

During initialize:

```ts
const initialChannels = [
  ...(this.options.channel ? [this.options.channel] : []),
  ...(this.options.channels ?? []),
];

const channels = initialChannels.length > 0
  ? initialChannels
  : [new ServerChannel()];

for (const channel of channels) {
  await this.registerChannel(channel);
}
this.primaryChannelId = channels[0]?.channelId ?? null;
```

Add:

```ts
async registerChannel(channel: ChannelAdapter): Promise<void> {
  if (!this.initializedChannelManager) {
    // store for initialize or throw depending on implementation choice
  }
  this.channelManager.registerChannel(channel);
  this.channels.set(channel.channelId, channel);
}
```

Also add `unregisterChannel` if `ChannelManager` does not already support it. If unregister support is absent, implement it in `src/core/channels/ChannelManager.ts`.

### Step 2: Event Dispatch

Current code dispatches only to `this.channel!.channelId`. Replace that with multi-channel dispatch.

A naive `broadcastEvent` is **not** safe for Phase 1. Verified current behavior makes this a correctness/security gap, not a cosmetic one:

- `channelManager.broadcastEvent(...)` sends to every registered channel (`ChannelManager.ts:119`).
- `StdioRuntimeChannel.sendEvent` forwards every event unfiltered to the Tauri UI; it does not inspect `sessionId` (`StdioRuntimeChannel.ts:43-45`).
- `ServerChannel.sendEvent` filters by **scope only**, never by session (`ServerChannel.ts:105-106`; `authorize.ts:75-93` ignores `sessionId`). `ChannelEvent` carries only `{ msg, sessionId? }` (`core/channels/types.ts:17-22`).

So a plain broadcast leaks every external session's events into the desktop UI, and leaks one app-server client's session events to every other connected client. Phase 1 integration test #9 ("streams events only to authorized/subscribed clients") cannot pass under a plain broadcast.

**Therefore session→channel ownership routing and per-connection session-subscription filtering are Phase 1, not Phase 2.** Minimum required in Phase 1:

- Record the owning channel for each session when it is created (the existing per-session `eventDispatcherFactory(sessionId)` already runs in the owning context — route on that instead of broadcasting to all channels).
- `AppServerChannel.sendEvent()` filters by authenticated connection, event scope, and session subscription/ownership before sending.
- The UI `StdioRuntimeChannel` must not receive events for sessions owned by app-server connections (and vice versa) beyond global runtime-status events.

The Phase 2 work is then only the richer router below and run-level (`runId`) ownership refinement, not basic session isolation.

Preferred Phase 2 router (refinement on top of the Phase 1 ownership map):

```ts
interface ChannelEventRouter {
  registerSessionOwner(sessionKey: string, channelId: string): void;
  dispatchAgentEvent(event: AgentEvent, sessionId: string): Promise<void>;
}
```

Routing rule:

- Send to the originating channel.
- Send to UI channel only if UI is observing that session or global runtime status should update.
- Send to app-server connections only if subscribed and authorized.

## AppServerChannel

Create `src/app-server/AppServerChannel.ts`.

It should implement `ChannelAdapter` and be a cleaned-up desktop-compatible version of `src/server/channels/ServerChannel.ts`.

Required behavior:

- `channelId = 'desktop-app-server'` by default.
- `channelType = 'websocket'`.
- Accept an injected connection registry.
- Accept an injected request processor.
- Send events to authenticated connections only.
- Apply event scope filtering.
- Apply session/run subscription filtering.
- Track active requests by connection and session.
- On connection close, cancel/mark queued requests for that connection.

Do not hardcode `server-main`.

Current handler issue:

`src/server/handlers/chat.ts` builds context with:

```ts
channelId: 'server-main',
channelType: 'server',
sessionId: ctx.sessionKey,
```

Change method context so handlers can use the caller channel. This must be an **additive** change to the existing `MethodContext` in `packages/ws-server/src/methods.ts` — do not drop the current fields. The existing interface today is:

```ts
export interface MethodContext {
  connectionId: string;
  requestId: string;
  role: string;
  scopes: string[];
  userId?: string;
  sessionKey?: string;
  sendEvent: (event: string, payload?: unknown) => void;
}
```

Add only the two new fields, preserving the rest:

```ts
export interface MethodContext {
  // ...all existing fields above...
  channelId: string;
  channelType: ChannelType;
}
```

The dispatcher must populate `channelId`/`channelType` for **every** caller. For the headless server path these must default to `'server-main'`/`'server'` so existing headless behavior is preserved (otherwise the `chat.ts` change below is a headless regression).

Then `chat.send` should use:

```ts
channelId: ctx.channelId,
channelType: ctx.channelType,
sessionId: ctx.sessionKey,
```

This is required for desktop app-server events to route through the right channel.

## WebSocket Transport

Create `src/app-server/transport/AppServerWebSocketTransport.ts`.

It should contain reusable logic currently concentrated in `src/server/index.ts`:

- HTTP server creation.
- WebSocket upgrade handling.
- `/readyz` endpoint.
- `/healthz` endpoint.
- `/health` endpoint for existing compatibility.
- Origin rejection.
- Payload limit.
- Connection count limit.
- Handshake timeout.
- Rate limiter attachment.
- Watchdog/heartbeat.
- Slow consumer checks.
- Graceful stop.

Recommended public API:

```ts
export interface AppServerWebSocketTransportOptions {
  host: string;
  port: number;
  maxConnections: number;
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  rejectBrowserOrigins: boolean;
  auth: AppServerAuthProvider;
  processor: AppServerRequestProcessor;
  status: AppServerStatusController;
}

export class AppServerWebSocketTransport {
  start(): Promise<AppServerListenInfo>;
  stop(reason?: string): Promise<void>;
}
```

If `port = 0`, return the assigned port in `AppServerListenInfo`.

## Handshake And Auth

Use the existing challenge/connect flow from `src/server/connection/handshake.ts`, but make it reusable for desktop app-server.

MVP auth mode:

```text
capability-token
```

Token requirements:

- Generated automatically on first enable.
- Stored in keychain if available.
- Scoped to the local desktop app installation.
- Rotatable through `appServer.rotateToken`.
- Accepted only during `connect`.
- Compared using constant-time comparison.

Connection state after connect:

```ts
interface AppServerConnectionState {
  connectionId: string;
  authenticated: boolean;
  role: Role;
  scopes: Scope[];
  sessionKey: string;
  clientInfo?: ClientInfo;
  subscriptions: Set<string>;
  requestIds: Set<string | number>;
  createdAt: number;
  lastSeenAt: number;
}
```

Pre-connect method frames should be rejected with `UNAUTHORIZED` or `INVALID_REQUEST`, matching existing protocol semantics.

## Backpressure And Overload

Add an overload error in `packages/ws-server/src/errors.ts`:

```ts
export const ErrorCode = {
  // existing
  OVERLOADED: 'OVERLOADED',
} as const;
```

Recommended response body:

```json
{
  "code": "OVERLOADED",
  "message": "Server overloaded; retry later.",
  "retryable": true,
  "retryAfterMs": 250
}
```

Use bounded request scheduling:

```ts
interface ScheduledRequest {
  connectionId: string;
  requestId: RequestId;
  method: string;
  params: unknown;
  context: MethodContext;
}

class RequestScheduler {
  enqueue(request: ScheduledRequest): EnqueueResult;
  shutdown(reason: string): Promise<void>;
}
```

Rules:

- If queue length >= `requestQueueCapacity`, reject immediately with `OVERLOADED`.
- Do not start queued work if the connection closes before execution.
- Do not allow one connection to fill the entire queue if per-connection caps are enabled.
- Health checks should bypass or use a small separate queue so readiness remains observable.

Slow outbound client rules:

- If `ws.bufferedAmount > maxBufferedBytes`, close the connection.
- If per-connection outbound queue is full, close the connection.
- Emit a close reason such as `SLOW_CONSUMER`.

## Request Serialization

Add `src/app-server/scheduling/requestSerialization.ts`.

Serialization keys:

```ts
type RequestSerializationKey =
  | { kind: 'global'; resource: 'config' | 'credentials' | 'tools' }
  | { kind: 'session'; sessionKey: string }
  | { kind: 'approval'; approvalId: string }
  | { kind: 'connection-local'; connectionId: string }
  | { kind: 'none' };
```

Access modes:

```ts
type RequestAccessMode = 'read' | 'write';
```

Initial mapping:

| Method | Key | Mode |
| --- | --- | --- |
| `health` | none | read |
| `tools.catalog` | global:tools | read |
| `config.get` | global:config | read |
| `config.set` | global:config | write |
| `config.patch` | global:config | write |
| `credentials.list` | global:credentials | read |
| `credentials.set` | global:credentials | write |
| `credentials.delete` | global:credentials | write |
| `sessions.list` | none | read |
| `sessions.get` | session | read |
| `sessions.turns` | session | read |
| `sessions.patch` | session | write |
| `sessions.reset` | session | write |
| `sessions.delete` | session | write |
| `sessions.compact` | session | write |
| `sessions.rewind` | session | write |
| `chat.history` | session | read |
| `chat.send` | session | write |
| `chat.abort` | session | write |
| `chat.inject` | session | write |
| `exec.approval.resolve` | approval | write |
| `logs.tail` | connection-local | read |

Behavior:

- Writes for the same key are exclusive.
- Reads for the same key can run together.
- Reads do not overtake earlier writes.
- Requests for different keys can run concurrently.

This prevents two external callers from racing session mutation and chat generation on the same session.

## Connection RPC Gate

Add `src/app-server/connection/ConnectionRpcGate.ts`.

Behavior:

- Each accepted connection has a gate.
- Before a queued request starts, it must call `gate.tryEnter()`.
- If the connection is closed, `tryEnter()` fails and the request is dropped/rejected.
- In-flight requests release their gate permit on completion.
- On close, no new requests can enter.

This copies the Codex pattern and prevents disconnected clients from starting delayed work.

## Request Processing

Create `src/app-server/AppServerRequestProcessor.ts`.

Responsibilities:

- Parse and validate frames using `packages/ws-server`.
- Enforce connected/authenticated state.
- Enforce method scopes via existing `authorize.ts` logic.
- Deduplicate request IDs if the protocol requires it.
- Enqueue through `RequestScheduler`.
- Dispatch to existing server handlers.
- Send response frames.
- Track active requests by connection.
- Clean up on disconnect.

Do not let WebSocket transport call handlers directly. Transport should only create connection events and forward validated wire frames.

## Handler Reuse

Reuse current handlers where possible:

- `src/server/handlers/chat.ts`
- `src/server/handlers/sessions.ts`
- `src/server/handlers/config.ts`
- `src/server/handlers/credentials.ts`
- `src/server/handlers/exec.ts`
- `src/server/handlers/health.ts`
- `src/server/handlers/logs.ts`
- `src/server/handlers/tools.ts`

Required changes:

- Add `channelId` and `channelType` to `MethodContext`.
- Remove hardcoded `server-main` assumptions.
- Make config handlers use desktop `AgentConfig` services in desktop app-server mode, not `.applepi-server/config.json`.
- Keep credential writes requiring loopback or TLS. Desktop app-server loopback with token is acceptable for MVP.

Recommended dependency shape:

```ts
interface AppServerHandlerDeps {
  channelManager: ChannelManager;
  configStore: AgentConfigStore;
  credentialStore: CredentialStore;
  logs: LogsTailSource;
  appServerMode: 'desktop' | 'headless';
}
```

## Desktop Integration

Create `src/desktop-runtime/app-server/DesktopAppServerManager.ts`.

Responsibilities:

- Read `appServer` config after `PiRuntimeBootstrap.initialize()`.
- Ensure capability token exists if enabled.
- Create `AppServerConnectionRegistry`.
- Create `AppServerChannel`.
- Register the channel with `ServerAgentBootstrap.registerChannel()`.
- Start `AppServerWebSocketTransport`.
- Publish status to runtime services.
- Watch config changes and restart listener when host/port/auth settings change.
- Stop transport on sidecar shutdown.

Modify `src/desktop-runtime/index.ts`:

```ts
const bootstrap = new PiRuntimeBootstrap({ channel, host });
await bootstrap.initialize();

const appServerManager = new DesktopAppServerManager({
  bootstrap,
  host,
  controlBridge,
});
await appServerManager.startFromConfig();

// On shutdown:
await appServerManager.stop('runtime shutdown');
await bootstrap.shutdown();
```

If app-server startup fails, catch it, update status, log it, and keep the runtime alive.

## UI Integration

Minimal UI controls should be in an advanced/developer settings area:

- Toggle app-server mode.
- Show status: disabled, starting, ready, error, stopping.
- Show endpoint: `ws://127.0.0.1:18101`.
- Rotate token.
- Reveal/copy token through explicit action.
- Restart server.
- Show last error.

The UI should call runtime services, not talk to the WebSocket server itself.

Do not expose token in passive UI by default.

## External Client Contract

MVP external client flow:

1. Connect to `ws://127.0.0.1:18101`.
2. Receive `connect.challenge`.
3. Send `connect` with protocol version, client info, requested scopes, and capability token.
4. Receive `hello-ok`.
5. Send request frames, for example `chat.send`.
6. Receive response frame and event frames.
7. Send `chat.abort` to interrupt an active turn.

Example conceptual request:

```json
{
  "type": "request",
  "id": "req-1",
  "method": "chat.send",
  "params": {
    "message": "Summarize this repo",
    "sessionKey": "external-tool-session"
  }
}
```

`chat.send` should return enough identifiers for stable automation:

```json
{
  "status": "started",
  "sessionKey": "external-tool-session",
  "runId": "run_...",
  "accepted": true
}
```

Note: `runId`/`accepted` are not returned today, but the underlying id already exists — this is a low-effort surface, not net-new generation. `RepublicAgent.submitOperation()` already mints a per-turn submission id (`src/core/RepublicAgent.ts:688`) and returns it synchronously on the `chat.send` path. `chat-stream.ts` already exposes that id as `runId` on `TaskStarted` and delta events (`chat-stream.ts:129,166`). So Phase 1 work is: (a) capture the returned id in `chat.send` and add it to the response as `runId` (keep `status` for headless compatibility, Decision #2); (b) propagate `runId` from the existing per-turn id onto the `ChannelEvent` envelope (`core/channels/types.ts:17-22` carries only `{ msg, sessionId? }` today) so all event types — not just deltas — carry it. Reuse the existing submission id; do not invent a second identifier.

Events should include:

- `sessionKey`
- `runId` when applicable (net-new envelope field; see above)
- event type
- monotonically increasing sequence number where possible

## Security Requirements

Phase 1 must include:

- Default disabled.
- Loopback bind only.
- Capability token required.
- Browser `Origin` rejected.
- Max payload enforced.
- Max connection count enforced.
- Rate limiting enabled.
- Credential writes allowed only for loopback/TLS and authenticated clients.
- Token not logged.
- App-server failure does not crash UI runtime.

Phase 2 should include:

- Per-client scope configuration.
- Token rotation invalidates active sessions unless explicitly deferred.
- Optional signed bearer token support.
- Optional Unix socket/named pipe local transport.
- Per-method audit logs for credential/config mutations.

## Health And Readiness

Support:

- `GET /readyz`
- `GET /healthz`
- `GET /health`

Behavior:

- `/readyz` returns 200 when listener is accepting connections and runtime is initialized.
- `/healthz` returns health JSON including app-server status, runtime profile, connection count, and uptime.
- `/health` remains as compatibility alias for existing server clients.

Example:

```json
{
  "status": "ready",
  "profile": "desktop-runtime",
  "connections": 2,
  "uptimeMs": 123456
}
```

Do not include secrets.

## Testing Strategy

### Unit Tests

Add tests for:

- `AppServerAuth` token validation and constant-time compare path.
- Origin rejection decision.
- Request scheduler overload behavior.
- Request serialization ordering.
- Connection RPC gate close behavior.
- Slow consumer threshold behavior.
- Method context includes `channelId` and `channelType`.
- `chat.send` no longer hardcodes `server-main`.

### Integration Tests

Add desktop-runtime integration tests that start:

- `PiRuntimeBootstrap`.
- `StdioRuntimeChannel`.
- `DesktopAppServerManager`.
- WebSocket test client.

Required cases:

1. App-server disabled by default: no listener started.
2. Enabled app-server starts on loopback and `/readyz` returns 200.
3. `/health`, `/healthz`, and protocol `health` work.
4. WebSocket request with `Origin` is rejected.
5. Invalid token cannot connect.
6. Valid token can connect.
7. Request before `connect` is rejected.
8. Two clients can use the same request ID without cross-talk.
9. `chat.send` from external client streams events only to authorized/subscribed clients.
10. UI `StdioRuntimeChannel` continues receiving runtime events while app-server client is connected.
11. Disconnect before queued request starts prevents handler execution.
12. Queue saturation returns `OVERLOADED`.
13. Slow consumer is disconnected.
14. Port already in use sets app-server status error and keeps UI runtime alive.
15. Config toggle starts and stops listener without restarting the desktop app.
16. Shutdown stops the listener before sidecar exit.

### Regression Tests For Headless Server

If shared server modules are refactored, run and add tests for:

- Existing headless handshake.
- Existing `/health`.
- Existing method registry.
- Existing scope authorization.
- Existing logs tail behavior.

## Implementation Phases

### Phase 1: Desktop MVP

Deliver a working installed-app callable mode.

Tasks:

- Add `IAppServerConfig` defaults and schema.
- Add runtime app-server status services.
- Make `ServerAgentBootstrap` support additional channels.
- Add `AppServerChannel`.
- Add `DesktopAppServerManager`.
- Add WebSocket transport with `/readyz`, `/healthz`, `/health`.
- Add capability token auth.
- Reject `Origin`.
- Add max payload and max connection limits.
- Fix `chat.send`/method context to use caller channel (additive `MethodContext` change; headless defaults to `server-main`/`server`).
- Plumb a `runId` into the `chat.send` response and onto the `ChannelEvent` envelope (net-new; keep `status` for headless compatibility).
- Add session→channel ownership routing and per-connection session-subscription filtering so external sessions do not leak into the UI and clients do not see each other's events.
- Map the capability-token connection to a narrow role/scope set by default (no implicit credential/config-write).
- Add minimal integration tests, including multi-client event isolation and shutdown-before-exit.

Exit criteria:

- User can enable app-server mode in config/UI.
- External local process can call the running app through WebSocket.
- UI remains functional while external client is connected.
- Invalid browser-origin and invalid-token calls are rejected.
- App-server startup failure does not crash the app.

### Phase 2: Stability Hardening

Tasks:

- Add bounded `RequestScheduler`.
- Add `OVERLOADED` error.
- Add `ConnectionRpcGate`.
- Add request serialization.
- Add slow-consumer outbound protection.
- Add per-client session/event subscription filtering.
- Add config-driven restart on app-server settings change.
- Add broad integration tests for queue, disconnect, overload, and shutdown.

Exit criteria:

- Saturated app-server returns retryable overload instead of growing memory.
- Disconnected clients cannot start queued work.
- Conflicting session/config/credential mutations are serialized.
- Slow clients cannot stall the runtime.

### Phase 3: API Maturity

Tasks:

- Generate TypeScript client types from `packages/ws-server`.
- Add an `applepi-app-server-test-client`.
- Add external client examples.
- Add stable event sequence numbers.
- Add v2 API planning for thread/turn naming.
- Add opt-out notification support similar to Codex.

Exit criteria:

- External callers have documented, typed, tested client contract.
- API changes can be validated by generated schema diffs.

### Phase 4: Local Socket Transport

Tasks:

- Add Unix socket on macOS/Linux.
- Add named pipe on Windows.
- Add startup lock/stale socket cleanup.
- Add file permissions checks.
- Make token optional for OS-permission-protected local socket if security review accepts it.

Exit criteria:

- Local automation can avoid TCP ports.
- Socket lifecycle is robust across app crashes/restarts.

## Exact File Change Checklist

### Config

- `src/config/types.ts`: add `IAppServerConfig`; add optional `appServer` field.
- `src/config/defaults.ts`: add default app-server config.
- `src/config/configSchema.ts`: validate app-server config.

### Protocol

- `packages/ws-server/src/errors.ts`: add `OVERLOADED`.
- `packages/ws-server/src/methods.ts`: add `channelId` and `channelType` to `MethodContext`.
- `packages/ws-server/src/frames.ts`: add optional client capabilities if needed for event opt-out.

### Runtime Bootstrap

- `src/server/agent/ServerAgentBootstrap.ts`: support multiple channels and runtime registration.
- `src/core/channels/ChannelManager.ts`: add unregister support if missing.
- `src/core/channels/types.ts`: ensure `ChannelType` includes the app-server channel type that handlers use.

### App-Server Modules

- `src/app-server/AppServerManager.ts`: lifecycle coordinator.
- `src/app-server/AppServerChannel.ts`: channel adapter.
- `src/app-server/AppServerRequestProcessor.ts`: method frame dispatch.
- `src/app-server/AppServerConnectionRegistry.ts`: connection state.
- `src/app-server/appServerConfig.ts`: normalize/validate runtime app-server config.
- `src/app-server/transport/AppServerWebSocketTransport.ts`: listener and health endpoints.
- `src/app-server/transport/httpHealth.ts`: health response helpers.
- `src/app-server/connection/AppServerAuth.ts`: token auth provider.
- `src/app-server/connection/ConnectionRpcGate.ts`: disconnect gate.
- `src/app-server/connection/ConnectionWatchdog.ts`: heartbeat/slow unauth cleanup.
- `src/app-server/connection/rateLimiter.ts`: reusable rate limiter or wrapper.
- `src/app-server/scheduling/RequestScheduler.ts`: bounded request queue.
- `src/app-server/scheduling/requestSerialization.ts`: resource serialization.
- `src/app-server/status/AppServerStatus.ts`: status controller.

### Desktop Runtime

- `src/desktop-runtime/index.ts`: start/stop `DesktopAppServerManager`.
- `src/desktop-runtime/app-server/DesktopAppServerManager.ts`: desktop integration.
- `src/desktop-runtime/PiRuntimeBootstrap.ts`: expose register/unregister channel through inherited bootstrap.

### Handlers

- `src/server/handlers/chat.ts`: remove hardcoded `server-main`; use method context channel fields.
- `src/server/handlers/config.ts`: support desktop config backend.
- `src/server/handlers/credentials.ts`: confirm loopback/token/TLS checks for desktop mode.
- `src/server/handlers/logs.ts`: ensure subscriptions are per connection and cleaned up on disconnect.

### Services And UI

- `src/core/services/runtime-services.ts`: include app-server status.
- `src/core/services/agent-services.ts` or new service file: add `appServer.*` service handlers.
- `src/webfront/stores/runtimeStatusStore.ts`: consume app-server status. Note this store currently only listens to Tauri `runtime:*` events (`runtimeStatusStore.ts:55`); app-server status is not a `runtime:*` event today, so specify the delivery mechanism — either emit a new Tauri event for app-server status changes or have the UI poll `runtime.getStateSnapshot` / `appServer.getStatus`.
- Settings UI file to be identified during implementation: add advanced controls.

### Tests

- Add unit tests under the repo's existing test layout for app-server modules.
- Add desktop-runtime integration tests for callable mode.
- Add regression tests for headless server if modules are shared.

## Migration Notes

### Headless Server

Do not break `src/server/index.ts` in Phase 1. The headless server can continue using its current code while desktop app-server mode uses new reusable modules.

After Phase 1, migrate shared pieces from `src/server/index.ts` into `src/app-server`:

- HTTP health.
- WebSocket transport.
- Handshake.
- Rate limiting.
- Watchdog.
- Resource limits.
- Request processing.

This reduces duplication while avoiding a risky all-at-once refactor.

### Existing Desktop WebSocket Files

Leave these untouched during Phase 1 unless tests require cleanup:

- `src/desktop/channels/WebSocketChannel.ts`
- `src/desktop/channels/websocket/WebSocketServer.ts`

After app-server mode ships, mark them deprecated or remove them in a separate cleanup PR.

### Server Config Split

Keep these separate:

- Headless server config: `src/server/config/server-config.ts`.
- Desktop app-server config: `IAgentConfig.appServer`.

Do not write `.applepi-server/config.json` from desktop app-server settings.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| External clients receive UI-only events or other clients' events | AppServerChannel must filter by scope, session, and subscription. Add tests with two clients. |
| UI sees external sessions unexpectedly | Start with UI receiving global runtime events; add session ownership router in Phase 2 if needed. |
| App-server port conflict crashes desktop app | Catch startup failures and publish app-server error status only. |
| Local browser page calls app-server | Reject all `Origin` headers by default and require token. |
| Unbounded memory under many requests | Bounded RequestScheduler and overload responses. |
| Slow WebSocket client stalls event delivery | Per-connection outbound caps and slow-consumer disconnect. |
| Concurrent mutation corrupts session/config state | Request serialization by resource key. |
| Disconnect leaves queued work that later starts | ConnectionRpcGate. |
| Token leaks in logs/UI | Never log token; reveal only through explicit UI action. |
| Shared handler refactor breaks headless server | Add headless regression tests and migrate in phases. |

## Acceptance Criteria

The feature is complete when:

- Apple Pi desktop can run UI and app-server mode in the same installed app process tree.
- App-server is disabled by default.
- When enabled, the desktop sidecar listens on loopback WebSocket.
- External local process can authenticate and call `chat.send`.
- External local process can call `chat.abort`.
- External local process can query health.
- UI remains usable while external calls run.
- Browser-origin WebSocket upgrades are rejected.
- Invalid tokens are rejected.
- Port conflicts do not kill the app.
- Request queue overload returns a retryable overload error.
- Disconnect cleanup prevents queued requests from starting.
- Tests cover multi-client isolation, auth, origin rejection, overload, disconnect, and shutdown.

## Source Research References

Apple Pi:

- `README.md`
- `package.json`
- `packages/ws-server/src/frames.ts`
- `packages/ws-server/src/methods.ts`
- `packages/ws-server/src/errors.ts`
- `src/server/index.ts`
- `src/server/agent/ServerAgentBootstrap.ts`
- `src/server/channels/ServerChannel.ts`
- `src/server/connection/handshake.ts`
- `src/server/connection/rate-limiter.ts`
- `src/server/connection/watchdog.ts`
- `src/server/limits/resource-limits.ts`
- `src/server/auth/authorize.ts`
- `src/server/handlers/chat.ts`
- `src/server/handlers/config.ts`
- `src/server/handlers/credentials.ts`
- `src/server/handlers/exec.ts`
- `src/server/handlers/health.ts`
- `src/server/handlers/logs.ts`
- `src/server/handlers/sessions.ts`
- `src/server/handlers/tools.ts`
- `src/core/channels/ChannelManager.ts`
- `src/core/channels/types.ts`
- `src/core/services/runtime-services.ts`
- `src/core/services/agent-services.ts`
- `src/desktop-runtime/index.ts`
- `src/desktop-runtime/PiRuntimeBootstrap.ts`
- `src/desktop-runtime/channels/StdioRuntimeChannel.ts`
- `src/desktop-runtime/protocol/frames.ts`
- `src/desktop-runtime/protocol/stdioCarrier.ts`
- `src/desktop-runtime/protocol/controlBridge.ts`
- `src/desktop-runtime/host.ts`
- `tauri/src/runtime_supervisor.rs`
- `src/desktop/channels/WebSocketChannel.ts`
- `src/desktop/channels/websocket/WebSocketServer.ts`
- `.ai_design/server_mode/server_mode_design.md`
- `.ai_design/agent_improvements/43_apple_pi_runtime_decoupling_DONE/design.md`
- `.ai_design/message_routing_v2/design.md`

Codex:

- `/home/rich/dev/study/codex/AGENTS.md`
- `/home/rich/dev/study/codex/codex-rs/app-server/README.md`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/main.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/lib.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/transport.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/message_processor.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/connection_rpc_gate.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/request_serialization.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/src/in_process.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-transport/src/transport/mod.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-transport/src/transport/websocket.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-transport/src/transport/auth.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-transport/src/transport/unix_socket.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-client/src/lib.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-protocol/src/protocol/common.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server-daemon/README.md`
- `/home/rich/dev/study/codex/codex-rs/app-server-test-client/README.md`
- `/home/rich/dev/study/codex/codex-rs/app-server/tests/suite/v2/connection_handling_websocket.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/tests/suite/v2/initialize.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/tests/suite/v2/thread_resume.rs`
- `/home/rich/dev/study/codex/codex-rs/app-server/tests/suite/v2/turn_interrupt.rs`
