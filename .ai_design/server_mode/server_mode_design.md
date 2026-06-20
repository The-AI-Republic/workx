# Server Mode (WebSocket) Design Document

> Desktop decoupling note (2026-05-17): Track 43 supersedes this document's Apple Pi desktop bridge material in Sections 18.3, 18.6, and 20.0. Do not implement desktop runtime decoupling from the `DesktopMessageRouter`, `TauriBridge`, `DirectBridge`, or `TransportBridge` text below. The implementation-ready desktop plan is `.ai_design/agent_improvements/43_apple_pi_runtime_decoupling_DONE/design.md`: server build mode plus `desktop-runtime` profile, Rust-relayed stdio, path-compatible desktop providers, and runtime-owned auth/config services. This server-mode document remains useful for the websocket protocol and server deployment context only.

## 1. Objective
Introduce a third operational mode for Pi: **Server Mode**. This mode runs the RepublicAgent as a headless WebSocket/HTTP server in a Node.js environment, allowing it to accept remote connections and commands from various clients without requiring the Chrome Extension (BrowserX) or the desktop UI (Apple Pi).

Crucially, **the exact same Server Mode architecture is designed to scale seamlessly from Personal to Enterprise users.**
*   **Personal Users:** Can deploy the agent to a simple VPS or Raspberry Pi, using local configuration (`.env` whitelists) to securely access their personal assistant via mobile channels (Slack, Telegram).
*   **Enterprise Users:** Can deploy the exact same agent image into locked-down Kubernetes clusters, where the underlying architecture natively supports strict Role-Based Access Control (RBAC) and isolated ephemeral sessions via the `SubmissionContext`.

This design aims to leverage the fully decoupled message routing architecture already present in the codebase.

## 2. Architecture Overview

Currently, `RepublicAgent` relies on two main components for communication and I/O:
1.  **`MessageRouter`**: An interface for sending and receiving direct system-level messages (state updates, response events, tool execution callbacks).
2.  **`ChannelManager`**: A registry of `Channel` instances that route user submissions (from chat UIs, API endpoints, etc.) to the `RepublicAgent`, and broadcast events from the agent back to those input channels.

To implement a WebSocket server mode, we will replicate the Desktop pattern (which uses `DesktopMessageRouter`, `TauriChannel`, and `DesktopAgentBootstrap`) but adapt it for WebSockets.

### Components

#### 2.1 `ServerMessageRouter`
A new class that implements the methods of the `MessageRouter` interface.
*   **Architectural Change:** The existing `MessageRouter` will be refactored into an **interface** at `src/core/MessageRouter.ts`. The current Chrome extension implementation will become `ChromeMessageRouter`, and the server implementation will be `ServerMessageRouter`.
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
*   Instantiates the `RepublicAgent` and registers necessary skills/tools (via `FilesystemSkillProvider`).
*   Wires the `RepublicAgent`'s event dispatcher to the `ChannelManager`.
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
| `token` | Personal VPS, simple deployments | Shared bearer token in `ConnectParams.auth.token`. Token set via `APPLEPI_SERVER_TOKEN` env var. |
| `password` | Simple shared-secret auth | Password in `ConnectParams.auth.password`. Set via `APPLEPI_SERVER_PASSWORD` env var. |
| `trusted-proxy` | Reverse proxy (nginx, Cloudflare) | Proxy forwards identity via `X-Forwarded-User` header. Server validates proxy IP against allowlist. |

Auth mode is configured via `server.auth.mode` in `config.json` or the `APPLEPI_SERVER_AUTH_MODE` env var.

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
RepublicAgent                        Server                        Operator Client
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

### 11.2 Unified Agent Memory (1:1 Model)

Since Pi follows a **1:1 user:agent relationship**, even though multiple channels create separate sessions and transcripts (Section 11.1), they all interact with a **single, unified Agent Instance**.

*   **Brain Consistency:** If Alice teaches her agent a fact via Slack, the agent must "remember" it when accessed via WhatsApp.
*   **Implementation:** The `RepublicAgent` instance is shared across all `ServerChannel` connections. While each session maintains its own `SubmissionContext` for transcript isolation, the underlying memory providers (Long-Term Memory, Learned Facts) are bound to the single owner.
*   **State Locking:** A simple mutex ensures that only one channel can trigger an active agent "run" at a time per user, preventing race conditions in memory updates.

### 11.3 Session Operations

| Method | Description |
|--------|-------------|
| `sessions.list` | List all sessions with summary (key, label, lastActivity, messageCount) |
| `sessions.get` | Get full session details including metadata |
| `sessions.patch` | Update session settings: `label`, `model`, `thinkingLevel` |
| `sessions.reset` | Clear conversation history, keep session metadata |
| `sessions.delete` | Permanently delete session and transcript |
| `sessions.compact` | Truncate old messages, keeping a summary — reduces memory/storage |

### 11.4 Session Persistence

The Desktop app relies on the browser's native `IndexedDB`. Server Mode uses a **two-tier file-based approach** — SQLite for fast lookups, JSONL for append-only conversation history.

#### Storage Layout

```
$APPLEPI_DATA_DIR/sessions/
  index.db                              # SQLite — session index
  transcripts/
    ws_main_conn_abc123.jsonl           # JSONL — one file per session
    slack_work_channel_C456.jsonl
    telegram_personal_chat_012.jsonl
```

#### SQLite Index (`index.db`)

The SQLite database stores **session metadata only** — small, structured data that needs fast querying:

| Column | Type | Example |
|--------|------|---------|
| `key` | TEXT (PK) | `slack:work:channel_C456` |
| `label` | TEXT | `#general` |
| `source` | TEXT | `slack` |
| `accountId` | TEXT | `work` |
| `createdAt` | INTEGER | `1706000000000` |
| `lastActivity` | INTEGER | `1706003600000` |
| `messageCount` | INTEGER | `42` |
| `model` | TEXT | `anthropic:claude-sonnet-4-20250514` |
| `thinkingLevel` | TEXT | `medium` |
| `status` | TEXT | `active` / `archived` |

**When SQLite is read:**
*   `sessions.list` — query all rows, sorted by `lastActivity` DESC. No need to touch JSONL files.
*   `sessions.get` — query one row for metadata. Transcript loaded separately from JSONL if requested.
*   `sessions.patch` — update `label`, `model`, `thinkingLevel` columns.
*   `sessions.delete` — delete row + delete corresponding `.jsonl` file.
*   Session reaper (Section 26.4) — query `lastActivity < retentionThreshold`, bulk archive.

**When SQLite is written:**
*   New session created (first message from a new channel thread or `chat.send` with new session key) — insert row.
*   Each inbound/outbound message — update `lastActivity` and `messageCount` (batched, not per-message).
*   `sessions.patch` — update metadata columns.

