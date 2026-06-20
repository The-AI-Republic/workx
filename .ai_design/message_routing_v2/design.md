# Message Routing v2: Unified Channel Architecture

## 1. Problem Statement

The codebase has two competing message routing systems that evolved independently:

**MessageRouter** (`src/core/MessageRouter.ts`) — A Chrome Extension-specific message bus with 152 `MessageType` enum values. Hardcoded to `chrome.runtime.sendMessage`. Has RPC semantics (request/response), but this is an accident of Chrome's `sendResponse` callback, not an intentional architectural choice. Desktop and Server modes create fake shims (`DesktopMessageRouter`, `ServerMessageRouter`) that don't actually do RPC — they just satisfy the `RepublicAgent` constructor which requires a `MessageRouter` for `updateState()`.

**ChannelAdapter** (`src/core/channels/`) — A platform-agnostic interface designed to replace MessageRouter. Clean abstraction with capability detection. Real implementations exist for all platforms. But the migration stopped halfway — ChannelAdapter only handles the conversation loop (Op in, EventMsg out), not the ~51 service APIs (MCP, scheduler, vault, skills, A2A, sessions).

This creates three problems:

1. **Service APIs only work in Chrome Extension mode.** The ~51 RPC message types (MCP management, scheduler queries, vault operations, skills CRUD, etc.) are only wired up in the extension's service-worker via `MessageRouter`. Desktop handles only a subset (skills via a hardcoded switch in `TauriMessageService`). Server mode has none.

2. **Platform shims add complexity.** Desktop creates `DesktopMessageRouter` (fires Tauri events into the void). Server creates `ServerMessageRouter` (forwards to local handlers + WebSocket sink). Both exist solely because `RepublicAgent` requires a `MessageRouter` in its constructor.

3. **UI messaging is fragmented.** `ChromeMessageService` and `TauriMessageService` are separate implementations with different wiring. `TauriMessageService` has a growing switch statement that must be manually extended for each new service API.

## 2. Design Goals

1. **Unify** all messaging through a single system: the evolved ChannelAdapter/ChannelManager
2. **Service parity** across all platforms — MCP, scheduler, vault, skills work everywhere
3. **Every frontend is a channel** — sidepanel, Tauri webview, Telegram, Slack, and future frontends are all ChannelAdapters
4. **External channels** (Telegram, Slack, WebSocket API) continue to work unchanged
5. **No RPC at the transport layer** — request/response correlation lives in the channel client, not in the channel
6. **Delete** MessageRouter, DesktopMessageRouter, ServerMessageRouter, ChromeMessageService, TauriMessageService

## 3. Architecture Overview

### Current (v1)

```
UI Components ──→ ChromeMessageService / TauriMessageService (platform-specific)
                         │
                  [chrome.runtime / Tauri events / hardcoded switch]
                         │
                  MessageRouter (Chrome) / DesktopMessageRouter (shim) / ServerMessageRouter (shim)
                         │
                  ┌──────┴──────┐
                  │             │
            Op/EventMsg    Service RPC (150+ types)
            via Channel    via MessageRouter handlers
            Adapter        (extension-only)
                  │
            ChannelManager → RepublicAgent
```

### Target (v2)

```
Channel Frontends ──→ ChannelClient (universal, platform-agnostic)
                         │
                  ChannelTransport (platform-specific: Chrome / Tauri / WebSocket)
                         │
                  ChannelAdapter (unchanged interface)
                         │
                  ChannelManager
                         │
                  ┌──────┴──────┐
                  │             │
            Op (conversation)  ServiceRequest Op
            → AgentHandler     → ServiceRegistry
                  │             │
            RepublicAgent    Service handlers (mcp, scheduler, vault, skills, etc.)
                  │             │
            EventMsg ←─────────┘ ServiceResponse EventMsg
                  │
            ChannelAdapter.sendEvent() → Channel Frontend
```

**Key insight:** Service requests are just another Op type. Service responses are just another EventMsg type. The existing channel pipe handles both — no new transport mechanism needed.

