# Apple Pi App-Server Mode Implementation Tasks

Status: Ready for implementation
Date: 2026-06-02

This checklist implements the design in `design.md`.

## Phase 1: Desktop MVP

### Config

- [ ] Add `IAppServerConfig` to `src/config/types.ts`.
- [ ] Add `appServer?: IAppServerConfig` to `IAgentConfig`.
- [ ] Add default app-server config in `src/config/defaults.ts`.
- [ ] Add validation in `src/config/configSchema.ts`.
- [ ] Ensure desktop app-server does not use `src/server/config/server-config.ts`.

### Runtime Bootstrap

- [ ] Update `src/server/agent/ServerAgentBootstrap.ts` to track multiple channels.
- [ ] Preserve existing `channel` option behavior.
- [ ] Add `channels?: ChannelAdapter[]` option.
- [ ] Add `registerChannel(channel)` public method.
- [ ] Add `unregisterChannel(channelId)` public method or implement unregister in `ChannelManager`.
- [ ] Replace single-channel event dispatch with multi-channel dispatch.
- [ ] Add tests that initialize bootstrap with stdio and app-server channels.

### Protocol Context

- [ ] Add `channelId` to `MethodContext` in `packages/ws-server/src/methods.ts` (additive — keep existing `requestId`, `userId`, `sendEvent`, optional `sessionKey`).
- [ ] Add `channelType` to `MethodContext`.
- [ ] Update method dispatch to populate both fields; headless dispatch defaults to `server-main`/`server`.
- [ ] Update `src/server/handlers/chat.ts` to stop hardcoding `server-main`.
- [ ] Confirm all handlers compile with the expanded context.
- [ ] Add a `runId` to the `chat.send` response and onto the `ChannelEvent` envelope (keep `status` for headless compatibility).

### Event Routing (Phase 1)

- [ ] Record the owning channel per session at session creation.
- [ ] Replace plain `broadcastEvent` with session→channel ownership routing.
- [ ] Filter `AppServerChannel` events by authenticated connection, scope, and session subscription/ownership.
- [ ] Verify external sessions do not leak into the UI `StdioRuntimeChannel` (and vice versa) beyond global runtime status.

### App-Server Core Modules

- [ ] Add `src/app-server/AppServerManager.ts`.
- [ ] Add `src/app-server/AppServerChannel.ts`.
- [ ] Add `src/app-server/AppServerRequestProcessor.ts`.
- [ ] Add `src/app-server/AppServerConnectionRegistry.ts`.
- [ ] Add `src/app-server/appServerConfig.ts`.
- [ ] Add `src/app-server/status/AppServerStatus.ts`.

### WebSocket Transport

- [ ] Add `src/app-server/transport/AppServerWebSocketTransport.ts`.
- [ ] Add `src/app-server/transport/httpHealth.ts`.
- [ ] Implement `/readyz`.
- [ ] Implement `/healthz`.
- [ ] Keep `/health` compatibility alias.
- [ ] Enforce max connections.
- [ ] Enforce max payload bytes.
- [ ] Reject WebSocket upgrades with `Origin` header by default.
- [ ] Start only on loopback unless `allowLan` is true.
- [ ] Return actual port when configured port is `0`.

### Auth

- [ ] Add `src/app-server/connection/AppServerAuth.ts`.
- [ ] Generate capability token on first enable.
- [ ] Accept an injected token store in `AppServerAuth`; keep `src/app-server/` free of desktop control-bridge imports.
- [ ] Store token in keychain through desktop runtime control bridge when available (wired in `DesktopAppServerManager`).
- [ ] Add file fallback only if keychain is unavailable; write with `0600` perms and surface a UI warning.
- [ ] Map the capability-token connection to a narrow role/scope set by default (no implicit credential/config-write).
- [ ] Compare tokens with constant-time comparison.
- [ ] Reject pre-connect method frames.
- [ ] Never log token values.

### Desktop Runtime Integration

- [ ] Add `src/desktop-runtime/app-server/DesktopAppServerManager.ts`.
- [ ] Start manager after `PiRuntimeBootstrap.initialize()` in `src/desktop-runtime/index.ts`.
- [ ] Register `AppServerChannel` with bootstrap.
- [ ] Stop manager before bootstrap shutdown.
- [ ] Catch app-server startup errors and keep sidecar running.
- [ ] Publish app-server status changes.

