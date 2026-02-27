# Server Mode (WebSocket) Design Document

## 1. Objective
Introduce a third operational mode for Pi: **Server Mode**. This mode runs the PiAgent as a headless WebSocket/HTTP server in a Node.js environment, allowing it to accept remote connections and commands from various clients without requiring the Chrome Extension (BrowserX) or the desktop UI (Apple Pi).

Crucially, **the exact same Server Mode architecture is designed to scale seamlessly from Personal to Enterprise users.**
*   **Personal Users:** Can deploy the agent to a simple VPS or Raspberry Pi, using local configuration (`.env` whitelists) to securely access their personal assistant via mobile channels (Slack, Telegram).
*   **Enterprise Users:** Can deploy the exact same agent image into locked-down Kubernetes clusters, where the underlying architecture natively supports strict Role-Based Access Control (RBAC) and isolated ephemeral sessions via the `SubmissionContext`.

This design aims to leverage the fully decoupled message routing architecture already present in the codebase.

## 2. Architecture Overview

Currently, `PiAgent` relies on two main components for communication and I/O:
1.  **`MessageRouter`**: An interface for sending and receiving direct system-level messages (state updates, response events, tool execution callbacks).
2.  **`ChannelManager`**: A registry of `Channel` instances that route user submissions (from chat UIs, API endpoints, etc.) to the `PiAgent`, and broadcast events from the agent back to those input channels.

To implement a WebSocket server mode, we will replicate the Desktop pattern (which uses `DesktopMessageRouter`, `TauriChannel`, and `DesktopAgentBootstrap`) but adapt it for WebSockets.

### Components

#### 2.1 `ServerMessageRouter`
A new class that implements the methods expected of `MessageRouter` (e.g., `send()`, `on()`, `isConnected()`).
*   Instead of `chrome.runtime.sendMessage` or `tauri.emit`, `send()` will serialize messages into typed protocol frames (see Section 3) and send them to the connected WebSocket client(s).
*   It will listen for incoming WebSocket messages, validate them against the frame schema, and trigger handlers registered via `on()`.

#### 2.2 `ServerChannel`
A new class implementing the `Channel` interface (part of `ChannelManager`).
*   It acts as the inbound endpoint for "Submissions" (chat messages, logic triggers) and the outbound endpoint for agent "Events" (streaming text, tool execution state).
*   It wraps the WebSocket connection to format messages appropriately for the agent.

#### 2.3 `ServerAgentBootstrap`
The initialization script (similar to `DesktopAgentBootstrap`).
*   Starts a Node.js HTTP + WebSocket server (e.g., using `ws` library).
*   On a new WebSocket connection, it performs the connection handshake (see Section 4), then initializes the `ServerMessageRouter` and `ServerChannel`.
*   Instantiates the `PiAgent` and registers necessary skills/tools (via `FilesystemSkillProvider`).
*   Wires the `PiAgent`'s event dispatcher to the `ChannelManager`.
*   Starts maintenance timers (tick/heartbeat, health refresh).

## 3. Wire Protocol

All communication over the WebSocket uses a **typed, JSON-serialized frame protocol**. Every message is one of three frame types, enabling reliable request/response correlation, unsolicited server-push events, and ordered streaming.

### 3.1 Protocol Version

The protocol is versioned to allow forward-compatible evolution. The current version is `1`. Clients and server negotiate a compatible version during the handshake (see Section 4).

```typescript
const PROTOCOL_VERSION = 1;
```

### 3.2 Frame Types

```typescript
/** Client → Server: a method call */
interface RequestFrame {
  type: 'req';
  id: string;        // unique request ID (UUID), used to correlate response
  method: string;    // e.g., 'chat.send', 'chat.abort', 'sessions.list'
  params?: unknown;  // method-specific payload
}

/** Server → Client: response to a specific request */
interface ResponseFrame {
  type: 'res';
  id: string;        // must match the RequestFrame.id
  ok: boolean;       // true = success, false = error
  payload?: unknown; // method-specific result (when ok=true)
  error?: ErrorShape;// structured error (when ok=false), see Section 7
}

/** Server → Client: unsolicited push event */
interface EventFrame {
  type: 'event';
  event: string;     // event name, e.g., 'chat', 'agent', 'tick', 'health'
  payload?: unknown; // event-specific data
  seq?: number;      // monotonic sequence number for ordering (per event stream)
}

type ServerFrame = ResponseFrame | EventFrame;
type ClientFrame = RequestFrame;
```

### 3.3 Validation

All incoming frames are validated at the boundary using a schema validator (e.g., TypeBox + AJV, or Zod). Malformed frames are rejected with an `INVALID_REQUEST` error and the frame is dropped — the connection is **not** closed for a single bad frame.

### 3.4 Available Methods

The server exposes the following method namespaces. Each method is invoked via a `RequestFrame` with the corresponding `method` string:

| Namespace | Methods | Description |
|-----------|---------|-------------|
| `chat` | `chat.send`, `chat.abort`, `chat.history`, `chat.inject` | Send messages, cancel runs, retrieve history |
| `sessions` | `sessions.list`, `sessions.get`, `sessions.patch`, `sessions.reset`, `sessions.delete`, `sessions.compact` | Session lifecycle management |
| `config` | `config.get`, `config.set`, `config.patch` | Runtime configuration |
| `health` | `health` | Server health status |
| `exec` | `exec.approval.resolve` | Resolve pending execution approvals |
| `tools` | `tools.catalog` | List registered tools |
| `logs` | `logs.tail` | Stream server logs remotely |

### 3.5 Server-Pushed Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connect.challenge` | `{ nonce, ts }` | Sent immediately on WS connect, before any requests |
| `chat` | `ChatEvent` | Streaming agent response (see Section 5) |
| `agent` | `AgentEvent` | Tool invocations and lifecycle events (see Section 5) |
| `tick` | `{ ts }` | Heartbeat, sent every 30s (see Section 6) |
| `health` | `HealthStatus` | Periodic health snapshot |
| `exec.approval.requested` | `{ id, tool, args, sessionKey }` | Agent requests human approval for a tool call |
| `shutdown` | `{ reason }` | Server is shutting down gracefully |

## 4. Connection Handshake

Every WebSocket connection must complete a structured handshake before any method calls are accepted. This ensures mutual authentication, protocol compatibility, and capability discovery.

### 4.1 Handshake Sequence

```
Client                                 Server
  |                                      |
  |  ←── connect.challenge { nonce, ts } |   (1) server sends challenge immediately
  |                                      |
  |  ──→ { type:"req", method:"connect", |   (2) client responds with connect params
  |        params: ConnectParams }       |
  |                                      |
  |  ←── { type:"res", ok:true,          |   (3) server validates and responds
  |        payload: HelloOk }            |
  |                                      |
  |  ←→  normal req/res/event traffic    |   (4) connection is now live
```

### 4.2 `ConnectParams`

```typescript
interface ConnectParams {
  // Protocol negotiation
  minProtocol: number;      // minimum protocol version client supports
  maxProtocol: number;      // maximum protocol version client supports

  // Client identification
  client: {
    id: string;             // stable client identifier
    displayName: string;    // human-readable name (e.g., 'Slack Adapter', 'CLI v1.2')
    version: string;        // client software version
    platform: string;       // e.g., 'node', 'browser', 'ios'
    mode: string;           // 'operator' | 'channel' | 'node'
    instanceId?: string;    // unique per-process instance
  };

  // Capabilities
  caps?: string[];          // optional capability claims

  // Authentication (see Section 8)
  auth?: {
    token?: string;         // bearer token
    deviceToken?: string;   // previously issued device token
    password?: string;      // password auth
  };

  // Device identity (see Section 8.2)
  device?: {
    id: string;             // stable device identifier
    publicKey: string;      // Ed25519 public key (hex)
    signature: string;      // signature over challenge nonce + device metadata
    signedAt: number;       // timestamp of signature
    nonce: string;          // must match the nonce from connect.challenge
  };

  // RBAC (see Section 9)
  role?: string;            // requested role: 'operator' | 'node'
  scopes?: string[];        // requested scopes (operators only)
}
```