### Detailed Architecture Diagram (v2)

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                         CHANNEL FRONTENDS                                      │
│           (Web UI, Desktop, WebSocket clients, Telegram, Slack, etc.)           │
│                                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐        │
│  │ MCP Settings │  │  Scheduler   │  │    Skills    │  │  Chat Page   │  ...    │
│  │   .svelte    │  │   .svelte    │  │   .svelte    │  │   .svelte    │        │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘        │
│         │ serviceRequest   │ serviceRequest   │ serviceRequest  │ submitOp       │
│         │ ('mcp.get...')   │ ('scheduler..')  │ ('skills.list') │ (UserTurn)     │
│         └─────────┬────────┴─────────┬────────┘                │                │
│                   ▼                  ▼                          ▼                │
│         ┌─────────────────────────────────────────────────────────┐              │
│         │                  ChannelClient                        │              │
│         │                                                        │              │
│         │  submitOp(op)              serviceRequest(service, p)  │              │
│         │  onEvent(type, handler)    [pending request map +      │              │
│         │                             30s timeout + correlation] │              │
│         └───────────────────────┬─────────────────────────────────┘              │
│                                 │                                               │
│         ┌───────────────────────┴─────────────────────────────────┐              │
│         │              ChannelTransport (interface)             │              │
│         │                                                        │              │
│         │  sendOp(op) ──►           ◄── onEvent(handler)         │              │
│         │  initialize()             destroy()                    │              │
│         └───────────────────────┬─────────────────────────────────┘              │
│                                 │                                               │
│    ┌────────────────────────────┼────────────────────────────┐                   │
│    │ (one per platform)        │                            │                   │
│    │                           │                            │                   │
│    ▼                           ▼                            ▼                   │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐               │
│  │ ChromeExtension  │  │   TauriTransport │  │   WebSocket      │               │
│  │ Transport        │  │                  │  │   Transport      │               │
│  │                  │  │                  │  │                  │               │
│  │ chrome.runtime   │  │ emit('pi:submit')│  │ ws.send(op)      │               │
│  │ .sendMessage()   │  │ listen('pi:event')│ │ ws.onmessage()   │               │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘               │
│           │                     │                      │                        │
└───────────┼─────────────────────┼──────────────────────┼────────────────────────┘
            │                     │                      │
═══════════ │ ═══════ TRANSPORT ══│══════════════════════ │ ═══════════════════════
            │  chrome.runtime     │  Tauri events         │  WebSocket
            │                     │  (pi:submit/pi:event) │
└───────────┼─────────────────────┼──────────────────────┼────────────────────────┘
            │                     │                      │
┌───────────┼─────────────────────┼──────────────────────┼────────────────────────┐
│           │                     │                      │                        │
│           ▼                     ▼                      ▼                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐               │
│  │ SidePanelChannel │  │  TauriChannel    │  │  ServerChannel   │               │
│  │ (ChannelAdapter) │  │  (ChannelAdapter)│  │  (ChannelAdapter)│               │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘               │
│           │                     │                      │                        │
│           │    ┌────────────────┼──────────────────┐   │                        │
│           │    │                │                  │   │                        │
│           │    │  ┌─────────────────────────────┐  │   │                        │
│           │    │  │  ConnectorBridge            │  │   │                        │
│           │    │  │  (Telegram, Slack, etc.)    │  │   │                        │
│           │    │  │  (ChannelAdapter)           │  │   │                        │
│           │    │  │  services: false            │  │   │                        │
│           │    │  └─────────────┬───────────────┘  │   │                        │
│           │    │                │                  │   │                        │
│           ▼    ▼                ▼                  ▼   ▼                        │
│         ┌───────────────────────────────────────────────────┐                   │
│         │                  ChannelManager                   │                   │
│         │                                                  │                   │
│         │  registerChannel()      setAgentHandler()        │                   │
│         │  dispatchEvent()        broadcastEvent()         │                   │
│         │  getServiceRegistry()                            │                   │
│         │                                                  │                   │
│         │  onSubmission routing:                           │                   │
│         │  ┌─────────────────────────────────────────────┐ │                   │
│         │  │ if op.type === 'ServiceRequest'             │ │                   │
│         │  │   → ServiceRegistry.handle()               │ │                   │
│         │  │   → send ServiceResponse EventMsg back     │ │                   │
│         │  │ else                                       │ │                   │
│         │  │   → AgentHandler (RepublicAgent)           │ │                   │
│         │  └─────────────────────────────────────────────┘ │                   │
│         └──────────┬────────────────────────┬──────────────┘                   │
│                    │                        │                                  │
│         ┌──────────▼──────────┐  ┌──────────▼──────────┐                      │
│         │   AgentHandler      │  │   ServiceRegistry    │                      │
│         │                     │  │                      │                      │
│         │  RepublicAgent      │  │  'mcp.getServers'    │                      │
│         │  .submitOperation() │  │  'mcp.connect'       │                      │
│         │                     │  │  'scheduler.getState'│                      │
│         │  Emits EventMsg:    │  │  'skills.list'       │                      │
│         │  - AgentMessage     │  │  'vault.status'      │                      │
│         │  - AgentMessageDelta│  │  'session.getState'  │                      │
│         │  - ExecApproval...  │  │  'a2a.getAgents'     │                      │
│         │  - ToolExecution... │  │  'storage.get'       │                      │
│         │  - StateUpdate      │  │   ...                │                      │
│         │  - etc.             │  │                      │                      │
│         └──────────┬──────────┘  │  Returns:            │                      │
│                    │             │  ServiceResponse      │                      │
│                    │             │  EventMsg             │                      │
│                    │             └──────────┬────────────┘                      │
│                    │                        │                                  │
│                    ▼                        ▼                                  │
│         ┌───────────────────────────────────────────────┐                      │
│         │         ChannelAdapter.sendEvent()            │                      │
│         │    (routes EventMsg back to channel frontend)  │                      │
│         └───────────────────────────────────────────────┘                      │
│                                                                                │
│                          AGENT SIDE (Backend)                                   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Message Flow Examples