#### JSONL Transcripts (`transcripts/*.jsonl`)

Each session has one JSONL file storing the **full conversation history** — every message, event, tool call, and agent response as one JSON object per line:

```jsonl
{"type":"meta","sessionKey":"slack:work:channel_C456","createdAt":1706000000000,"source":"slack"}
{"type":"message","role":"user","content":"What's on my calendar today?","ts":1706000060000,"via":"slack"}
{"type":"message","role":"assistant","content":"Let me check...","ts":1706000061000,"runId":"run_abc"}
{"type":"tool","name":"google_calendar","phase":"start","ts":1706000062000,"runId":"run_abc"}
{"type":"tool","name":"google_calendar","phase":"result","data":{"events":[...]},"ts":1706000065000}
{"type":"message","role":"assistant","content":"You have 3 meetings today...","ts":1706000066000,"runId":"run_abc","final":true}
```

**When JSONL is written:**
*   Every inbound message, outbound response, tool invocation, and system event — appended as a new line (append-only, no rewrites).
*   Writes are **buffered** in memory and flushed periodically (every 1s or when buffer exceeds 64KB) to reduce disk I/O.

**When JSONL is read:**
*   `chat.history` — read and parse the JSONL file to return conversation history.
*   `sessions.get` with `includeTranscript: true` — read the JSONL file.
*   `sessions.compact` — read the JSONL file, summarize old messages, write a new compacted file, replace the original.
*   Agent context loading — on new `chat.send`, read recent messages from JSONL to build the LLM context window.
*   Recovery — if SQLite index is corrupted, rebuild from JSONL first lines (Section 25.3).

#### Why Two Storage Layers?

| Concern | SQLite | JSONL |
|---------|--------|-------|
| **Session listing & search** | Fast — indexed queries, no file scanning | Slow — would need to open every file |
| **Conversation history** | Wrong fit — relational schema is awkward for variable-length event streams | Natural — append-only log, preserves exact event order |
| **Write pattern** | Random writes (update counters) | Append-only (never rewrite) |
| **Recovery** | Can be rebuilt from JSONL | Source of truth for conversation data |
| **Size** | Small (~1KB per session) | Large (grows with conversation, up to 6MB limit per session) |

SQLite is the **fast index**, JSONL is the **source of truth**. If SQLite is lost, it can be rebuilt. If a JSONL file is lost, that session's conversation history is gone.

**Data directory:** Configurable via `APPLEPI_DATA_DIR` env var, defaults to `~/.applepi-server/data/`.

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

Configured via `server.bind` in `config.json` or `APPLEPI_SERVER_BIND` env var.

### 12.2 TLS

For production deployments without a reverse proxy, the server supports native TLS:

```json
{
  "server": {
    "tls": {
      "enabled": true,
      "certFile": "/etc/ssl/certs/applepi-server.pem",
      "keyFile": "/etc/ssl/private/applepi-server.key"
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
1.  **Environment variables** (highest priority): `APPLEPI_SERVER_PORT`, `APPLEPI_SERVER_BIND`, `APPLEPI_SERVER_TOKEN`, `APPLEPI_SERVER_AUTH_MODE`, `APPLEPI_DATA_DIR`, etc.
2.  **Config file**: `config.json` (path configurable via `APPLEPI_CONFIG_PATH`, defaults to `~/.applepi-server/config.json`).
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

The `ChannelAdapter` interface supports an optional native command router. If a user types `/pi status` or `/pi restart` in Slack, the adapter intercepts this command, executes the local system function (e.g., querying `process.uptime()`), and returns the result *immediately* to the user, bypassing the `RepublicAgent` entirely.

## 16. Chrome DevTools MCP & Tool Registration

Currently, the Desktop app uses `chrome-devtools-mcp` to control Chrome. It does this by spawning the MCP server child process via Rust (Tauri) using `RustMCPBridge.ts` (since Tauri apps limit Node API execution).

In **Server Mode**, we are running natively in Node.js, which makes this even easier:
1.  **Transport Adapter:** We will create a `NodeMCPClient` (or update `MCPManager.ts`) that uses the official `@modelcontextprotocol/sdk/client/stdio.js` `StdioClientTransport`. This natively handles spawning child processes (like `npx chrome-devtools-mcp`) via Node's `child_process.spawn`.
2.  **Tool Registration:** Analogous to `registerDesktopTools.ts`, we will create a `registerServerTools.ts` script. This script will ask `MCPManager` to connect to the built-in `"browser"` server.
3.  **Headless Execution:** Since the server operates headlessly, `chrome-devtools-mcp` will need to launch Chrome (or Chromium) locally on the server host. Ensure that `npx chrome-devtools-mcp` is passed arguments suitable for the host operating system (e.g., `--chromeArg=--headless` if running on a Linux box without a GUI).
4.  **Handling Missing Chrome:** If the server host (e.g., an Ubuntu VM or a Docker container) does **not** have Chrome/Chromium installed, the `chrome-devtools-mcp` startup will fail. To handle this gracefully:
    *   **Graceful Degradation:** The Server Agent should catch the `mcp_connect` failure in `registerServerTools.ts`. It should log a clear warning ("Chrome not found, browser automation disabled") rather than crashing the server. The RepublicAgent will continue to operate with other cross-platform tools (terminal, web search, planning).
    *   **Direct Installation Script:** Instead of relying on heavy dependencies like Puppeteer, we should provide a simple installation script (e.g., `scripts/install-chrome.sh`). When the user provisions the server, they can run this script to download and install a known-good headless Chromium binary natively via package managers like `apt` or by grabbing the binary directly from Google's endpoints.

## 17. Channel Security & Third-Party Integrations

> **Note:** This section describes the security principles for channel integrations. The implementation mechanism is the **OpenClaw-compatible plugin system** (Section 20), not hardcoded adapter classes. Each channel plugin handles its own platform-specific authentication (Slack signatures, Telegram bot API tokens, etc.) via its built-in adapters.

### 17.1 Channel Integration via Plugins

Third-party channel integrations (Slack, Telegram, WhatsApp, Discord, etc.) are implemented as **OpenClaw channel plugins** (Section 20). Each plugin handles:

*   **Ingestion:** The plugin's `gateway` adapter establishes the connection to the platform (e.g., Slack Socket Mode WebSocket, Telegram long-polling, webhook endpoints).
*   **Verification:** The plugin's built-in security verifies platform-specific signatures (e.g., `X-Slack-Signature`, Telegram bot token). This is handled inside the plugin — Pi does not need to implement platform-specific verification.
*   **Translation:** The `ConnectorBridge` (Section 20.5) translates between the plugin's message format and Pi's `SubmissionContext`.

### 17.2 Security Layers

Channel security is enforced at three layers:

| Layer | Responsibility | Handled by |
|-------|---------------|------------|
| **Platform verification** | Sender is authentic (cryptographic signatures) | Channel plugin (built-in) |
| **Owner identity** | Sender is the agent owner | `ConnectorBridge` (Section 20.7) |
| **RBAC** | Channel connection has appropriate scopes | WS server auth (Section 9) |

### 17.3 Identity & Session Binding

The `SubmissionContext` interface routes messages from channels to the correct agent session:

```typescript
export interface SubmissionContext {
  channelId: string;       // e.g., 'slack:acme'
  channelType: ChannelType;// e.g., 'slack'
  userId?: string;         // e.g., 'U1234567' (platform user ID)
  sessionId?: string;      // e.g., 'slack:acme:channel_C456'
  replyCallback?: (event: EventMsg) => Promise<void>;
}
```

1.  **Mapping Identities:** The bridge extracts the platform user ID and assigns it to `context.userId`. It uses the channel/thread ID as `context.sessionId` (Section 11.1 format).
2.  **Session Isolation:** Each channel conversation (Slack thread, Telegram chat, etc.) maps to an independent session with isolated conversation history.
3.  **Outbound Routing:** Agent responses flow back through the bridge to the plugin's `outbound` adapter, which delivers them to the correct platform thread.

## 18. Cross-Mode WebSocket: Unified Remote Access

The WebSocket server layer designed for Server Mode can be **reused across all three operational modes**, enabling users to reach their agent via Slack, Telegram, or any remote client regardless of where the agent is running.

### 18.1 Vision

A user running BrowserX on their laptop should be able to message their agent from their phone via Slack — the same experience as Server Mode, but the agent runs inside the extension or desktop app instead of a standalone Node.js process.

### 18.2 How It Works Per Mode

| Mode | WS Server Hosting | How It Connects to the Agent |
|------|-------------------|------------------------------|
| **Server Mode** | Standalone Node.js process | Direct — agent lives in the same process |
| **Apple Pi (Desktop)** | Embedded in Tauri's Rust backend (`tokio` + `axum`) | Rust WS server bridges to the Svelte/TS agent via Tauri IPC |
| **BrowserX (Extension)** | None — pairs with Apple Pi or Server Mode | Connects as a WS client (see Section 18.4) |

### 18.3 Apple Pi — Embedded WS Server

Tauri's Rust backend can spin up a WebSocket server alongside the app:

```
Slack/Telegram ──→ WS Server (embedded in Tauri Rust) ──→ Tauri IPC ──→ RepublicAgent (Svelte/TS)
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
                   RepublicAgent (Apple Pi or Server process)
                       │
                       ↓ (WS connection)
                   BrowserX extension (WS client, optional)