### 4.3 `HelloOk` Response

```typescript
interface HelloOk {
  type: 'hello-ok';
  protocol: number;         // negotiated protocol version

  server: {
    version: string;        // server software version
    connId: string;         // unique connection identifier
  };

  // Feature discovery — so clients know what's available
  features: {
    methods: string[];      // available methods (e.g., ['chat.send', 'sessions.list', ...])
    events: string[];       // events this connection will receive
  };

  // Current state snapshot — avoids separate sync round-trips
  snapshot: {
    sessions: SessionSummary[];
    health: HealthStatus;
  };

  // Auth result
  auth?: {
    deviceToken?: string;   // issued device token for future reconnects
    role: string;           // granted role
    scopes: string[];       // granted scopes
    issuedAtMs: number;
  };

  // Connection policy
  policy: {
    maxPayload: number;     // max frame size in bytes
    maxBufferedBytes: number; // slow consumer threshold
    tickIntervalMs: number; // expected tick interval
  };
}
```

### 4.4 Handshake Timeout

If the client does not send a valid `connect` request within **10 seconds** of the WebSocket upgrade, the server closes the connection with WS close code `1008` (policy violation). This prevents idle connections from consuming resources.

### 4.5 Protocol Version Negotiation

The server selects the highest protocol version within the client's `[minProtocol, maxProtocol]` range that it supports. If no compatible version exists, the server closes with code `1002` (protocol error) and an error message indicating the mismatch. This allows the protocol to evolve without breaking older clients.

## 5. Streaming Response Protocol

Agent responses are streamed to clients in real time via server-pushed `chat` and `agent` events. This section defines the streaming contract.

### 5.1 Initiation: `chat.send`

When a client sends a `chat.send` request, the server responds **immediately** with an acknowledgment:

```typescript
// Client sends:
{ type: 'req', id: 'abc', method: 'chat.send', params: { sessionKey: '...', message: '...' } }

// Server responds immediately (fire-and-forget):
{ type: 'res', id: 'abc', ok: true, payload: { runId: 'run_xyz', status: 'started' } }
```

The actual agent output is delivered asynchronously via events. This decouples the HTTP-style request/response from the streaming lifecycle.

### 5.2 `ChatEvent` — Text Streaming

```typescript
interface ChatEvent {
  runId: string;          // correlates to the chat.send ack
  sessionKey: string;
  seq: number;            // monotonically increasing per runId, for ordering
  state: 'delta' | 'final' | 'aborted' | 'error';
  message?: {
    role: 'assistant';
    content: ContentBlock[];  // accumulated text so far (for delta), or final content
  };
  errorMessage?: string;  // only when state='error'
  usage?: TokenUsage;     // only when state='final'
  stopReason?: string;    // only when state='final'
}
```

**State transitions:**
```
started → delta → delta → ... → final
started → delta → ... → aborted    (if chat.abort is called)
started → error                     (if agent crashes)
```

### 5.3 Delta Throttling

To avoid flooding the WebSocket with per-token updates, delta events are **rate-limited to at most one every 150ms** per `runId`. The server buffers accumulated text and sends it as a batch. This balances responsiveness with bandwidth efficiency.

### 5.4 `AgentEvent` — Tool Invocations

Tool calls are streamed as separate `agent` events so clients can render tool activity independently of text:

```typescript
interface AgentEvent {
  runId: string;
  seq: number;
  stream: string;         // 'tool' | 'thinking' | 'lifecycle'
  phase?: string;         // 'start' | 'result' (for tool stream)
  ts: number;             // timestamp
  data: Record<string, unknown>;  // tool name, args, result, etc.
}
```

### 5.5 Aborting a Run: `chat.abort`

A client can cancel an in-flight agent run:

```typescript
{ type: 'req', id: 'def', method: 'chat.abort', params: { runId: 'run_xyz' } }
```

The server aborts the agent run and emits a final `ChatEvent` with `state: 'aborted'`. If the `runId` is not active, the server responds with `ok: true` (idempotent).

## 6. Connection Resilience

A headless server must handle network instability gracefully. This section covers heartbeats, reconnection, slow consumers, and flood protection.

### 6.1 Tick / Heartbeat Watchdog

The server broadcasts a `tick` event to all connected clients at a fixed interval:

```typescript
// Every 30 seconds:
{ type: 'event', event: 'tick', payload: { ts: 1706000000000 } }
```

**Client-side watchdog:** Clients track the last received tick. If no tick arrives within `2 × tickIntervalMs` (60s), the client should assume the connection is dead and reconnect. This detects silent TCP failures that neither side's OS would catch promptly.

**Server-side:** The tick interval is communicated in `HelloOk.policy.tickIntervalMs`.

### 6.2 Client Reconnection Strategy

When a WebSocket closes (for any reason), the client applies **exponential backoff**:

| Attempt | Delay |
|---------|-------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 30s (cap) |

On a successful `hello-ok`, the backoff resets to 1s. On disconnect, all in-flight request promises are rejected with a `DISCONNECTED` error so callers don't hang indefinitely.

### 6.3 Slow Consumer Protection

If a client's `socket.bufferedAmount` exceeds `maxBufferedBytes` (default: 50MB), the server takes action:
*   For **droppable events** (e.g., intermediate `delta` chat events): the event is silently skipped.
*   For **non-droppable events**: the server closes the connection with code `1008` ("slow consumer"). The client is expected to reconnect and re-sync via the state snapshot in `HelloOk`.

### 6.4 Unauthorized Flood Guard

To prevent brute-force attacks, the server tracks repeated unauthorized responses per connection. If a connection triggers more than **5 consecutive unauthorized errors** without a successful request, the connection is closed with code `1008` (policy violation).

### 6.5 Channel Adapter Supervisor

When calling `ChannelAdapter.init()` for third-party integrations (Slack, Telegram), the `ChannelManager` implements a **Supervisor** pattern:
*   Monitors the adapter's connection state.
*   On disconnect, applies exponential backoff (5s → 10s → 30s) to reconnect seamlessly.
*   Logs reconnection attempts and emits a `health` event reflecting the adapter's degraded status.
*   Does not take down the main Node.js process if a single adapter fails.

## 7. Error Protocol

All errors follow a structured format with machine-readable codes, human-readable messages, and retry hints.

### 7.1 Error Shape

```typescript
interface ErrorShape {
  code: ErrorCode;
  message: string;          // human-readable description
  details?: unknown;        // optional structured context
  retryable?: boolean;      // hint: client may retry this request
  retryAfterMs?: number;    // hint: wait this long before retrying
}
```

### 7.2 Error Codes

| Code | Meaning | Retryable? |
|------|---------|------------|
| `INVALID_REQUEST` | Malformed frame, bad params, validation failure | No |
| `UNAUTHORIZED` | Authentication failed, insufficient scopes | No |
| `NOT_FOUND` | Session, run, or resource not found | No |
| `RATE_LIMITED` | Too many requests | Yes (`retryAfterMs` provided) |
| `AGENT_TIMEOUT` | Agent run exceeded time limit | No |
| `UNAVAILABLE` | Server-side error, service temporarily unavailable | Yes |
| `DISCONNECTED` | Connection lost (client-side only) | Yes |

### 7.3 WebSocket Close Codes

| Code | Meaning |
|------|---------|
| `1000` | Normal closure |
| `1002` | Protocol version mismatch (handshake failure) |
| `1008` | Policy violation: handshake timeout, auth failure, slow consumer, flood guard |
| `1012` | Service restart (server shutting down gracefully) |
| `4000` | Tick timeout (client-side: no heartbeat received) |

## 8. Authentication & Device Identity

Server Mode supports multiple authentication mechanisms, from simple tokens (personal use) to cryptographic device identity (enterprise).

### 8.1 Auth Modes