**Conversation flow (unchanged):**
```
Frontend: submitOp({type: 'UserTurn', items: [...]})
  → Transport.sendOp()
  → ChannelAdapter.onSubmission()
  → ChannelManager → AgentHandler → RepublicAgent
  → RepublicAgent emits EventMsg (AgentMessage, AgentMessageDelta, ...)
  → ChannelManager.dispatchEvent()
  → ChannelAdapter.sendEvent()
  → Transport.onEvent()
  → ChannelClient.onEvent() → frontend updates
```

**Service request flow (new):**
```
Frontend: serviceRequest('mcp.getServers')
  → ChannelClient generates requestId, stores pending Promise
  → Transport.sendOp({type: 'ServiceRequest', requestId, service: 'mcp.getServers'})
  → ChannelAdapter.onSubmission()
  → ChannelManager detects ServiceRequest
  → ServiceRegistry.handle('mcp.getServers') → mcpManager.getServers()
  → ChannelManager sends ServiceResponse EventMsg (with requestId + data)
  → ChannelAdapter.sendEvent()
  → Transport.onEvent()
  → ChannelClient matches requestId → resolves Promise with data
```

**Plugin channel flow (unchanged):**
```
Telegram user sends message
  → OpenClaw plugin gateway receives
  → ConnectorBridge.handleInboundMessage()
  → Builds Op({type: 'UserInput', items: [...]}) + SubmissionContext
  → ChannelManager → AgentHandler → RepublicAgent
  → RepublicAgent emits AgentMessage EventMsg
  → ConnectorBridge.sendEvent() → plugin.outbound.sendText()
  → Telegram user receives reply
```

### Platform Comparison (v2)

```
                  Chrome Extension          Desktop (Tauri)         Server (Node.js)
                  ────────────────          ───────────────         ────────────────

Client            ChannelClient           ChannelClient         ChannelClient
                       │                         │                       │
Transport         ChromeExtension            TauriTransport          WebSocket
                  Transport                       │                  Transport
                       │                         │                       │
                  chrome.runtime              pi:submit               ws.send()
                  .sendMessage()              pi:event                ws.onmessage
                       │                         │                       │
Channel           SidePanelChannel           TauriChannel            ServerChannel
Adapter           TabPageChannel                  │                       │
                       │                         │                       │
Channel           ─────────────── ChannelManager (shared) ───────────────
Manager                │                         │
                  AgentHandler              ServiceRegistry
                       │                         │
Agent             RepublicAgent          Service handlers (shared)
                                         mcp, scheduler, vault,
                                         skills, a2a, session, ...

Deleted:          MessageRouter            DesktopMessageRouter     ServerMessageRouter
                  ChromeMessageService     TauriMessageService      (n/a)
```

## 4. Core Protocol Changes

### 4.1 New Op: ServiceRequest

Added to the `Op` discriminated union in `src/core/protocol/types.ts`:

```typescript
| {
    type: 'ServiceRequest';
    requestId: string;        // UUID for response correlation
    service: string;          // Dotted path: 'mcp.getServers', 'vault.status'
    params: Record<string, unknown>;
  }
```

### 4.2 New EventMsg: ServiceResponse

Added to the `EventMsg` union in `src/core/protocol/events.ts`:

```typescript
| {
    type: 'ServiceResponse';
    data: {
      requestId: string;     // Correlates to ServiceRequest.requestId
      service: string;       // Echo of the service path
      success: boolean;
      data?: unknown;        // Response payload (on success)
      error?: string;        // Error message (on failure)
    };
  }
```

### 4.3 New EventMsg: StateUpdate

Replaces `messageRouter.updateState()` in RepublicAgent:

```typescript
| {
    type: 'StateUpdate';
    data: {
      sessionId?: string;
      tabId?: number;
      [key: string]: unknown;
    };
  }
```

### 4.4 ChannelCapabilities Enhancement

```typescript
export interface ChannelCapabilities {
  streaming: boolean;
  approvals: boolean;
  media: boolean;
  services: boolean;    // NEW: can this channel send service requests?
}
```

Channels with direct service access (browser sidepanel, Tauri, WebSocket) return `services: true`. Plugin bridges (Telegram, Slack) return `services: false`.

## 5. Service System

### 5.1 ServiceRegistry

New file: `src/core/channels/ServiceRegistry.ts`

```typescript
export type ServiceHandler = (
  params: Record<string, unknown>,
  context: SubmissionContext
) => Promise<unknown>;

export class ServiceRegistry {
  private handlers = new Map<string, ServiceHandler>();

  register(servicePath: string, handler: ServiceHandler): void;
  unregister(servicePath: string): void;
  handle(servicePath: string, params: Record<string, unknown>, context: SubmissionContext): Promise<unknown>;
  has(servicePath: string): boolean;
  listServices(): string[];
}
```

### 5.2 ChannelManager Enhancement

`ChannelManager` gains a `ServiceRegistry` instance. When a channel receives a `ServiceRequest` Op, the ChannelManager routes it to the registry instead of the agent handler:

```typescript
channel.onSubmission(async (op, context) => {
  if (op.type === 'ServiceRequest') {
    await this.handleServiceRequest(op, context, channel);
  } else if (this.agentHandler) {
    await this.agentHandler(op, context);
  }
});

private async handleServiceRequest(op, context, channel): Promise<void> {
  try {
    const result = await this.serviceRegistry.handle(op.service, op.params, context);
    await channel.sendEvent({
      type: 'ServiceResponse',
      data: { requestId: op.requestId, service: op.service, success: true, data: result },
    }, context.userId);
  } catch (error) {
    await channel.sendEvent({
      type: 'ServiceResponse',
      data: { requestId: op.requestId, service: op.service, success: false, error: error.message },
    }, context.userId);
  }
}
```

### 5.3 Service Namespace Convention

Services use dotted paths grouped by domain:

| Namespace | Examples | Current MessageType |
|-----------|----------|-------------------|
| `mcp.*` | `mcp.getServers`, `mcp.connect`, `mcp.executeTool` | `MCP_GET_SERVERS`, `MCP_CONNECT`, etc. |
| `scheduler.*` | `scheduler.getState`, `scheduler.createDraft` | `SCHEDULER_GET_STATE`, etc. |
| `vault.*` | `vault.status`, `vault.unlock`, `vault.pin.set` | `VAULT_STATUS`, `VAULT_UNLOCK`, etc. |
| `skills.*` | `skills.list`, `skills.save`, `skills.load` | `SKILLS_LIST`, `SKILLS_SAVE`, etc. |
| `a2a.*` | `a2a.getAgents`, `a2a.executeSkill` | `A2A_GET_AGENTS`, etc. |
| `session.*` | `session.getState`, `session.reset`, `session.list` | `GET_STATE`, `SESSION_RESET`, etc. |
| `agent.*` | `agent.healthCheck`, `agent.configUpdate` | `HEALTH_CHECK`, `CONFIG_UPDATE` |
| `storage.*` | `storage.get`, `storage.set` | `STORAGE_GET`, `STORAGE_SET` |

### 5.4 Service Handler Extraction

Service handlers are extracted into platform-agnostic modules that take dependency instances and return handler maps:

```typescript
// src/core/services/mcp-services.ts
export function createMcpServices(mcpManager: MCPManager): Record<string, ServiceHandler> {
  return {
    'mcp.getServers': async () => mcpManager.getServers(),
    'mcp.addServer': async (params) => mcpManager.addServer(params.config),
    'mcp.connect': async (params) => mcpManager.connect(params.serverId),
    // ...
  };
}
```

Each bootstrap calls these with its own instances:

```typescript
// In any bootstrap:
const services = channelManager.getServiceRegistry();
for (const [path, handler] of Object.entries(createMcpServices(mcpManager))) {
  services.register(path, handler);
}
```

This ensures all platforms register identical service paths with platform-specific implementations.

## 6. Platform Implementations

### 6.1 Chrome Extension

**Backend (SidePanelChannel)** — No changes needed. The channel already handles `{ type: 'submission', op }` messages. When `op.type === 'ServiceRequest'`, the ChannelManager routes it to the ServiceRegistry. The `ServiceResponse` EventMsg is sent back via the existing `sendEvent()` → `chrome.runtime.sendMessage()` path.

**Service registration** — In `service-worker.ts`, replace `setupMCPMessageHandlers()`, `setupSchedulerMessageHandlers()`, etc. with service registrations. Handler bodies are identical; only the wiring changes from `router.on(MessageType.X, ...)` to `services.register('x.y', ...)`.

### 6.2 Desktop (Tauri)

**Backend (TauriChannel)** — No changes needed. The channel already handles `pi:submit` events with Op payloads. ServiceRequest Ops flow through the same path.

**Service registration** — In `DesktopAgentBootstrap`, register all services. This eliminates `TauriMessageService`'s switch statement and gives desktop full service parity for the first time.

### 6.3 Server

**Backend (ServerChannel)** — No changes needed. The channel already has `handleSubmission(op, context)`.

**Service registration** — In `ServerAgentBootstrap`, register services. This gives server mode full parity with extension — MCP management, skills, vault all become available via the WebSocket API.

**Wire format** — Add `ServiceResponse` → `'service.response'` to `ServerChannel.eventMsgToName()`.

### 6.4 Plugin Bridges

**No changes needed.** `ConnectorBridge` returns `supportsServices(): false`. Plugin channels only handle `UserInput` Ops from messaging platforms. If a service request somehow arrives, the ChannelManager can check capabilities or the service handler can check `context.channelType`.

## 7. Channel Client Layer

The `ChannelClient` and `ChannelTransport` provide the frontend-facing interface for any channel that needs to send Ops and receive EventMsgs. While the examples below focus on web-based frontends (Chrome Extension, Tauri, WebSocket), the same pattern applies to any channel frontend — the transport is the only piece that changes per platform.

### 7.1 ChannelClient

New file: `src/core/messaging/ChannelClient.ts`

Replaces both `ChromeMessageService` and `TauriMessageService` with a single class:

```typescript
export class ChannelClient {
  private transport: ChannelTransport;
  private pendingRequests: Map<string, { resolve, reject, timeout }>;
  private eventHandlers: Map<string, Set<(data) => void>>;

  constructor(transport: ChannelTransport);

  // Send conversation Ops (UserTurn, Interrupt, etc.)
  async submitOp(op: Op, context?: Record<string, unknown>): Promise<void>;

  // Send service request and wait for matching ServiceResponse
  async serviceRequest<T>(service: string, params?: Record<string, unknown>): Promise<T>;

  // Listen for events by type
  onEvent(type: string, handler: (data) => void): () => void;
}
```

The `serviceRequest()` method:
1. Generates a `requestId` (UUID)
2. Sends a `ServiceRequest` Op through the transport
3. Returns a Promise that resolves when a `ServiceResponse` with matching `requestId` arrives
4. Times out after 30s

**The RPC pattern exists only here** — at the client layer. The transport and backend are always fire-and-forget.

### 7.2 ChannelTransport

Platform-specific transport interface:

```typescript
export interface ChannelTransport {
  sendOp(op: Op, context?: Record<string, unknown>): Promise<void>;
  onEvent(handler: (event: EventMsg) => void): () => void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}
```

**ChromeExtensionTransport:**
- `sendOp()` → `chrome.runtime.sendMessage({ type: 'submission', op })`
- `onEvent()` → `chrome.runtime.onMessage.addListener` filtering for `{ type: 'event' }`

**TauriTransport:**
- `sendOp()` → `emit('pi:submit', { op })`
- `onEvent()` → `listen('pi:event', handler)`

**WebSocketTransport** (for server mode clients):
- `sendOp()` → `ws.send(JSON.stringify({ method: 'chat.send', params: op }))`
- `onEvent()` → `ws.onmessage` handler

### 7.3 Frontend Migration

Web UI components change from:
```typescript
const servers = await sendMessage(MessageType.MCP_GET_SERVERS);
```