```

**How it works:**

*   BrowserX operates standalone as a browser-native AI assistant — no channels, no external dependencies.
*   If the user also runs Apple Pi (Desktop) or Server Mode on the same machine (or network), those runtimes host the channel plugins and WS server.
*   BrowserX can optionally connect to the Apple Pi / Server Mode WS server as a **client** to see channel activity, but this is not required — channels work independently of BrowserX.
*   The agent (RepublicAgent) runs in Apple Pi or Server Mode. BrowserX in this configuration acts as an additional UI window, not the agent host.

**User scenarios:**

| Setup | Channel support | How |
|-------|----------------|-----|
| BrowserX only | No channels | Standalone browser extension — direct chat only |
| BrowserX + Apple Pi | Channels via Apple Pi | Apple Pi hosts plugins + agent; BrowserX is optional UI |
| BrowserX + Server Mode | Channels via Server | Server hosts plugins + agent; BrowserX is optional UI |
| Apple Pi only | Channels via Apple Pi | Desktop app hosts plugins + agent directly |
| Server Mode only | Channels via Server | Server hosts plugins + agent directly |

### 18.5 Shared Module: `@applepi/ws-server`

To avoid duplicating the WebSocket server across three codebases, the protocol and server logic should be extracted into a shared internal package:

```
packages/ws-server/
  src/
    protocol/            # Frame types, validation, error codes (Section 3, 7)
    connection/          # Handshake, auth, watchdog (Section 4, 6, 8)
    streaming/           # ChatEvent, AgentEvent, throttling (Section 5)
    auth/                # RBAC roles, scopes, authorization (Section 9)
    channel-connectors/  # ConnectorLoader, ConnectorRegistry, ConnectorBridge (Section 20)
    server.ts            # createWsServer() — returns an HTTP+WS server instance
    bridge.ts            # Transport-agnostic bridge interface
```

Each mode imports and hosts it differently:

| Mode | Import | Usage |
|------|--------|-------|
| Server Mode | `import { createWsServer } from '@applepi/ws-server'` | Direct — runs as the main process |
| Apple Pi | Rust calls sidecar or embeds via Tauri plugin | Bridges WS ↔ Tauri IPC |

BrowserX does not import `@applepi/ws-server` — it connects as a WS client to Apple Pi or Server Mode (see Section 18.4).

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
| **Phase 2** | Extract `@applepi/ws-server` shared package from Server Mode code | Phase 1 complete |
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
    *   Refactor `src/server/index.ts` to import from `@applepi/ws-server` with a `DirectBridge`.
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
    *   Add a "Connect to Apple Pi Server" option in the BrowserX settings/popup page.
    *   Show pairing status (disconnected / connecting / connected) and server info.
    *   Display channel activity from the paired server (e.g., "[via Slack] message from Alice").
    *   If no Apple Pi / Server Mode detected, show a message explaining that channels require Apple Pi or Server Mode.
18. **Channel Activity Relay**
    *   The paired server relays channel events to BrowserX via the WS connection (same `EventFrame` protocol).
    *   BrowserX displays incoming channel messages in its chat UI, tagged with source channel.
    *   BrowserX can send replies back through the server's channel plugins via WS `RequestFrame`.

## 20. Channel Plugin System (OpenClaw-Compatible)

> **Naming note.** Throughout Section 20, `ChannelConnector`, `OpenClawConnectorApi`, `OpenClawConnectorDefinition`, etc. are **BrowserX's local names** (under `src/server/channel-connectors/`) for the shape-compatible upstream OpenClaw interfaces, which are still published as `ChannelPlugin`, `OpenClawPluginApi`, `OpenClawPluginDefinition` in the `openclaw` package. A plugin author writes against OpenClaw's upstream names; BrowserX accepts those packages unmodified by declaring the same shape under local names.
>
> The `"openclaw-plugin": true` discovery flag in `package.json` remains the upstream contract and is not renamed.

Pi adopts the [OpenClaw](https://github.com/nicepkg/openclaw) `ChannelPlugin` interface as its channel integration standard (mirrored locally as `ChannelConnector`). Any OpenClaw channel plugin package (Slack, Telegram, WhatsApp, Discord, Signal, Matrix, IRC, etc.) can be installed and run on Pi without modification. Channel plugins are hosted by **Server Mode** and **Apple Pi (Desktop)** — BrowserX gains channel access by pairing with one of these runtimes (see Section 18.4).

### 20.0 Cross-Mode Plugin Hosting

Channel plugins run in **Server Mode** and **Apple Pi** only. BrowserX does not host plugins — it accesses channels by pairing with one of these runtimes (see Section 18.4).

| Mode | Where plugins run | How plugins talk to the agent |
|------|-------------------|-------------------------------|
| **Server Mode** | **Worker Threads** (Isolated) | SharedArrayBuffer ↔ MessagePort ↔ `ChannelManager` |
| **Desktop (Apple Pi)** | In a Node.js sidecar spawned by Tauri | Sidecar ↔ Tauri IPC ↔ `DesktopMessageRouter` |
| **BrowserX** | Does not host plugins | Pairs with Apple Pi or Server Mode as WS client |

#### 20.0.1 Plugin Isolation (Server Mode)
To ensure that a third-party channel plugin cannot crash the main RepublicAgent process or leak memory into the global scope:
*   **Worker Threads:** Each plugin instance runs in its own `worker_threads` context.
*   **Communication:** The `ConnectorBridge` manages an asynchronous message port to the worker.
*   **Resource Limits:** Worker threads are started with limited heap memory (e.g., `--max-old-space-size=128`).

```
Server Mode:
  Channel Plugin (in-process)
    → ConnectorBridge
    → ChannelManager (direct)
    → RepublicAgent (same process)