| Mode | Use Case | How It Works |
|------|----------|-------------|
| `none` | Local development, loopback-only | No auth required. Only allowed when bind is `loopback`. |
| `token` | Personal VPS, simple deployments | Shared bearer token in `ConnectParams.auth.token`. Token set via `PI_SERVER_TOKEN` env var. |
| `password` | Simple shared-secret auth | Password in `ConnectParams.auth.password`. Set via `PI_SERVER_PASSWORD` env var. |
| `trusted-proxy` | Reverse proxy (nginx, Cloudflare) | Proxy forwards identity via `X-Forwarded-User` header. Server validates proxy IP against allowlist. |

Auth mode is configured via `server.auth.mode` in `config.json` or the `PI_SERVER_AUTH_MODE` env var.

### 8.2 Device Identity & Pairing

For enterprise deployments requiring per-device trust, the server supports **Ed25519 cryptographic device identity**:

1.  **Key Generation:** Each client generates an Ed25519 key pair on first launch and persists it locally.
2.  **Challenge Signing:** During the handshake, the client signs a payload of `deviceId + clientId + clientMode + role + scopes + signedAt + nonce` using its private key. The `nonce` must match the one from `connect.challenge`.
3.  **Signature Verification:** The server verifies the signature using the client's public key. Clock skew tolerance is **±2 minutes**.
4.  **Pairing Flow:**
    *   If the device's public key is not yet known, the server emits a `device.pair.requested` event to all connected operators.
    *   An operator approves or rejects the pairing request.
    *   On approval, the server issues a `deviceToken` in the `HelloOk.auth` response. The client persists this token for faster re-authentication on subsequent connections.
    *   Loopback (local) connections are auto-approved silently.
5.  **Device Revocation:** Operators can revoke a device token, forcing re-pairing on the next connection.

### 8.3 Rate Limiting

The server enforces rate limits at multiple levels:

| Scope | Limit | Target |
|-------|-------|--------|
| Per-connection general | 60 req/min | All methods |
| Per-userId inference | 10 req/min | `chat.send` only |
| Control-plane writes | 3 req/60s | `config.patch`, `config.set` |
| Browser-origin | 30 req/min | Connections with `Origin` header |

Loopback connections are exempt from rate limits (except browser-origin). When a limit is hit, the server responds with `RATE_LIMITED` error including `retryAfterMs`.

## 9. Role-Based Access Control (RBAC)

The RBAC system gates both method invocation and event delivery based on the client's authenticated role and scopes.

### 9.1 Roles

| Role | Description | Default Scopes |
|------|-------------|----------------|
| `operator` | Full control — human users, admin UIs | All scopes |
| `channel` | Channel adapters (Slack, Telegram) — restricted to chat | `chat`, `sessions.read` |
| `node` | Remote execution nodes — limited to invocation | `node.invoke`, `node.event` |

### 9.2 Scopes

Scopes are fine-grained permissions within a role:

| Scope | Grants Access To |
|-------|-----------------|
| `chat` | `chat.send`, `chat.abort`, `chat.history`, `chat.inject` |
| `sessions.read` | `sessions.list`, `sessions.get` |
| `sessions.write` | `sessions.patch`, `sessions.reset`, `sessions.delete`, `sessions.compact` |
| `config.read` | `config.get` |
| `config.write` | `config.set`, `config.patch` |
| `operator.approvals` | `exec.approval.resolve`, receives `exec.approval.*` events |
| `operator.pairing` | Device/node pairing approval, receives `device.pair.*` events |
| `admin` | `logs.tail`, `health`, `tools.catalog` |

### 9.3 Method Authorization

Every incoming `RequestFrame` passes through `authorizeMethod(connId, method)` before dispatch. If the connection's role + scopes do not permit the method, the server responds with `UNAUTHORIZED` error. This check is performed **after** frame validation but **before** any handler logic.

### 9.4 Event Scope Guards

Server-pushed events are filtered per-connection based on scopes:
*   `exec.approval.requested` / `exec.approval.resolved` → only sent to connections with `operator.approvals` scope.
*   `device.pair.requested` / `device.pair.resolved` → only sent to connections with `operator.pairing` scope.
*   `chat` / `agent` events → sent to all connections subscribed to the relevant `sessionKey`.

## 10. Execution Approval Workflow

When the agent is running headlessly, certain tool calls (e.g., executing shell commands, writing files, making API calls) may require human approval. This is especially important in enterprise environments.

### 10.1 Flow

```
PiAgent                        Server                        Operator Client
  |                              |                              |
  |  "I need to run `rm -rf`"   |                              |
  |  ──→ approval.request        |                              |
  |                              |  ──→ exec.approval.requested |
  |                              |       { id, tool, args,      |
  |                              |         sessionKey, risk }   |
  |                              |                              |
  |                              |  ←── exec.approval.resolve   |
  |                              |       { id, decision:        |
  |                              |         'approve'|'deny' }   |
  |  ←── approval.resolved       |                              |
  |      { decision }            |                              |
  |                              |                              |
  |  (proceeds or skips tool)    |                              |
```

### 10.2 Approval Policies

Configurable via `server.exec.approvalPolicy`:

| Policy | Behavior |
|--------|----------|
| `always` | All tool calls require approval |
| `dangerous` | Only high-risk tools (shell, file write, HTTP) require approval |
| `never` | No approval required (personal/trusted environments) |
| `allowlist` | Only tools not in the allowlist require approval |

### 10.3 Timeout

If no operator resolves the approval within the configured timeout (default: **5 minutes**), the request is auto-denied and the agent is informed. The agent can then proceed with an alternative approach or report the block to the user.

## 11. Session Management

Sessions track isolated conversation state. Server Mode requires richer session lifecycle management than the desktop app because sessions may be long-lived, multiplexed, and accessed by multiple channel adapters.

### 11.1 Session Key Format

Session keys follow a hierarchical format:

```
{source}:{namespace}:{identifier}
```

Examples:
*   `ws:main:conn_abc123` — direct WebSocket client session
*   `slack:workspace_T123:channel_C456` — Slack channel session
*   `telegram:bot_789:chat_012` — Telegram chat session
*   `api:default:req_xyz` — stateless API request

### 11.2 Session Operations

| Method | Description |
|--------|-------------|
| `sessions.list` | List all sessions with summary (key, label, lastActivity, messageCount) |
| `sessions.get` | Get full session details including metadata |
| `sessions.patch` | Update session settings: `label`, `model`, `thinkingLevel` |
| `sessions.reset` | Clear conversation history, keep session metadata |
| `sessions.delete` | Permanently delete session and transcript |
| `sessions.compact` | Truncate old messages, keeping a summary — reduces memory/storage |

### 11.3 Session Persistence

The Desktop app relies on the browser's native `IndexedDB`. Server Mode will persist sessions using a **file-based approach**:

*   **Transcript storage:** Each session's conversation history is stored as a JSONL (newline-delimited JSON) file on disk, one line per message/event.
*   **Session index:** A lightweight SQLite database (via `better-sqlite3`) stores the session index (key, label, metadata, timestamps) for fast listing and querying.
*   **Data directory:** Configurable via `PI_DATA_DIR` env var, defaults to `~/.pi-server/data/`.

This ensures that if the Node.js server is rebooted or redeployed, conversation history and task state remain intact.

## 12. TLS & Network Binding

### 12.1 Bind Policy

The server supports configurable bind host policies to control network exposure:

| Policy | Binds To | Use Case |
|--------|----------|----------|
| `loopback` | `127.0.0.1` | Local development, auth mode `none` |
| `lan` | `0.0.0.0` | Home network, VPS with firewall |
| `tailnet` | Tailscale IP | Zero-config secure networking (personal) |
| `auto` | Loopback if no auth configured, LAN otherwise | Sensible default |

Configured via `server.bind` in `config.json` or `PI_SERVER_BIND` env var.

### 12.2 TLS

For production deployments without a reverse proxy, the server supports native TLS:

```json
{
  "server": {
    "tls": {
      "enabled": true,
      "certFile": "/etc/ssl/certs/pi-server.pem",
      "keyFile": "/etc/ssl/private/pi-server.key"
    }
  }
}
```