To:
```typescript
const servers = await getChannelClient().serviceRequest('mcp.getServers');
```

A temporary compatibility shim maps old `MessageType` values to service paths during migration.

## 8. RepublicAgent Changes

Remove the `MessageRouter` dependency:

**Before:**
```typescript
constructor(config: AgentConfig, router: MessageRouter, initialHistory?, agentId?, userNotifier?)
// Uses: this.messageRouter.updateState({ sessionId, tabId })
```

**After:**
```typescript
constructor(config: AgentConfig, initialHistory?, agentId?, userNotifier?)
// Uses: this.emitEvent({ type: 'StateUpdate', data: { sessionId, tabId } })
```

The `StateUpdate` EventMsg flows through the existing `eventDispatcher` → `ChannelManager` → `ChannelAdapter.sendEvent()` path, reaching the channel frontend just like any other event.

## 9. Complete MessageType Mapping

### Become ServiceRequest/ServiceResponse (51 types → service paths)

| MessageType | Service Path |
|---|---|
| `GET_STATE` | `session.getState` |
| `HEALTH_CHECK` | `agent.healthCheck` |
| `SESSION_RESET` | `session.reset` |
| `RESUME_SESSION` | `session.resume` |
| `CONFIG_UPDATE` | `agent.configUpdate` |
| `INIT_AUTH` | `agent.initAuth` |
| `STORAGE_GET` | `storage.get` |
| `STORAGE_SET` | `storage.set` |
| `MCP_GET_SERVERS` | `mcp.getServers` |
| `MCP_ADD_SERVER` | `mcp.addServer` |
| `MCP_UPDATE_SERVER` | `mcp.updateServer` |
| `MCP_REMOVE_SERVER` | `mcp.removeServer` |
| `MCP_CONNECT` | `mcp.connect` |
| `MCP_DISCONNECT` | `mcp.disconnect` |
| `MCP_GET_CONNECTION` | `mcp.getConnection` |
| `MCP_GET_CONNECTIONS` | `mcp.getConnections` |
| `MCP_GET_ALL_TOOLS` | `mcp.getAllTools` |
| `MCP_EXECUTE_TOOL` | `mcp.executeTool` |
| `MCP_GET_ALL_RESOURCES` | `mcp.getAllResources` |
| `MCP_READ_RESOURCE` | `mcp.readResource` |
| `SCHEDULER_CREATE_DRAFT_TASK` | `scheduler.createDraft` |
| `SCHEDULER_SCHEDULE_TASK` | `scheduler.schedule` |
| `SCHEDULER_TRIGGER_TASK` | `scheduler.trigger` |
| `SCHEDULER_CANCEL_TASK` | `scheduler.cancel` |
| `SCHEDULER_COMPLETE_TASK` | `scheduler.complete` |
| `SCHEDULER_FAIL_TASK` | `scheduler.fail` |
| `SCHEDULER_PAUSE_QUEUE` | `scheduler.pauseQueue` |
| `SCHEDULER_RESUME_QUEUE` | `scheduler.resumeQueue` |
| `SCHEDULER_GET_DRAFT_TASKS` | `scheduler.getDraftTasks` |
| `SCHEDULER_GET_SCHEDULED_TASKS` | `scheduler.getScheduledTasks` |
| `SCHEDULER_GET_MISSED_TASKS` | `scheduler.getMissedTasks` |
| `SCHEDULER_GET_QUEUE` | `scheduler.getQueue` |
| `SCHEDULER_GET_ARCHIVED_TASKS` | `scheduler.getArchivedTasks` |
| `SCHEDULER_GET_STATE` | `scheduler.getState` |
| `SCHEDULER_GET_TASK_DETAILS` | `scheduler.getTaskDetails` |
| `VAULT_STATUS` | `vault.status` |
| `VAULT_UNLOCK` | `vault.unlock` |
| `VAULT_LOCK` | `vault.lock` |
| `PIN_SET` | `vault.pin.set` |
| `PIN_CHANGE` | `vault.pin.change` |
| `PIN_REMOVE` | `vault.pin.remove` |
| `PIN_FORGOT` | `vault.pin.forgot` |
| `SKILLS_LIST` | `skills.list` |
| `SKILLS_LOAD` | `skills.load` |
| `SKILLS_SAVE` | `skills.save` |
| `SKILLS_DELETE` | `skills.delete` |
| `SKILLS_UPDATE_MODE` | `skills.updateMode` |
| `SKILLS_IMPORT` | `skills.import` |
| `SKILLS_EXPORT` | `skills.export` |
| `SKILLS_TRUST` | `skills.trust` |
| `SESSION_LIST` | `session.list` |
| `SESSION_GET_ACTIVE_COUNT` | `session.getActiveCount` |
| `A2A_GET_AGENTS` | `a2a.getAgents` |
| `A2A_ADD_AGENT` | `a2a.addAgent` |
| `A2A_UPDATE_AGENT` | `a2a.updateAgent` |
| `A2A_REMOVE_AGENT` | `a2a.removeAgent` |
| `A2A_CONNECT` | `a2a.connect` |
| `A2A_DISCONNECT` | `a2a.disconnect` |
| `A2A_GET_CONNECTION` | `a2a.getConnection` |
| `A2A_GET_CONNECTIONS` | `a2a.getConnections` |
| `A2A_GET_ALL_SKILLS` | `a2a.getAllSkills` |
| `A2A_EXECUTE_SKILL` | `a2a.executeSkill` |
| `A2A_CANCEL_TASK` | `a2a.cancelTask` |