Desktop Mode (Apple Pi):
  Channel Plugin (Node.js sidecar)
    → ConnectorBridge
    → Tauri IPC bridge (TauriBridge)
    → DesktopMessageRouter
    → RepublicAgent (Svelte/TS in Tauri webview)

BrowserX (paired):
  BrowserX extension
    → WS client connection
    → Apple Pi or Server Mode (hosts plugins + agent)
```

In Desktop mode, channel plugins run in the **same sidecar process** that hosts the WebSocket server (Section 18). This is a natural fit — the sidecar already bridges external traffic to the agent, so it can also host channel plugins that generate that traffic.

#### Sidecar Plugin Loader (Desktop)

For Desktop mode, the sidecar process runs the same `ConnectorLoader` (Section 20.4) at startup. The `TransportBridge` implementation determines how the `ConnectorBridge` communicates with the agent:

*   **Server Mode:** `DirectBridge` — no serialization, direct function calls.
*   **Desktop:** `TauriBridge` — serializes inbound messages to Tauri IPC events, deserializes agent responses.

The `ConnectorBridge` is transport-agnostic — it doesn't know or care which bridge it's using. This is the same `TransportBridge` interface from Section 18.6, reused for plugin traffic.

#### Desktop Mode UI Integration

The Apple Pi desktop app currently uses a **full-width chat layout with no sidebar**. Channel messages integrate into the existing session-based model without major UI restructuring.

##### Current Layout Reference

```
┌─────────────────────────────────────┐
│ Status Line                         │
├─────────────────────────────────────┤
│                                     │
│  Messages (scrollable)              │
│  - "You:" (right-aligned)           │
│  - "BrowserX: [model]" (left)       │
│  - Tool/reasoning/system events     │
│                                     │
├─────────────────────────────────────┤
│ [ChatHistory] [NewConvo] [Input...] │
│ Footer: login | approval | skills   │
└─────────────────────────────────────┘
```

##### Channel Sessions in Chat History (Option A)

Each channel conversation is a **separate session** — the same session key format from Section 11.1 (e.g., `slack:work:channel_C456`, `telegram:personal:chat_012`). These sessions appear in the **Chat History popup** alongside regular direct-chat sessions, grouped by source:

```
┌─ Chat History ──────────────────────┐
│                                     │
│  Direct Chat                        │
│  ├─ "Research task" ............. 2m│
│  ├─ "Debug login bug" ......... 1h │
│  └─ "Weekly planning" ......... 3h │
│                                     │
│  Slack (work)                   [●] │
│  ├─ #general .................. 5m │
│  └─ DM with @bob ............. 20m│
│                                     │
│  Telegram (personal)            [●] │
│  └─ Chat ...................... 1h │
│                                     │
│  WhatsApp                       [○] │
│  └─ +1555... .................. 2d │
│                                     │
└─────────────────────────────────────┘