When TLS is enabled, the server listens on `wss://` and `https://` instead of `ws://` and `http://`.

### 12.3 Reverse Proxy Support

For deployments behind nginx, Caddy, or Cloudflare:
*   **Trusted proxies:** `server.trustedProxies` allowlist (IP or CIDR) — the server reads `X-Forwarded-For` and `X-Real-IP` only from trusted proxies.
*   **`trusted-proxy` auth mode:** The proxy forwards the authenticated user identity via `X-Forwarded-User` header.
*   **WebSocket upgrade:** The proxy must forward the `Upgrade: websocket` header. Example nginx config should be provided in docs.

### 12.4 CORS / Origin Validation

For browser-based clients connecting directly:
*   `server.allowedOrigins` — list of allowed `Origin` header values.
*   Requests with an `Origin` header not in the allowlist are rejected during the WebSocket upgrade handshake.

## 13. Health & Observability

### 13.1 Health Endpoint

The server exposes a `health` method (also available as `GET /health` over HTTP for load balancer probes):

```typescript
interface HealthStatus {
  status: 'ok' | 'degraded' | 'error';
  uptime: number;           // seconds
  version: string;
  connections: number;      // active WebSocket connections
  sessions: {
    active: number;
    total: number;
  };
  channels: {
    [name: string]: 'connected' | 'disconnected' | 'reconnecting';
  };
  agent: {
    activeRuns: number;
    tools: string[];        // registered tool names
  };
  memory: {
    heapUsedMB: number;
    rss: number;
  };
}
```

### 13.2 Remote Log Streaming

Operators can subscribe to server logs via `logs.tail`:

```typescript
{ type: 'req', id: '...', method: 'logs.tail', params: { level: 'info', follow: true } }
```

The server streams log lines as `event` frames. This enables remote debugging without SSH access.

### 13.3 Channel Health Monitoring

The server runs a periodic channel health check (default: every 60s) for all registered channel adapters. If an adapter reports unhealthy, the supervisor (Section 6.5) triggers reconnection and the status is reflected in the `health` response.

### 13.4 Periodic Maintenance Timers

| Timer | Interval | Purpose |
|-------|----------|---------|
| Tick broadcast | 30s | Heartbeat for client liveness detection |
| Health refresh | 60s | Refresh and broadcast health status |
| Channel health check | 60s | Verify third-party channel adapter connections |
| Stale connection cleanup | 60s | Close connections that missed handshake or went idle |

## 14. Configuration

### 14.1 Configuration Sources

Configuration is loaded from multiple sources in priority order:
1.  **Environment variables** (highest priority): `PI_SERVER_PORT`, `PI_SERVER_BIND`, `PI_SERVER_TOKEN`, `PI_SERVER_AUTH_MODE`, `PI_DATA_DIR`, etc.
2.  **Config file**: `config.json` (path configurable via `PI_CONFIG_PATH`, defaults to `~/.pi-server/config.json`).
3.  **Defaults** (lowest priority): sensible defaults for all settings.

### 14.2 Runtime Configuration Methods

Operators can read and update configuration at runtime without restarting the server:

| Method | Description |
|--------|-------------|
| `config.get` | Read current configuration (redacts secrets) |
| `config.set` | Set a single config key |
| `config.patch` | Merge a partial config object |

### 14.3 Hot-Reload

The server watches the `config.json` file for changes. When a change is detected:
*   Non-sensitive settings (rate limits, approval policy, channel config) are applied immediately.
*   Sensitive settings (auth mode, TLS, bind) require a server restart and trigger a `shutdown` event with `reason: 'config-reload-required'`.

### 14.4 Full Configuration Schema

```json
{
  "server": {
    "port": 18100,
    "bind": "auto",
    "auth": {
      "mode": "token",
      "token": "...",
      "password": "...",
      "rateLimit": {
        "windowMs": 60000,
        "maxRequests": 60
      }
    },
    "tls": {
      "enabled": false,
      "certFile": "",
      "keyFile": ""
    },
    "trustedProxies": [],
    "allowedOrigins": [],
    "exec": {
      "approvalPolicy": "dangerous",
      "approvalTimeoutMs": 300000
    },
    "channels": {}
  }
}
```

## 15. Native Channel Commands

Power users need a way to check the agent's health or configure it directly from the chat interface without invoking an expensive LLM call.

The `ChannelAdapter` interface supports an optional native command router. If a user types `/pi status` or `/pi restart` in Slack, the adapter intercepts this command, executes the local system function (e.g., querying `process.uptime()`), and returns the result *immediately* to the user, bypassing the `PiAgent` entirely.

## 16. Chrome DevTools MCP & Tool Registration

Currently, the Desktop app uses `chrome-devtools-mcp` to control Chrome. It does this by spawning the MCP server child process via Rust (Tauri) using `RustMCPBridge.ts` (since Tauri apps limit Node API execution).

In **Server Mode**, we are running natively in Node.js, which makes this even easier:
1.  **Transport Adapter:** We will create a `NodeMCPClient` (or update `MCPManager.ts`) that uses the official `@modelcontextprotocol/sdk/client/stdio.js` `StdioClientTransport`. This natively handles spawning child processes (like `npx chrome-devtools-mcp`) via Node's `child_process.spawn`.
2.  **Tool Registration:** Analogous to `registerDesktopTools.ts`, we will create a `registerServerTools.ts` script. This script will ask `MCPManager` to connect to the built-in `"browser"` server.
3.  **Headless Execution:** Since the server operates headlessly, `chrome-devtools-mcp` will need to launch Chrome (or Chromium) locally on the server host. Ensure that `npx chrome-devtools-mcp` is passed arguments suitable for the host operating system (e.g., `--chromeArg=--headless` if running on a Linux box without a GUI).
4.  **Handling Missing Chrome:** If the server host (e.g., an Ubuntu VM or a Docker container) does **not** have Chrome/Chromium installed, the `chrome-devtools-mcp` startup will fail. To handle this gracefully:
    *   **Graceful Degradation:** The Server Agent should catch the `mcp_connect` failure in `registerServerTools.ts`. It should log a clear warning ("Chrome not found, browser automation disabled") rather than crashing the server. The PiAgent will continue to operate with other cross-platform tools (terminal, web search, planning).
    *   **Direct Installation Script:** Instead of relying on heavy dependencies like Puppeteer, we should provide a simple installation script (e.g., `scripts/install-chrome.sh`). When the user provisions the server, they can run this script to download and install a known-good headless Chromium binary natively via package managers like `apt` or by grabbing the binary directly from Google's endpoints.

## 17. Channel Security & Third-Party Integrations (e.g., Slack)

In Server Mode, exposing the agent to external channels like Slack requires robust security and identity management within the `ChannelManager` architecture.

### 17.1 Channel Adapters & Webhooks
Instead of a raw WebSocket, third-party integrations will be implemented as specific `ChannelAdapter` classes (e.g., `SlackChannelAdapter`).
*   **Ingestion:** The Node.js server will expose HTTPS endpoint(s) (e.g., `/webhooks/slack`) or establish a WebSocket via Slack's Socket Mode.
*   **Adapter Role:** The `SlackChannelAdapter` receives these raw HTTP requests/events, verifies them, formats them into standard `Op` objects, and passes them to the `ChannelManager`.

### 17.2 Authentication & Verification
To ensure the channel is secure and requests are authentic:
1.  **Signature Verification:** The `SlackChannelAdapter` will intercept every incoming request and compute a cryptographic hash using the `X-Slack-Signature` header and the configured `SLACK_SIGNING_SECRET` environment variable. If the signature doesn't match, the request is immediately rejected with a 401 Unauthorized.
2.  **App Level Tokens:** If using Slack Socket Mode (WebSocket), the Node server authenticates its single outbound connection to Slack using an `xapp-` level token, inherently securing the transport layer.