### Already Op/EventMsg via ChannelAdapter (unchanged)

| MessageType | Disposition |
|---|---|
| `SUBMISSION` | Core conversation loop — `UserInput`, `UserTurn`, `ExecApproval`, etc. |
| `INTERRUPT` | Already Op type `{ type: 'Interrupt' }` |
| `EVENT` | Generic EventMsg envelope |
| `STATE_UPDATE` | Becomes `StateUpdate` EventMsg |
| `RESPONSE_*` (10 types) | Streaming events — already EventMsg types (`AgentMessageDelta`, etc.) |
| `APPROVAL_REQUEST` | Already EventMsg (`ExecApprovalRequest`, `ApplyPatchApprovalRequest`) |
| `DIFF_GENERATED` | Already EventMsg (`TurnDiff`) |
| `SESSION_EVENT` | Broadcast EventMsg via `channelManager.broadcastEvent()` |
| `SCHEDULER_EVENT` | Broadcast EventMsg via `channelManager.broadcastEvent()` |

### Deleted (no longer needed)

| MessageType | Reason |
|---|---|
| `PING` / `PONG` | Transport-level health check in `ChannelTransport.initialize()` |
| `HEALTH_STATUS` | Merged into `agent.healthCheck` ServiceResponse |
| `SESSION_RESET_COMPLETE` | Merged into `session.reset` ServiceResponse |
| `RESUME_SESSION_COMPLETE` | Merged into `session.resume` ServiceResponse |
| `AGENT_REINITIALIZED` | Merged into `agent.configUpdate` ServiceResponse or `StateUpdate` event |
| `TAB_COMMAND` | Internal to extension mode, direct API call on TabManager |
| `TOOL_EXECUTE` | Placeholder handler, remove |
| `DOM_ACTION` / `DOM_RESPONSE` | Dead code — DOM tool migrated to CDP (`ChromeDebuggerClient`), no handlers or senders exist |
| `DOM_CAPTURE_*` | Dead code — same CDP migration, safe to delete with no replacement needed |
| `SCHEDULER_TASK_STATUS_CHANGED` | Subsumed by `SCHEDULER_EVENT` |
| `SCHEDULER_STATE_CHANGED` | Subsumed by `SCHEDULER_EVENT` |

## 10. Migration Plan

### Phase 1: Add Service Infrastructure (Non-Breaking)

Add the new types and registry without changing any existing behavior.

**Create:**
- `src/core/channels/ServiceRegistry.ts`

**Modify:**
- `src/core/channels/ChannelManager.ts` — add ServiceRegistry, route `ServiceRequest` Ops
- `src/core/channels/types.ts` — add `services` to `ChannelCapabilities`
- `src/core/protocol/types.ts` — add `ServiceRequest` to Op union
- `src/core/protocol/events.ts` — add `ServiceResponse` and `StateUpdate` to EventMsg union

### Phase 2: Register Services on All Platforms

Register service handlers alongside existing MessageRouter handlers (both systems work in parallel).

**Create:**
- `src/core/services/mcp-services.ts`
- `src/core/services/scheduler-services.ts`
- `src/core/services/skills-services.ts`
- `src/core/services/vault-services.ts`
- `src/core/services/a2a-services.ts`
- `src/core/services/session-services.ts`
- `src/core/services/agent-services.ts`
- `src/core/services/storage-services.ts`