[●] = connected    [○] = disconnected
```

**Behavior:**
*   Channel sessions are created automatically when the first message arrives from that channel.
*   Session labels are derived from the channel context (Slack channel name, Telegram chat title, etc.) via the plugin's `directory` adapter if available, otherwise from the raw identifiers.
*   Clicking a channel session switches the main chat view to show that conversation.
*   When viewing a channel session, messages are labeled with the channel source:
    *   `"You (via Slack):"` — user's message that came through Slack
    *   `"BrowserX: [model]"` — agent response (same as direct chat)
*   The user can **reply from the desktop UI** while viewing a channel session. The reply is routed back through the channel plugin's outbound adapter to the original platform (e.g., posted to the Slack thread).
*   Channel sessions follow the same lifecycle as regular sessions — they can be reset, deleted, or compacted via the existing session operations.

##### Incoming Message Notifications (Option B)

When a message arrives from a channel and the user is **not currently viewing that channel session**, a toast notification appears:

```
┌─────────────────────────────────────┐
│ Status Line                         │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ 💬 Slack (#general)             │ │
│ │ "Hey, can you check the deploy?"│ │
│ │                     [View] [×]  │ │
│ └─────────────────────────────────┘ │
│                                     │
│  (current direct chat session       │
│   continues undisturbed below)      │
│                                     │
├─────────────────────────────────────┤
│ [ChatHistory 🔴2] [NewConvo] [...] │
└─────────────────────────────────────┘
```

**Notification behavior:**
*   Toast slides in at the top of the messages area (below status line), auto-dismisses after **8 seconds**.
*   Clicking **[View]** switches to that channel session.
*   Clicking **[×]** dismisses the toast without switching.
*   If multiple channel messages arrive in quick succession, toasts stack (max 3 visible, oldest dismissed first).
*   The **Chat History button** shows a badge count of unread channel messages (e.g., `🔴2`).
*   When the agent is actively processing a response for the current session, notifications are **non-intrusive** — they appear but do not interrupt the streaming output.

##### Channel Status in Status Line

The existing status line at the top of the chat view gains channel connection indicators:

```
┌─────────────────────────────────────────────────────┐
│ ● Connected  |  Slack ● Telegram ● WhatsApp ○      │
└─────────────────────────────────────────────────────┘
```

*   Each enabled channel shows a dot: `●` green = connected, `○` gray = disconnected, `◐` yellow = reconnecting.
*   Clicking a channel indicator opens that channel's most recent session.
*   If no channels are enabled, the channel indicators are hidden (status line looks the same as today).

##### Channel Settings

Channel management lives in the **Settings page** (`/settings`):

*   **Channels section** — lists all discovered plugins with enable/disable toggles.
*   **Per-channel config** — clicking a channel expands to show:
    *   Account management (add/remove accounts, e.g., multiple Slack workspaces).
    *   Credentials input (bot token, app token, etc.) — stored in the config, never displayed after entry.
    *   Connection status and last error.
    *   "Test Connection" button to verify credentials before enabling.
*   **Owner Identity** — a section to configure `owner.identities` (Section 20.7): link platform accounts (Slack user ID, Telegram ID, etc.) to verify that incoming messages are from the agent owner.

#### Constraints

*   **BrowserX cannot host channel plugins.** It must pair with Apple Pi or Server Mode for channel access. Standalone BrowserX is browser-only (direct chat).
*   **Desktop app must be running.** Unlike Server Mode (always-on), the channel plugins in Apple Pi only work when the desktop app is open.
*   **Always-on channels need Server Mode.** If a user wants Slack messages forwarded while their laptop is closed, they should use Server Mode.

### 20.1 Compatibility Scope

| Layer | Compatible? | Notes |
|-------|-------------|-------|
| **Channel plugins** (`ChannelConnector` interface) | Yes — full drop-in | Same npm packages, no wrapper |
| **Plugin SDK** (`OpenClawConnectorApi`) | Yes — implemented by Pi | Pi provides its own implementation of the registration API |
| **Agent runtime** | No | Pi uses its own `RepublicAgent`, not OpenClaw's agent |
| **Skills / Memory / Providers** | No | Pi has its own skill, memory, and model provider systems |

Plugin authors write to OpenClaw's `ChannelConnector` interface. Their plugin runs on OpenClaw, Pi, or any other platform that implements the same contract.

### 20.2 ChannelConnector Interface

Pi adopts the full `ChannelConnector` type from OpenClaw. The interface is a composition of optional **adapters**, each handling one concern:

```typescript
type ChannelConnector<ResolvedAccount = any> = {
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
const plugin: OpenClawConnectorDefinition = {
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  register(api: OpenClawConnectorApi) {
    api.registerChannel({ plugin: slackPlugin });
  },
};
export default plugin;
```

Pi implements the `OpenClawConnectorApi` interface so that the plugin's `register()` call works without modification:

```typescript
interface OpenClawConnectorApi {
  id: string;
  name: string;
  config: OpenClawConfig;
  runtime: PluginRuntime;
  logger: PluginLogger;

  // Channel registration — primary use case for Pi
  registerChannel: (registration: { plugin: ChannelConnector }) => void;

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
  │     ├── b. Validate it exports an OpenClawConnectorDefinition
  │     ├── c. Create an ApplePiConnectorApi instance (our OpenClawConnectorApi implementation)
  │     └── d. Call plugin.register(api)
  │           └── Plugin calls api.registerChannel({ plugin })
  │               └── ChannelConnector stored in ConnectorRegistry
  ├── 3. For each registered channel plugin:
  │     ├── a. Read config for this channel from server.channels.<pluginId>
  │     ├── b. Enumerate accounts via plugin.config.listAccountIds(cfg)
  │     ├── c. For each enabled & configured account:
  │     │     └── Create a ConnectorBridge instance
  │     └── d. Register bridge with ChannelManager
  └── 4. ChannelManager starts all registered channels (see Section 20.6)
```

#### Error Handling

*   If a plugin fails to load (syntax error, missing dependency), log a warning and skip it. Do not crash the server.
*   If a plugin's `register()` throws, catch the error, log it, and skip.
*   The server reports which plugins loaded successfully and which failed in the `HelloOk` snapshot and `health` endpoint.

### 20.5 ConnectorBridge

The bridge is the core translation layer between an OpenClaw `ChannelConnector` and Pi's internal systems (`ChannelManager`, `SubmissionContext`, `RepublicAgent`).

One bridge instance is created **per plugin per account** (e.g., Slack workspace "acme" gets its own bridge, Slack workspace "personal" gets another).

#### Inbound Flow (Channel → Agent)

```
Channel backend (e.g., Slack)
  → Plugin's gateway listener (runs inside startAccount())
  → Plugin calls ctx.runtime.routeInboundMessage({ channel, sender, text, ... })
  → ConnectorBridge receives the inbound message
  → Bridge builds a SubmissionContext:
      {
        channelId: "slack:acme",
        channelType: "slack",
        userId: "U1234567",
        sessionId: "slack:acme:channel_C456",
        replyCallback: (event) => bridge.deliverOutbound(event)
      }
  → Bridge checks owner identity (see Section 20.7)
  → If authorized: submit to RepublicAgent via ChannelManager
  → If not authorized: drop message or send canned rejection
```

#### Outbound Flow (Agent → Channel)

```
RepublicAgent produces a response
  → ChannelManager invokes replyCallback on the SubmissionContext
  → ConnectorBridge receives the outbound event
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
  → For each registered ConnectorBridge:
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

#### 1:1 Security & Static Whitelisting
For 1:1 deployments (e.g., personal PC or VPS), security is strictly enforced via **Static Whitelisting**:
1. **Instant Rejection**: Any message from an identity NOT in the `owner.identities` map is dropped immediately.
2. **No Pairing for Strangers**: To prevent John from spamming Alice with pairing requests, the "pairing" policy (Section 20.7) is disabled by default in 1:1 mode.
3. **Environment Injection**: For production hardening, identities can be injected via `PI_OWNER_SLACK_ID`, etc., bypassing the need for a plaintext `config.json` entry.

#### CLI Identity Management
Alice can manage her identities directly on the server host via a CLI tool:
`node applepi-server.js identity add slack U456789`
This provides a secure bootstrapping path if she loses access to a channel.

#### Verification Flow

When the bridge receives an inbound message:

1.  Extract the sender's platform identity from the message (e.g., Slack `user_id`).
2.  Look up `owner.identities[channelType]`.
3.  If the sender matches → allow, route to RepublicAgent.
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

The plugin's `config.listAccountIds(cfg)` returns `["work", "personal"]`. A separate `ConnectorBridge` is created for each, with independent lifecycle, health tracking, and session isolation.

Session keys incorporate the account: `slack:work:channel_C456` vs `slack:personal:channel_C789`.

### 20.10 Implementation Steps

These steps integrate into the phased implementation from Section 19:

#### Phase 1 Additions (Server Mode Standalone)

19. **Define Plugin Compatibility Layer**
    *   Create `src/server/channel-connectors/types.ts` — re-export or reference OpenClaw's `ChannelConnector`, `OpenClawConnectorApi`, and related types.
    *   Create `src/server/channel-connectors/applepi-connector-api.ts` — Pi's implementation of `OpenClawConnectorApi`.
    *   Create `src/server/channel-connectors/connector-loader.ts` — discovery and loading logic.
    *   Create `src/server/channel-connectors/connector-registry.ts` — stores registered channel plugins.

20. **Implement ConnectorBridge**
    *   Create `src/server/channel-connectors/connector-bridge.ts` — inbound/outbound translation, config mapping, lifecycle delegation.
    *   Create `src/server/channel-connectors/owner-verify.ts` — owner identity verification at the bridge layer.

21. **Integrate with ChannelManager**
    *   Update `ServerAgentBootstrap` to run the plugin loader during startup.
    *   Wire registered bridges into `ChannelManager` for lifecycle management.
    *   Expose plugin/channel health in the `health` endpoint.

22. **Configuration Schema Update**
    *   Extend the config schema (Section 14.4) with `server.channels.<pluginId>.accounts` structure.
    *   Add `owner.identities` to the config schema.
    *   Support hot-reload for channel config changes (add/remove accounts without restart).

## 21. Graceful Shutdown

When the server process receives a termination signal, it must shut down cleanly to avoid data loss, dropped messages, and broken channel connections.

### 21.1 Trigger Signals

| Signal | Source | Behavior |
|--------|--------|----------|
| `SIGTERM` | Docker stop, Kubernetes pod termination, systemd | Graceful shutdown |
| `SIGINT` | Ctrl+C in terminal | Graceful shutdown |
| `config-reload-required` | Hot-reload detects sensitive config change (Section 14.3) | Graceful shutdown + restart expected |

### 21.2 Shutdown Sequence

```
Signal received (SIGTERM / SIGINT)
  │
  ├── 1. Stop accepting new connections
  │     └── HTTP server stops listening, WS upgrade rejected
  │
  ├── 2. Broadcast shutdown event to all connected clients
  │     └── { type: "event", event: "shutdown", payload: { reason: "signal", gracePeriodMs: 10000 } }
  │
  ├── 3. Stop channel plugins (parallel, with timeout)
  │     ├── For each active ConnectorBridge:
  │     │   ├── Signal AbortController (triggers abortSignal in gateway context)
  │     │   ├── Call plugin.gateway.stopAccount(gatewayCtx)
  │     │   └── Wait up to 5s per plugin, then force-kill
  │     └── Update all ChannelAccountSnapshots: { running: false }
  │
  ├── 4. Drain active agent runs
  │     ├── Wait for in-flight RepublicAgent runs to complete (up to gracePeriodMs)
  │     ├── If runs don't finish in time: abort them, emit ChatEvent { state: "aborted" }
  │     └── Flush any buffered delta events to clients
  │
  ├── 5. Flush pending writes
  │     ├── Flush JSONL transcript buffers to disk
  │     ├── Flush SQLite WAL (write-ahead log) to database
  │     └── Flush OpenTelemetry span/metric buffers (Section 24)
  │
  ├── 6. Close all WebSocket connections
  │     └── Send WS close code 1012 (service restart) to each client
  │
  └── 7. Exit process
        └── process.exit(0)
```

### 21.3 Grace Period

The default grace period is **10 seconds** — configurable via `server.shutdownGracePeriodMs` or `PI_SHUTDOWN_GRACE_MS` env var. This is the maximum time the server waits for agent runs to complete and plugins to stop before forcing exit.

Docker's default `stop_timeout` is 10s. If the grace period exceeds Docker's timeout, Docker sends `SIGKILL`. The Dockerfile should set `STOPSIGNAL SIGTERM` and the `docker-compose.yml` should set `stop_grace_period` to match.

### 21.4 Second Signal

If the process receives a second `SIGTERM` or `SIGINT` during the graceful shutdown, it performs an **immediate forced exit** — skip remaining steps, close connections, `process.exit(1)`.

## 22. Deployment & Packaging

Server Mode runs as a Docker container by default. The container hosts the RepublicAgent, WS server, and channel plugins in a single process, with access to the host filesystem for tool execution.

### 22.1 Docker Image

```dockerfile
FROM node:22-slim

# Install Chromium and OS dependencies for headless operation
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY dist/server/ ./
COPY node_modules/ ./node_modules/
COPY extensions/ ./extensions/

# Plugin directory for user-installed plugins
RUN mkdir -p /app/extensions

# Data directory for sessions, config, logs
VOLUME /data

ENV APPLEPI_DATA_DIR=/data
ENV APPLEPI_CONFIG_PATH=/data/config.json
ENV NODE_ENV=production
ENV CHROME_BIN=/usr/bin/chromium

EXPOSE 18100

STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "index.js"]
```

### 22.2 Docker Compose

```yaml
version: "3.8"

services:
  applepi-server:
    image: pi-agent/server:latest
    build: .
    ports:
      - "18100:18100"
    volumes:
      # Persist sessions, config, and logs
      - pi-data:/data
      # Host filesystem access for agent tools (file read/write, terminal)
      - ${HOME}:/host/home:rw
      - /tmp:/host/tmp:rw
    environment:
      - APPLEPI_SERVER_AUTH_MODE=token
      - APPLEPI_SERVER_TOKEN=${APPLEPI_SERVER_TOKEN}
      - APPLEPI_SERVER_BIND=lan
      - PI_HOST_MOUNT=/host/home
    stop_grace_period: 15s
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:18100/health"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  pi-data:
```

### 22.3 Host Filesystem Access

The agent needs to read/write files and run terminal commands on the host — this is a core capability, not a security issue (the owner controls their own agent).

*   **Mount strategy:** The user's home directory is bind-mounted into the container at `/host/home`. The agent's filesystem tools are configured with `PI_HOST_MOUNT` to translate paths.
*   **Path translation:** When the agent reads `/host/home/projects/app/src/main.ts`, the tool layer translates this to the host path `~/projects/app/src/main.ts` in responses and displays.
*   **Terminal execution:** Shell commands run inside the container but operate on the mounted host filesystem. The agent has the same effective access as the user who started the container.
*   **Security boundary:** The container does NOT run as root. The entrypoint runs as a non-root user matching the host UID (via `--user $(id -u):$(id -g)` or the compose `user:` directive).

### 22.4 Quick Start

```bash
# 1. Create data directory
mkdir -p ~/.applepi-server

# 2. Generate auth token
export APPLEPI_SERVER_TOKEN=$(openssl rand -hex 32)

# 3. Run
docker compose up -d

# 4. Check health
curl http://localhost:18100/health
```

### 22.5 Production Considerations

*   **Reverse proxy:** For public-facing deployments, run behind nginx/Caddy with TLS termination (Section 12.3). The container only needs to expose port 18100 internally.
*   **Resource constraints:** Set `deploy.resources.limits` in compose to cap CPU/memory for the container.
*   **Log collection:** Container stdout is structured JSON (Section 24). Use Docker's log driver to ship to your observability stack.
*   **Updates:** Pull new image, `docker compose up -d`. Sessions persist in the named volume.

## 23. Plugin Installation UX

Users need a way to discover, install, and configure channel plugins. The experience differs between Desktop (Apple Pi) and Server Mode.

### 23.1 Desktop (Apple Pi) — Plugin Manager UI

Apple Pi includes a **Plugin Manager** page (`/plugins`) accessible from the settings or footer navigation:

```
┌─ Plugin Manager ────────────────────────┐
│                                          │
│  Installed                               │
│  ┌────────────────────────────────────┐  │
│  │ ● Slack              v2.1.0  [⚙]  │  │
│  │   2 accounts connected             │  │
│  ├────────────────────────────────────┤  │
│  │ ● Telegram           v1.3.2  [⚙]  │  │
│  │   1 account connected              │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Available                               │
│  ┌────────────────────────────────────┐  │
│  │ ○ WhatsApp           v1.0.0       │  │
│  │   WhatsApp Business channel       │  │
│  │                        [Install]   │  │
│  ├────────────────────────────────────┤  │
│  │ ○ Discord            v0.9.1       │  │
│  │   Discord bot channel             │  │
│  │                        [Install]   │  │
│  ├────────────────────────────────────┤  │
│  │ ○ Signal             v0.5.0       │  │
│  │   Signal messenger channel        │  │
│  │                        [Install]   │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [+ Install from npm...]                 │
│                                          │
└──────────────────────────────────────────┘
```

**Behavior:**

*   **Installed plugins** show at the top with status, version, and a gear icon to open channel settings (credentials, accounts).
*   **Available plugins** are fetched from a curated registry (a JSON manifest hosted on GitHub or npm) listing known OpenClaw channel plugins. Clicking **[Install]** runs `npm install <package>` in the sidecar's `extensions/` directory.
*   **[+ Install from npm...]** allows entering a custom npm package name for community plugins not in the curated list.
*   **Uninstall** via the gear menu removes the package and stops associated channels.
*   The Plugin Manager runs installation via the Node.js sidecar (same process that hosts the plugins). The Tauri frontend sends IPC commands to the sidecar to trigger install/uninstall.

### 23.2 Server Mode — CLI Installation

Server Mode plugins are managed via the command line, consistent with the Docker-first deployment model:

```bash
# Install a plugin from npm
npm install --prefix /app/extensions openclaw-slack

# Or add to extensions/ and rebuild
docker compose exec applepi-server npm install openclaw-whatsapp --prefix /app/extensions

# List installed plugins
docker compose exec applepi-server node -e "
  const { ConnectorLoader } = require('./channel-connectors/connector-loader');
  ConnectorLoader.discover('/app/extensions').then(p => console.table(p));
"

# Restart to pick up new plugins (hot-reload for channel config,
# but new plugin packages require restart)
docker compose restart applepi-server
```

**Plugin config** is managed via `config.json` (Section 14) or runtime `config.patch` calls:

```bash
# Add Slack credentials via config.patch
curl -X POST http://localhost:18100 \
  -H "Authorization: Bearer $APPLEPI_SERVER_TOKEN" \
  -d '{
    "type": "req", "id": "1", "method": "config.patch",
    "params": {
      "path": "server.channels.slack.accounts.work",
      "value": { "botToken": "xoxb-...", "appToken": "xapp-...", "enabled": true }
    }
  }'
```

### 23.3 Plugin Registry

Both Desktop and Server Mode share the same plugin discovery format:

*   **Curated registry:** A `plugin-registry.json` hosted at a known URL, listing vetted OpenClaw channel plugins with their npm package names, versions, descriptions, and icons.
*   **npm discovery:** Packages with `"openclaw-plugin": true` in their `package.json` are auto-discovered from `node_modules/`.
*   **Local extensions:** Plugins placed in `extensions/<name>/` with a valid entry point are discovered at startup.
*   **Registry refresh:** Desktop UI checks the registry daily. Server Mode checks on restart.

## 24. Observability (OpenTelemetry)

Pi adopts [OpenTelemetry](https://opentelemetry.io/) for structured observability across all Server Mode components.

### 24.1 Instrumentation Scope

| Signal | What it captures | Examples |
|--------|-----------------|----------|
| **Traces** | Request lifecycle, agent runs, tool invocations | `chat.send` → agent run → tool calls → response |
| **Metrics** | Counters, gauges, histograms | Active connections, agent run duration, message throughput |
| **Logs** | Structured JSON log events | Plugin load errors, auth failures, channel reconnections |

### 24.2 Key Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `pi.connections.active` | Gauge | Current WebSocket connections |
| `pi.agent.runs.active` | Gauge | In-flight agent runs |
| `pi.agent.runs.total` | Counter | Total agent runs (by status: success/error/aborted) |
| `pi.agent.run.duration_ms` | Histogram | Agent run duration |
| `pi.chat.messages.inbound` | Counter | Inbound messages (by channel type) |
| `pi.chat.messages.outbound` | Counter | Outbound messages (by channel type) |
| `pi.channel.status` | Gauge | Channel connection status (1=connected, 0=disconnected) |
| `pi.channel.reconnects` | Counter | Channel reconnection attempts |
| `pi.ws.frames.in` | Counter | Inbound WS frames |
| `pi.ws.frames.out` | Counter | Outbound WS frames |
| `pi.auth.failures` | Counter | Authentication failures (by mode) |

### 24.3 Trace Context

Each `chat.send` request creates a root span. Child spans are created for:
*   Agent processing (thinking, tool selection)
*   Each tool invocation (MCP call, terminal command, web search)
*   Channel plugin outbound delivery
*   Session persistence writes

Trace IDs are included in `ChatEvent` and `AgentEvent` frames so external clients can correlate UI events with backend traces.

### 24.4 Export Configuration

```json
{
  "server": {
    "telemetry": {
      "enabled": true,
      "exporter": "otlp",
      "endpoint": "http://localhost:4318",
      "serviceName": "applepi-server",
      "sampleRate": 1.0
    }
  }
}
```

Supported exporters:
*   `otlp` — OpenTelemetry Protocol (default). Works with Jaeger, Grafana Tempo, Datadog, etc.
*   `console` — Prints to stdout for development/debugging.
*   `none` — Disabled.

### 24.5 Structured Logging

All server logs are emitted as **structured JSON** to stdout:

```json
{
  "ts": "2026-02-27T10:15:30.123Z",
  "level": "info",
  "msg": "Channel plugin started",
  "plugin": "slack",
  "account": "work",
  "traceId": "abc123...",
  "spanId": "def456..."
}
```

Log levels: `debug`, `info`, `warn`, `error`. Default level: `info`, configurable via `PI_LOG_LEVEL` env var.

Logs are correlated with traces via `traceId` and `spanId` fields, enabling drill-down from a log line to the full trace in your observability platform.

## 25. Backup & Recovery

Session data must survive server restarts, container rebuilds, and accidental data loss.

### 25.1 Storage Layout

```
/data/                              # APPLEPI_DATA_DIR
  config.json                       # Server configuration
  sessions/
    index.db                        # SQLite session index
    transcripts/
      ws_main_conn_abc123.jsonl     # Per-session JSONL transcript
      slack_work_channel_C456.jsonl
      telegram_personal_chat_012.jsonl
  plugins/
    state/                          # Plugin-specific persistent state
  backups/
    sessions-2026-02-27.tar.gz      # Automatic backup archive
```

### 25.2 Automatic Backups

The server performs periodic automatic backups of session data:

*   **Frequency:** Daily at 3:00 AM local time (configurable via `server.backup.schedule`).
*   **What's backed up:** SQLite index + all JSONL transcripts, compressed into a timestamped `.tar.gz`.
*   **Retention:** Keep the last 7 backups (configurable via `server.backup.retention`). Older backups are automatically deleted.
*   **Location:** `$APPLEPI_DATA_DIR/backups/`.

### 25.3 Recovery

**From automatic backup:**
```bash
# Stop the server
docker compose stop applepi-server

# Restore from backup
cd /path/to/pi-data
tar xzf backups/sessions-2026-02-27.tar.gz -C sessions/

# Restart
docker compose start applepi-server
```

**From SQLite corruption:**
If the SQLite index (`index.db`) is corrupted but JSONL transcript files are intact, the server can rebuild the index on startup:
*   On startup, if `index.db` fails integrity check, the server scans all `.jsonl` files in `transcripts/`.
*   For each file, it reads the session metadata (first line) and rebuilds the index entry.
*   This is a best-effort recovery — session metadata (labels, custom settings) may be lost, but conversation history is preserved.

### 25.4 Shared Storage Model with Desktop

Desktop (Apple Pi) uses the same `SessionManager` and persistence format. When the shared `@applepi/ws-server` package (Section 18.5) is extracted, both modes use the same JSONL transcript format and SQLite index schema.

This means:
*   Session data is portable between Desktop and Server Mode (copy the `sessions/` directory).
*   The same recovery logic works in both modes.
*   Desktop stores sessions in its Tauri app data directory; Server Mode stores them in `$APPLEPI_DATA_DIR/sessions/`.

## 26. Resource Limits

Pi enforces resource limits to prevent runaway sessions, memory exhaustion, and abuse. These defaults are based on OpenClaw's proven configuration, adapted for Pi's 1:1 user:agent model.

### 26.1 Agent Concurrency

| Limit | Default | Configurable via |
|-------|---------|-----------------|
| Max concurrent agent runs | 4 | `server.limits.maxConcurrentRuns` |
| Max sub-agent runs | 8 | `server.limits.maxSubagentRuns` |
| Max sub-agent nesting depth | 2 | `server.limits.maxSpawnDepth` |
| Max children per agent session | 5 | `server.limits.maxChildrenPerAgent` |
| Agent run timeout | 300s (5 min) | `server.limits.runTimeoutSeconds` |

When the concurrency limit is reached, new `chat.send` requests are **queued** (not rejected). The queue has its own limits (Section 26.3).

### 26.2 Connection Limits

| Limit | Default | Configurable via |
|-------|---------|-----------------|
| Max WebSocket connections | 50 | `server.limits.maxConnections` |
| Max payload size | 25 MB | `server.limits.maxPayloadBytes` |
| Max buffered bytes per connection | 50 MB | `server.limits.maxBufferedBytes` |
| Handshake timeout | 10s | `server.limits.handshakeTimeoutMs` |

### 26.3 Message Queue

When the agent is busy (at concurrency limit), inbound messages are queued per session:

| Limit | Default | Configurable via |
|-------|---------|-----------------|
| Queue cap per session | 20 | `server.limits.queue.cap` |
| Queue debounce | 1000 ms | `server.limits.queue.debounceMs` |
| Queue overflow policy | `summarize` | `server.limits.queue.dropPolicy` |

**Overflow policies** (when queue exceeds cap):
*   `old` — Drop oldest messages in queue.
*   `new` — Reject new messages with `RATE_LIMITED` error.
*   `summarize` — Keep a bullet-point summary of dropped messages so the agent has context (OpenClaw's default and recommended).

### 26.4 Session Limits

| Limit | Default | Configurable via |
|-------|---------|-----------------|
| Max total sessions | 1000 | `server.limits.maxSessions` |
| Max chat history size per session | 6 MB | `server.limits.maxHistoryBytes` |
| Session retention (idle) | 30 days | `server.limits.sessionRetentionDays` |
| Session reaper interval | 1 hour | (internal, not configurable) |

The session reaper runs periodically and archives sessions that have been idle beyond the retention period. Archived sessions are moved to `$APPLEPI_DATA_DIR/sessions/archive/` and excluded from `sessions.list` results but can be restored.

### 26.5 Deduplication

Prevents duplicate message processing (e.g., webhook retries, double-clicks):

| Limit | Default |
|-------|---------|
| Dedupe TTL | 5 minutes |
| Dedupe max entries | 1000 |

Messages with the same content + sender + channel within the TTL window are silently dropped.

### 26.6 Full Limits Configuration

```json
{
  "server": {
    "limits": {
      "maxConcurrentRuns": 4,
      "maxSubagentRuns": 8,
      "maxSpawnDepth": 2,
      "maxChildrenPerAgent": 5,
      "runTimeoutSeconds": 300,
      "maxConnections": 50,
      "maxPayloadBytes": 26214400,
      "maxBufferedBytes": 52428800,
      "handshakeTimeoutMs": 10000,
      "maxSessions": 1000,
      "maxHistoryBytes": 6291456,
      "sessionRetentionDays": 30,
      "queue": {
        "cap": 20,
        "debounceMs": 1000,
        "dropPolicy": "summarize"
      }
    }
  }
}
```

All limits are configurable at runtime via `config.patch` (Section 14.2). Changes take effect immediately for new requests — existing connections and sessions are not retroactively affected.