### Runtime Services

- [ ] Extend `runtime.getStateSnapshot` with app-server status.
- [ ] Add `appServer.getStatus`.
- [ ] Add `appServer.setConfig`.
- [ ] Add `appServer.restart`.
- [ ] Add `appServer.stop`.
- [ ] Add `appServer.rotateToken`.

### MVP Tests

- [ ] App-server disabled by default.
- [ ] Enabled app-server starts on `127.0.0.1`.
- [ ] `/readyz` returns 200 after runtime initializes.
- [ ] `/health`, `/healthz`, and protocol `health` work.
- [ ] Origin header is rejected.
- [ ] Invalid token is rejected.
- [ ] Valid token completes connect handshake.
- [ ] Request before connect is rejected.
- [ ] UI channel still receives runtime events while app-server client is connected.
- [ ] External session events do not leak into the UI channel; two app-server clients do not see each other's session events.
- [ ] Shutdown stops the listener before sidecar exit.
- [ ] Port conflict sets app-server error status without crashing runtime.

## Phase 2: Stability Hardening

### Backpressure

- [ ] Add `OVERLOADED` to `packages/ws-server/src/errors.ts`.
- [ ] Add `src/app-server/scheduling/RequestScheduler.ts`.
- [ ] Enforce global request queue capacity.
- [ ] Enforce optional per-connection queue capacity.
- [ ] Return retryable overload response when saturated.
- [ ] Let health/readiness remain observable under load.

### Disconnect Safety

- [ ] Add `src/app-server/connection/ConnectionRpcGate.ts`.
- [ ] Gate queued request startup on active connection state.
- [ ] Prevent queued requests from starting after disconnect.
- [ ] Clean up active request tracking on connection close.

### Request Serialization

- [ ] Add `src/app-server/scheduling/requestSerialization.ts`.
- [ ] Serialize `chat.send`, `chat.abort`, and session mutations by session key.
- [ ] Serialize config writes globally.
- [ ] Serialize credential writes globally.
- [ ] Allow read-only requests to run concurrently where safe.
- [ ] Add ordering tests.

### Slow Consumer Protection

- [ ] Add per-connection outbound queue cap.
- [ ] Close clients whose `bufferedAmount` exceeds `maxBufferedBytes`.
- [ ] Emit/log `SLOW_CONSUMER` close reason without leaking secrets.
- [ ] Add integration test with blocked client reads.

### Event Filtering (refinement — basic session isolation lands in Phase 1)

- [ ] Add run-level (`runId`) ownership filtering on top of the Phase 1 session ownership map.
- [ ] Add the richer `ChannelEventRouter` abstraction.
- [ ] Add same request ID on two clients test.

### Config Restart

- [ ] Watch app-server config changes.
- [ ] Restart listener when host, port, auth, or limits change.
- [ ] Stop listener when `enabled` changes to false.
- [ ] Keep existing connections behavior explicit during restart.

## Phase 3: API Maturity

- [ ] Generate TypeScript protocol/client types from `packages/ws-server`.
- [ ] Add an app-server test client package or script.
- [ ] Add external client examples for `chat.send`, `chat.abort`, and `health`.
- [ ] Add stable event sequence numbers.
- [ ] Add event opt-out capability in connect handshake.
- [ ] Document v1 external API.
- [ ] Plan v2 API with resource/method names such as `thread/start` and `turn/start`.

## Phase 4: Local Socket Transport

- [ ] Add Unix socket transport for macOS/Linux.
- [ ] Add Windows named pipe transport.
- [ ] Add startup lock.
- [ ] Remove stale socket files only after verifying they are not in use.
- [ ] Enforce socket file permissions.
- [ ] Add socket transport tests.

## Release Checklist

- [ ] Default install has no listening app-server socket.
- [ ] Enabling app-server requires explicit user action or config.
- [ ] Endpoint is loopback by default.
- [ ] Capability token auth is required.
- [ ] Browser-origin WebSocket upgrade is rejected.
- [ ] App-server errors do not crash UI runtime.
- [ ] Request overload is bounded and retryable.
- [ ] Disconnect cleanup is tested.
- [ ] Multi-client event isolation is tested.
- [ ] Headless server regression tests pass if shared modules were changed.