**Modify:**
- `src/extension/background/service-worker.ts` — call service registration helpers
- `src/desktop/agent/DesktopAgentBootstrap.ts` — call service registration helpers
- `src/server/agent/ServerAgentBootstrap.ts` — call service registration helpers

### Phase 3: Create ChannelClient and Transports

Replace `ChromeMessageService` and `TauriMessageService`.

**Create:**
- `src/core/messaging/ChannelClient.ts`
- `src/core/messaging/transports/ChromeExtensionTransport.ts`
- `src/core/messaging/transports/TauriTransport.ts`

**Modify:**
- `src/core/messaging/index.ts` — add ChannelClient exports
- `src/webfront/lib/messaging.ts` — compatibility shim mapping `MessageType` → service paths

### Phase 4: Remove RepublicAgent's MessageRouter Dependency

**Modify:**
- `src/core/RepublicAgent.ts` — remove constructor parameter, replace `updateState()` with `emitEvent({ type: 'StateUpdate' })`
- `src/core/StreamProcessor.ts` — replace `MessageRouter.sendTypedResponseEvent()` calls with direct `EventMsg` dispatch via `ChannelAdapter.sendEvent()`. Map `ResponseEvent` variants to existing `EventMsg` types (`AgentMessageDelta`, `AgentReasoningDelta`, `WebSearchBegin`, etc.)
- All three bootstrap files — stop creating MessageRouter instances
- `src/core/registry/AgentRegistry.ts` — update session creation

### Phase 5: Migrate Channel Frontends

Update all Svelte components from `sendMessage(MessageType.X)` to `serviceRequest('x.y')`.

**Modify (25+ files in `src/webfront/`):**
- `settings/MCPSettings.svelte`
- `settings/A2ASettings.svelte`
- `pages/skills/Skills.svelte`
- `pages/scheduler/Scheduler.svelte`
- `components/scheduler/*.svelte`
- `stores/vaultStore.ts`
- `components/vault/*.svelte`
- `settings/GeneralSettings.svelte`
- `App.svelte`
- `pages/chat/Main.svelte`
- `commands/builtinCommands.ts`

### Phase 6: Delete Legacy Code

**Delete:**
- `src/core/MessageRouter.ts`
- `src/desktop/channels/DesktopMessageRouter.ts`
- `src/server/channels/ServerMessageRouter.ts`
- `src/core/messaging/ChromeMessageService.ts`
- `src/core/messaging/TauriMessageService.ts`

**Clean up:**
- `src/core/messaging/index.ts` — remove old exports
- `src/core/messaging/types.ts` — remove `IMessageService`
- `src/webfront/lib/messaging.ts` — remove compatibility shim
- `src/extension/background/service-worker.ts` — remove all `setupXxxMessageHandlers()` functions

## 11. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| **Dual system during migration** — handlers could get out of sync | Each phase is independently deployable. Phase 2 runs both systems in parallel for verification. |
| **Chrome service worker restarts** — ServiceRegistry (in-memory) lost | Same as current system — MessageRouter handlers are also in-memory, re-registered on `doInitialize()`. |
| **Large payloads in ServiceResponse** | TauriChannel's `LargePayloadStore` already handles large EventMsgs, including ServiceResponse. |
| **Server WebSocket frame format** | Add `ServiceResponse` → `'service.response'` mapping in `ServerChannel.eventMsgToName()`. |
| **Plugin channels receiving ServiceRequest** | `supportsServices(): false` on plugin bridges. ChannelManager can check capabilities before routing. |

## 12. Verification

### Unit Tests
- `ServiceRegistry`: register, unregister, handle, error paths
- `ChannelManager`: ServiceRequest routing, response dispatch, unknown service error
- `ChannelClient`: serviceRequest correlation, timeout, event dispatch

### Integration Tests
- Chrome Extension: Frontend → SidePanelChannel → ChannelManager → ServiceRegistry → ServiceResponse → Frontend
- Desktop: Frontend → TauriChannel → ChannelManager → ServiceRegistry → ServiceResponse → Frontend
- Server: WebSocket client → ServerChannel → ChannelManager → ServiceRegistry → ServiceResponse → client

### Manual Verification
- MCP settings page works identically across all three platforms
- Scheduler task management works on desktop and server (previously extension-only)
- Skills CRUD works on all platforms
- Vault operations work on all platforms
- Conversation flow (submissions, streaming, approvals) unchanged