### 17.3 Identity & Session Binding
Once an event is verified, the agent needs to know *who* is talking to it and track state (memory/conversations) accordingly.
The `SubmissionContext` interface in `types.ts` already natively supports this routing:

```typescript
export interface SubmissionContext {
  channelId: string;       // e.g., 'slack-workspace-id'
  channelType: ChannelType;// e.g., 'slack'
  userId?: string;         // e.g., 'U1234567' (the Slack user ID)
  sessionId?: string;      // e.g., 'channel_C1234567' (the Slack channel ID)
  replyCallback?: (event: EventMsg) => Promise<void>;
}
```

1.  **Mapping Identities:** The adapter extracts the Slack User ID and assigns it to `context.userId`. It uses the Slack Channel ID or Thread ID as the `context.sessionId`.
2.  **Session Isolation:** Because `PiAgent` and `SessionManager` key conversation history and state by `sessionId`, two different Slack threads will be treated as entirely separate isolated agent sessions.
3.  **Outbound Routing:** When the agent finishes processing and emits a response, the `ChannelManager` uses the `replyCallback` (or routes back to `SlackChannelAdapter` via `channelId`) so the adapter can use the Slack Web API to post the text back to the correct corresponding thread.

## 18. Cross-Mode WebSocket: Unified Remote Access

The WebSocket server layer designed for Server Mode can be **reused across all three operational modes**, enabling users to reach their agent via Slack, Telegram, or any remote client regardless of where the agent is running.

### 18.1 Vision

A user running BrowserX on their laptop should be able to message their agent from their phone via Slack — the same experience as Server Mode, but the agent runs inside the extension or desktop app instead of a standalone Node.js process.

### 18.2 How It Works Per Mode

| Mode | WS Server Hosting | How It Connects to the Agent |
|------|-------------------|------------------------------|
| **Server Mode** | Standalone Node.js process | Direct — agent lives in the same process |
| **Apple Pi (Desktop)** | Embedded in Tauri's Rust backend (`tokio` + `axum`) | Rust WS server bridges to the Svelte/TS agent via Tauri IPC |
| **BrowserX (Extension)** | Node.js sidecar via Native Messaging | Sidecar bridges WS ↔ `chrome.runtime` messages |

### 18.3 Apple Pi — Embedded WS Server

Tauri's Rust backend can spin up a WebSocket server alongside the app:

```
Slack/Telegram ──→ WS Server (embedded in Tauri Rust) ──→ Tauri IPC ──→ PiAgent (Svelte/TS)
```

*   The Rust backend starts an `axum` WebSocket listener on a configurable port (default: `18100`).
*   Incoming WS frames are translated to Tauri events (`tauri.emit`) and forwarded to the existing `DesktopMessageRouter`.
*   Outbound agent events are captured by the Rust bridge and serialized back to WS frames.
*   The WS server respects the same handshake, auth, and protocol defined in Sections 3–9.
*   Enabled/disabled via a toggle in the desktop app settings UI.

### 18.4 BrowserX — Channel Access via Apple Pi / Server Mode

BrowserX (the Chrome extension) does **not** host its own WS server or channel plugins. Chrome extensions cannot bind TCP ports, and requiring users to install a Native Messaging sidecar adds unacceptable friction.

Instead, BrowserX gains multi-channel support by **pairing with Apple Pi or Server Mode**:

```
Slack/Telegram ──→ Channel Plugins (Apple Pi or Server Mode)
                       │
                       ↓
                   PiAgent (Apple Pi or Server process)
                       │
                       ↓ (WS connection)
                   BrowserX extension (WS client, optional)
```

**How it works:**

*   BrowserX operates standalone as a browser-native AI assistant — no channels, no external dependencies.
*   If the user also runs Apple Pi (Desktop) or Server Mode on the same machine (or network), those runtimes host the channel plugins and WS server.
*   BrowserX can optionally connect to the Apple Pi / Server Mode WS server as a **client** to see channel activity, but this is not required — channels work independently of BrowserX.
*   The agent (PiAgent) runs in Apple Pi or Server Mode. BrowserX in this configuration acts as an additional UI window, not the agent host.

**User scenarios:**

| Setup | Channel support | How |
|-------|----------------|-----|
| BrowserX only | No channels | Standalone browser extension — direct chat only |
| BrowserX + Apple Pi | Channels via Apple Pi | Apple Pi hosts plugins + agent; BrowserX is optional UI |
| BrowserX + Server Mode | Channels via Server | Server hosts plugins + agent; BrowserX is optional UI |
| Apple Pi only | Channels via Apple Pi | Desktop app hosts plugins + agent directly |
| Server Mode only | Channels via Server | Server hosts plugins + agent directly |

### 18.5 Shared Module: `@pi/ws-server`

To avoid duplicating the WebSocket server across three codebases, the protocol and server logic should be extracted into a shared internal package:

```
packages/ws-server/
  src/
    protocol/       # Frame types, validation, error codes (Section 3, 7)
    connection/     # Handshake, auth, watchdog (Section 4, 6, 8)
    streaming/      # ChatEvent, AgentEvent, throttling (Section 5)
    auth/           # RBAC roles, scopes, authorization (Section 9)
    plugins/        # PluginLoader, PluginRegistry, ChannelPluginBridge (Section 20)
    server.ts       # createWsServer() — returns an HTTP+WS server instance
    bridge.ts       # Transport-agnostic bridge interface
```

Each mode imports and hosts it differently:

| Mode | Import | Usage |
|------|--------|-------|
| Server Mode | `import { createWsServer } from '@pi/ws-server'` | Direct — runs as the main process |
| Apple Pi | Rust calls sidecar or embeds via Tauri plugin | Bridges WS ↔ Tauri IPC |

BrowserX does not import `@pi/ws-server` — it connects as a WS client to Apple Pi or Server Mode (see Section 18.4).

### 18.6 Transport Bridge Interface

Both hosting modes implement the same bridge interface to connect the WS server to the underlying agent transport:

```typescript
interface TransportBridge {
  /** Send a message from WS client to the agent */
  toAgent(frame: ClientFrame): Promise<void>;

  /** Register handler for messages from agent to WS clients */
  onAgentEvent(handler: (frame: ServerFrame) => void): void;

  /** Check if the agent transport is connected */
  isConnected(): boolean;
}
```

Implementations:
*   `DirectBridge` — Server Mode: passes frames directly to `ServerMessageRouter` (no serialization overhead).
*   `TauriBridge` — Apple Pi: translates frames to/from `tauri.emit`/`tauri.listen`.

### 18.7 Implementation Phases

| Phase | Scope | Prerequisite |
|-------|-------|-------------|
| **Phase 1** | Build Server Mode standalone (Sections 1–17, 20) | None |
| **Phase 2** | Extract `@pi/ws-server` shared package from Server Mode code | Phase 1 complete |
| **Phase 3** | Embed WS server + channel plugins in Apple Pi via Tauri sidecar | Phase 2 complete |
| **Phase 4** | BrowserX WS client pairing with Apple Pi / Server Mode | Phase 3 complete |

### 18.8 Constraints & Limitations

*   **BrowserX has no standalone channel support.** BrowserX is a browser extension — it cannot host channel plugins or a WS server on its own. Multi-channel requires pairing with Apple Pi or Server Mode.
*   **Desktop app must be running:** Unlike Server Mode (always-on), the WS server and channel plugins in Apple Pi only work when the desktop app is open. Users who need always-on channels should use Server Mode.
*   **Port conflicts:** If the user runs both Apple Pi and Server Mode, they must use different ports. The default port should be configurable per mode.
*   **BrowserX pairing is optional.** BrowserX works perfectly as a standalone browser assistant. Pairing with Apple Pi / Server Mode is only needed to view channel activity from the browser.

## 19. Implementation Steps

### Phase 1: Server Mode (Standalone)

1.  **Create Server Mode Entry Point**
    *   Create a new directory `src/server`.
    *   Add `src/server/index.ts` to launch a basic Node.js HTTP + WebSocket server.
2.  **Define Wire Protocol**
    *   Create `src/server/protocol/frames.ts` — frame types, validation schemas.
    *   Create `src/server/protocol/errors.ts` — error codes and shapes.
    *   Create `src/server/protocol/methods.ts` — method registry and handler dispatch.
3.  **Implement Connection Handshake**
    *   Create `src/server/connection/handshake.ts` — challenge/connect/hello-ok flow.
    *   Create `src/server/connection/auth.ts` — auth mode resolution (token, password, device, trusted-proxy).
    *   Create `src/server/connection/watchdog.ts` — handshake timeout, tick broadcast, slow consumer detection.
4.  **Implement Routing Components**
    *   Create `src/server/channels/ServerMessageRouter.ts`.
    *   Create `src/server/channels/ServerChannel.ts`.
5.  **Implement Streaming**
    *   Create `src/server/streaming/chat-run-state.ts` — per-session run queue, delta buffering, throttle.
    *   Create `src/server/streaming/agent-events.ts` — tool invocation event broadcasting.
6.  **Implement RBAC**
    *   Create `src/server/auth/roles.ts` — role definitions, scope mappings.
    *   Create `src/server/auth/authorize.ts` — method-level authorization, event scope guards.
7.  **Implement Session Management**
    *   Create `src/server/sessions/session-store.ts` — JSONL transcript persistence, SQLite index.
    *   Create `src/server/sessions/session-methods.ts` — list, get, patch, reset, delete, compact handlers.
8.  **Implement Execution Approvals**
    *   Create `src/server/exec/approval-manager.ts` — approval request/resolve flow, timeout.
9.  **Implement Agent Bootstrap**
    *   Create `src/server/agent/ServerAgentBootstrap.ts` — lifecycle management, tool registration, maintenance timers.
10. **Implement Health & Observability**
    *   Create `src/server/health/health-monitor.ts` — health endpoint, channel monitoring.
    *   Create `src/server/health/log-streamer.ts` — `logs.tail` handler.
11. **Configuration & Build Process**
    *   Add a new Vite configuration `vite.config.server.mts` (or use `tsup`/`tsx` for a Node build).
    *   Update `package.json` with scripts like `"dev:server": "tsx src/server/index.ts"` and `"build:server": "vite build --config vite.config.server.mts"`.
12. **Environment Setup**
    *   Ensure `.env` loading logic is verified for the Node process.
    *   Provide `PromptComposer` with the appropriate server context (OS, architecture, shell).
    *   Create default `config.json` template with documented options.

### Phase 2: Extract Shared Package

13. **Create `packages/ws-server/`**
    *   Extract protocol, connection, streaming, auth, and RBAC code from `src/server/` into the shared package.
    *   Expose `createWsServer()` factory and `TransportBridge` interface.
    *   Refactor `src/server/index.ts` to import from `@pi/ws-server` with a `DirectBridge`.
    *   Verify Server Mode still works identically after extraction.

### Phase 3: Embed in Apple Pi (Desktop)

14. **Implement `TauriBridge`**
    *   Create `src-tauri/src/ws_server.rs` — Rust module that starts an `axum` WebSocket listener.
    *   Translate incoming WS frames to Tauri events and forward to the existing `DesktopMessageRouter`.
    *   Capture outbound agent events and serialize back to WS frames.
15. **Desktop UI Integration**
    *   Add a "Remote Access" toggle in the Apple Pi settings panel.
    *   Display the WS server URL and connection status when enabled.
    *   Show connected remote clients (Slack, Telegram, etc.) in the sidebar.

### Phase 4: BrowserX Pairing with Apple Pi / Server Mode

16. **WS Client in BrowserX**
    *   Create `src/background/ws-client.ts` — lightweight WebSocket client that connects to an Apple Pi or Server Mode WS server.
    *   Implement discovery: check `localhost:<configured-port>` for a running Pi WS server, or allow the user to enter a custom server URL.
    *   Handle connection lifecycle: auto-reconnect on disconnect, back off on repeated failures.
17. **BrowserX Pairing UI**
    *   Add a "Connect to Pi Server" option in the BrowserX settings/popup page.
    *   Show pairing status (disconnected / connecting / connected) and server info.
    *   Display channel activity from the paired server (e.g., "[via Slack] message from Alice").
    *   If no Apple Pi / Server Mode detected, show a message explaining that channels require Apple Pi or Server Mode.
18. **Channel Activity Relay**
    *   The paired server relays channel events to BrowserX via the WS connection (same `EventFrame` protocol).
    *   BrowserX displays incoming channel messages in its chat UI, tagged with source channel.
    *   BrowserX can send replies back through the server's channel plugins via WS `RequestFrame`.

## 20. Channel Plugin System (OpenClaw-Compatible)

Pi adopts the [OpenClaw](https://github.com/nicepkg/openclaw) `ChannelPlugin` interface as its channel integration standard. Any OpenClaw channel plugin package (Slack, Telegram, WhatsApp, Discord, Signal, Matrix, IRC, etc.) can be installed and run on Pi without modification. Channel plugins are hosted by **Server Mode** and **Apple Pi (Desktop)** — BrowserX gains channel access by pairing with one of these runtimes (see Section 18.4).

### 20.0 Cross-Mode Plugin Hosting

Channel plugins run in **Server Mode** and **Apple Pi** only. BrowserX does not host plugins — it accesses channels by pairing with one of these runtimes (see Section 18.4).

| Mode | Where plugins run | How plugins talk to the agent |
|------|-------------------|-------------------------------|
| **Server Mode** | In-process (same Node.js process as PiAgent) | Direct — bridge calls `ChannelManager` directly |
| **Desktop (Apple Pi)** | In a Node.js sidecar spawned by Tauri | Sidecar ↔ Tauri IPC ↔ `DesktopMessageRouter` |
| **BrowserX** | Does not host plugins | Pairs with Apple Pi or Server Mode as WS client |

```
Server Mode:
  Channel Plugin (in-process)
    → ChannelPluginBridge
    → ChannelManager (direct)
    → PiAgent (same process)

Desktop Mode (Apple Pi):
  Channel Plugin (Node.js sidecar)
    → ChannelPluginBridge
    → Tauri IPC bridge (TauriBridge)
    → DesktopMessageRouter
    → PiAgent (Svelte/TS in Tauri webview)

BrowserX (paired):
  BrowserX extension
    → WS client connection
    → Apple Pi or Server Mode (hosts plugins + agent)
```

In Desktop mode, channel plugins run in the **same sidecar process** that hosts the WebSocket server (Section 18). This is a natural fit — the sidecar already bridges external traffic to the agent, so it can also host channel plugins that generate that traffic.

#### Sidecar Plugin Loader (Desktop)

For Desktop mode, the sidecar process runs the same `PluginLoader` (Section 20.4) at startup. The `TransportBridge` implementation determines how the `ChannelPluginBridge` communicates with the agent:

*   **Server Mode:** `DirectBridge` — no serialization, direct function calls.
*   **Desktop:** `TauriBridge` — serializes inbound messages to Tauri IPC events, deserializes agent responses.

The `ChannelPluginBridge` is transport-agnostic — it doesn't know or care which bridge it's using. This is the same `TransportBridge` interface from Section 18.6, reused for plugin traffic.

#### Desktop Mode UI Integration

When channel plugins are active in Desktop mode, the Apple Pi UI should:
*   Show a "Channels" section in the sidebar listing connected channels (Slack, Telegram, etc.) with status indicators.
*   Allow enabling/disabling channels from the settings panel.
*   Display the channel plugin config UI (credentials, account selection) in the settings.
*   Show incoming channel messages in the main chat view, tagged with their source (e.g., "[via Slack]").

#### Constraints

*   **BrowserX cannot host channel plugins.** It must pair with Apple Pi or Server Mode for channel access. Standalone BrowserX is browser-only (direct chat).
*   **Desktop app must be running.** Unlike Server Mode (always-on), the channel plugins in Apple Pi only work when the desktop app is open.
*   **Always-on channels need Server Mode.** If a user wants Slack messages forwarded while their laptop is closed, they should use Server Mode.

### 20.1 Compatibility Scope

| Layer | Compatible? | Notes |
|-------|-------------|-------|
| **Channel plugins** (`ChannelPlugin` interface) | Yes — full drop-in | Same npm packages, no wrapper |
| **Plugin SDK** (`OpenClawPluginApi`) | Yes — implemented by Pi | Pi provides its own implementation of the registration API |
| **Agent runtime** | No | Pi uses its own `PiAgent`, not OpenClaw's agent |
| **Skills / Memory / Providers** | No | Pi has its own skill, memory, and model provider systems |

Plugin authors write to OpenClaw's `ChannelPlugin` interface. Their plugin runs on OpenClaw, Pi, or any other platform that implements the same contract.

### 20.2 ChannelPlugin Interface

Pi adopts the full `ChannelPlugin` type from OpenClaw. The interface is a composition of optional **adapters**, each handling one concern:

```typescript
type ChannelPlugin<ResolvedAccount = any> = {
  id: ChannelId;
  meta: ChannelMeta;                        // label, icon, description
  capabilities: ChannelCapabilities;        // what the channel supports

  // --- Required adapters ---
  config: ChannelConfigAdapter<ResolvedAccount>;   // account management
  gateway?: ChannelGatewayAdapter<ResolvedAccount>; // lifecycle (start/stop)
  outbound?: ChannelOutboundAdapter;               // message delivery

  // --- Optional adapters ---
  messaging?: ChannelMessagingAdapter;       // target normalization
  security?: ChannelSecurityAdapter<ResolvedAccount>; // DM policy, warnings
  threading?: ChannelThreadingAdapter;       // reply mode, thread context
  directory?: ChannelDirectoryAdapter;       // list users/channels/groups
  groups?: ChannelGroupAdapter;              // group mention rules
  mentions?: ChannelMentionAdapter;          // @mention handling
  actions?: ChannelMessageActionAdapter;     // reactions, message actions
  heartbeat?: ChannelHeartbeatAdapter;       // connection health checks
  streaming?: ChannelStreamingAdapter;       // streaming response support
  commands?: ChannelCommandAdapter;          // native slash commands
  auth?: ChannelAuthAdapter;                 // channel-specific auth flows
  status?: ChannelStatusAdapter;             // probe, audit, diagnostics
  onboarding?: ChannelOnboardingAdapter;     // setup wizard steps
  agentPrompt?: ChannelAgentPromptAdapter;   // inject channel context into LLM prompt
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[]; // channel-specific tools
};
```

**Required vs optional for Pi:**

| Adapter | Required? | Why |
|---------|-----------|-----|
| `config` | Yes | Pi needs to enumerate and resolve accounts |
| `gateway` | Yes (for active channels) | Pi needs to start/stop the channel connection |
| `outbound` | Yes (for active channels) | Pi needs to send responses back to the channel |
| `security` | Strongly recommended | Enforces owner identity verification (see Section 20.7) |
| `messaging` | Recommended | Target normalization for outbound delivery |
| All others | Optional | Pi uses them if present, degrades gracefully if absent |

### 20.3 Plugin Registration

OpenClaw plugins export a standard entry point:

```typescript
// What an OpenClaw plugin looks like (e.g., extensions/slack/index.ts)
const plugin: OpenClawPluginDefinition = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  register(api: OpenClawPluginApi) {
    api.registerChannel({ plugin: slackPlugin });
  },
};
export default plugin;
```

Pi implements the `OpenClawPluginApi` interface so that the plugin's `register()` call works without modification:

```typescript
interface OpenClawPluginApi {
  id: string;
  name: string;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: PluginLogger;

  // Channel registration — primary use case for Pi
  registerChannel: (registration: { plugin: ChannelPlugin }) => void;

  // Tool registration — mapped to Pi's tool registry
  registerTool: (tool: AgentTool) => void;

  // Hook registration — mapped to Pi's event system
  registerHook: (events: string | string[], handler: HookHandler) => void;

  // Gateway method registration — mapped to Pi's WS method dispatch
  registerGatewayMethod: (method: string, handler: GatewayRequestHandler) => void;

  // Other registrations — stubbed for compatibility, not primary use case
  registerService: (service: PluginService) => void;
  registerProvider: (provider: ProviderPlugin) => void;
  registerCommand: (command: CommandDefinition) => void;
}
```

### 20.4 Plugin Loader

The plugin loader discovers, loads, and registers plugins at server startup.

#### Discovery

Plugins are discovered from two sources:

1.  **Built-in extensions:** `extensions/` directory in the project root. Each subdirectory with an `index.ts` or `index.js` is a plugin candidate.
2.  **Installed packages:** `node_modules/` packages that declare `"openclaw-plugin": true` in their `package.json` or are listed in `server.channels.plugins[]` in the config.

#### Loading Sequence

```
Server startup
  │
  ├── 1. Scan extensions/ and node_modules/ for plugin candidates
  ├── 2. For each candidate:
  │     ├── a. Dynamic import() the entry point
  │     ├── b. Validate it exports an OpenClawPluginDefinition
  │     ├── c. Create a PiPluginApi instance (our OpenClawPluginApi implementation)
  │     └── d. Call plugin.register(api)
  │           └── Plugin calls api.registerChannel({ plugin })
  │               └── ChannelPlugin stored in PluginRegistry
  ├── 3. For each registered channel plugin:
  │     ├── a. Read config for this channel from server.channels.<pluginId>
  │     ├── b. Enumerate accounts via plugin.config.listAccountIds(cfg)
  │     ├── c. For each enabled & configured account:
  │     │     └── Create a ChannelPluginBridge instance
  │     └── d. Register bridge with ChannelManager
  └── 4. ChannelManager starts all registered channels (see Section 20.6)
```

#### Error Handling

*   If a plugin fails to load (syntax error, missing dependency), log a warning and skip it. Do not crash the server.
*   If a plugin's `register()` throws, catch the error, log it, and skip.
*   The server reports which plugins loaded successfully and which failed in the `HelloOk` snapshot and `health` endpoint.

### 20.5 ChannelPluginBridge

The bridge is the core translation layer between an OpenClaw `ChannelPlugin` and Pi's internal systems (`ChannelManager`, `SubmissionContext`, `PiAgent`).

One bridge instance is created **per plugin per account** (e.g., Slack workspace "acme" gets its own bridge, Slack workspace "personal" gets another).

#### Inbound Flow (Channel → Agent)

```
Channel backend (e.g., Slack)
  → Plugin's gateway listener (runs inside startAccount())
  → Plugin calls ctx.runtime.routeInboundMessage({ channel, sender, text, ... })
  → ChannelPluginBridge receives the inbound message
  → Bridge builds a SubmissionContext:
      {
        channelId: "slack:acme",
        channelType: "slack",
        userId: "U1234567",
        sessionId: "slack:acme:channel_C456",
        replyCallback: (event) => bridge.deliverOutbound(event)
      }
  → Bridge checks owner identity (see Section 20.7)
  → If authorized: submit to PiAgent via ChannelManager
  → If not authorized: drop message or send canned rejection
```

#### Outbound Flow (Agent → Channel)

```
PiAgent produces a response
  → ChannelManager invokes replyCallback on the SubmissionContext
  → ChannelPluginBridge receives the outbound event
  → Bridge translates to ChannelOutboundContext:
      {
        cfg: openClawCompatConfig,
        to: "C456",
        text: "Here's what I found...",
        threadId: "1234.56",
        accountId: "acme"
      }
  → Bridge calls plugin.outbound.sendText(outboundCtx)
  → Plugin calls channel API (e.g., Slack chat.postMessage)
  → Returns OutboundDeliveryResult { messageId, channel, chatId }
```

#### ChannelGatewayContext

The bridge provides OpenClaw's `ChannelGatewayContext` when calling `startAccount()` / `stopAccount()`:

```typescript
interface ChannelGatewayContext<ResolvedAccount> {
  cfg: OpenClawConfig;             // Pi config translated to OpenClaw format
  accountId: string;               // e.g., "acme"
  account: ResolvedAccount;        // resolved via plugin.config.resolveAccount()
  runtime: RuntimeEnv;             // Pi's runtime exposed as OpenClaw's RuntimeEnv
  abortSignal: AbortSignal;        // for graceful shutdown
  log: ChannelLogSink;             // mapped to Pi's logging
  getStatus: () => ChannelAccountSnapshot;
  setStatus: (next: ChannelAccountSnapshot) => void;
}
```

#### Config Translation

OpenClaw plugins expect an `OpenClawConfig` object. Pi maintains its own config format. The bridge translates between them:

*   Pi config path: `server.channels.slack.accounts.acme.botToken`
*   OpenClaw config path: `channels.slack.accounts.acme.botToken`

The translation is a lightweight mapping — Pi's channel config structure mirrors OpenClaw's to minimize impedance mismatch. Plugin-specific config keys are passed through as-is.

### 20.6 Lifecycle Management

The `ChannelManager` (from Section 2) manages plugin lifecycles via the bridge:

#### Startup

```
ChannelManager.startChannels()
  → For each registered ChannelPluginBridge:
    → Check plugin.config.isEnabled(account, cfg)
    → Check plugin.config.isConfigured(account, cfg)
    → If both true: call plugin.gateway.startAccount(gatewayCtx)
    → Update ChannelAccountSnapshot: { running: true, connected: true }
```

#### Shutdown

```
ChannelManager.stopChannel(channelId, accountId)
  → Signal AbortController (abortSignal triggers)
  → Call plugin.gateway.stopAccount(gatewayCtx)
  → Update ChannelAccountSnapshot: { running: false, connected: false }
```

#### Auto-Restart

If a channel's gateway listener crashes or disconnects:

| Attempt | Backoff Delay | Action |
|---------|---------------|--------|
| 1 | 1s | Restart immediately |
| 2 | 2s | |
| 3 | 5s | |
| 4 | 10s | |
| 5 | 30s | |
| 6–10 | 60s | |
| 10+ | Stop retrying | Log error, mark channel as failed |

Max 10 restart attempts. Counter resets after 30 minutes of stable connection.

#### Health Tracking

Each bridge maintains a `ChannelAccountSnapshot`:

```typescript
interface ChannelAccountSnapshot {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  lastDisconnect: { at: number; error?: string } | null;
  lastMessageAt: number | null;
  lastError: string | null;
}
```

This data is exposed via the `health` endpoint (Section 13) under `channels`:

```json
{
  "channels": {
    "slack:acme": { "connected": true, "lastMessageAt": 1706000000000 },
    "telegram:personal": { "connected": false, "reconnectAttempts": 3, "lastError": "ETIMEDOUT" }
  }
}
```

### 20.7 Owner Identity Verification

Since Pi is a **1:1 user:agent** system (one user, one agent), every inbound message from a channel plugin must be verified against the agent owner's identity. This extends the identity model discussed in earlier sections.

#### Owner Identity Map

The owner configures their identities across platforms:

```json
{
  "owner": {
    "displayName": "Alice",
    "identities": {
      "slack": ["U1234567"],
      "telegram": ["12345678"],
      "whatsapp": ["+1555123456"],
      "discord": ["alice#1234"],
      "signal": ["+1555123456"],
      "gmail": ["alice@company.com"]
    }
  }
}
```

#### Verification Flow

When the bridge receives an inbound message:

1.  Extract the sender's platform identity from the message (e.g., Slack `user_id`).
2.  Look up `owner.identities[channelType]`.
3.  If the sender matches → allow, route to PiAgent.
4.  If no match → check the plugin's `security.resolveDmPolicy()`:
    *   `"reject"` → drop the message silently.
    *   `"pairing"` → hold the message, emit a pairing request to the operator (similar to device pairing in Section 8.2). The operator approves or denies from a connected client. On approval, the sender's identity is added to `owner.identities`.
    *   `"warn"` → allow the message but flag it to the agent as coming from an unverified sender.

#### Trust Chain (Layered)

| Layer | What it verifies | How |
|-------|-----------------|-----|
| **Platform** | Sender is who they claim to be | Slack signature, WhatsApp phone verification, Telegram bot API, etc. |
| **Plugin** | Message is authentic and unmodified | Plugin verifies platform-specific signatures (e.g., `X-Slack-Signature`) |
| **Bridge** | Sender is the agent owner | Owner identity map lookup |

Impersonation is prevented because the sender identity comes from the **platform**, not from the user's message. A user cannot forge their Slack `user_id` because the plugin verifies Slack's cryptographic signature before the message reaches the bridge.

### 20.8 Centralized Gateway Integration

When deployed with a centralized gateway (for organizations where multiple users each have their own agent):

```
                         ┌──────────────────────┐
Slack  ──────────────────┤                      ├──wss──→  Alice's Pi Agent
WhatsApp ────────────────┤   Centralized        ├──wss──→  John's Pi Agent
Telegram ────────────────┤   Gateway            ├──wss──→  Bob's Pi Agent
Discord  ────────────────┤                      │
                         └──────────────────────┘
```

In this topology:

*   The **gateway** loads the channel plugins (Slack, WhatsApp, etc.) and manages their lifecycle.
*   The **gateway** verifies platform-level identity (Slack signatures, etc.) via the plugin's built-in verification.
*   The **gateway** maintains a routing table mapping platform identities → agent endpoints.
*   Each **Pi agent** connects to the gateway as a WebSocket client.
*   The gateway forwards messages to the correct agent based on the sender's verified platform identity.

The channel plugins run on the gateway, not on each individual agent. This avoids each user needing their own Slack bot token — the organization runs one Slack app, and the gateway routes messages to the correct agent.

### 20.9 Multi-Account Support

Each channel plugin supports multiple accounts. For example, a user might have two Slack workspaces:

```json
{
  "server": {
    "channels": {
      "slack": {
        "accounts": {
          "work": {
            "botToken": "xoxb-work-...",
            "appToken": "xapp-work-...",
            "enabled": true
          },
          "personal": {
            "botToken": "xoxb-personal-...",
            "appToken": "xapp-personal-...",
            "enabled": true
          }
        }
      }
    }
  }
}
```

The plugin's `config.listAccountIds(cfg)` returns `["work", "personal"]`. A separate `ChannelPluginBridge` is created for each, with independent lifecycle, health tracking, and session isolation.

Session keys incorporate the account: `slack:work:channel_C456` vs `slack:personal:channel_C789`.

### 20.10 Implementation Steps

These steps integrate into the phased implementation from Section 19:

#### Phase 1 Additions (Server Mode Standalone)

19. **Define Plugin Compatibility Layer**
    *   Create `src/server/plugins/types.ts` — re-export or reference OpenClaw's `ChannelPlugin`, `OpenClawPluginApi`, and related types.
    *   Create `src/server/plugins/pi-plugin-api.ts` — Pi's implementation of `OpenClawPluginApi`.
    *   Create `src/server/plugins/plugin-loader.ts` — discovery and loading logic.
    *   Create `src/server/plugins/plugin-registry.ts` — stores registered channel plugins.

20. **Implement ChannelPluginBridge**
    *   Create `src/server/plugins/channel-bridge.ts` — inbound/outbound translation, config mapping, lifecycle delegation.
    *   Create `src/server/plugins/owner-verify.ts` — owner identity verification at the bridge layer.

21. **Integrate with ChannelManager**
    *   Update `ServerAgentBootstrap` to run the plugin loader during startup.
    *   Wire registered bridges into `ChannelManager` for lifecycle management.
    *   Expose plugin/channel health in the `health` endpoint.

22. **Configuration Schema Update**
    *   Extend the config schema (Section 14.4) with `server.channels.<pluginId>.accounts` structure.
    *   Add `owner.identities` to the config schema.
    *   Support hot-reload for channel config changes (add/remove accounts without restart).
