# Message Routing Architecture

Unified, channel-agnostic message routing system for BrowserX. Any frontend channel (browser extension, desktop app, Slack bot, WhatsApp, web UI, CLI, etc.) connects to the same agent backend through a shared pipeline:

```
Frontend Channel           (any client: web UI, Slack, WhatsApp, CLI, etc.)
    |
Transport / Channel        (wire protocol adapter)
    |
ChannelManager             (central orchestrator)
    |
    +-- ServiceRegistry    (RPC handlers: mcp.*, agent.*, etc.)
    +-- AgentHandler       (agent operations: UserTurn, ExecApproval, etc.)
```

---

## Layers

### 1. Transport Layer (Client-side, per-channel)

For clients that run in the same process or have a direct connection (web UI, desktop app), **UIChannelClient** provides the client-side entry point with two communication patterns:

- **RPC**: `serviceRequest<T>(service, params)` -- sends `ServiceRequest` op, waits for `ServiceResponse` event (30s timeout, UUID correlation)
- **Fire-and-forget**: `submitOp(op)` -- sends op with no response expected (UserTurn, ExecApproval, Interrupt, etc.)
- **Events**: `onEvent(type, handler)` -- subscribe to backend events (AgentMessage, TaskComplete, etc.)

**Singleton**: `getInitializedUIClient()` lazily creates the client with the correct transport based on `__BUILD_MODE__` (compile-time constant).

| Platform  | Transport                | Wire Protocol                              |
|-----------|--------------------------|--------------------------------------------|
| Extension | `ChromeExtensionTransport` | `chrome.runtime.sendMessage` / `onMessage` |
| Desktop   | `TauriTransport`         | Tauri `emit('pi:submit')` / `listen('pi:event')` |
| Server    | `WebSocketTransport`     | WebSocket JSON frames                      |

**Files:**
- `src/core/messaging/UIChannelClient.ts`
- `src/core/messaging/index.ts` (singleton + transport selection)
- `src/core/messaging/transports/types.ts` (UIChannelTransport interface)
- `src/core/messaging/transports/ChromeExtensionTransport.ts`
- `src/core/messaging/transports/TauriTransport.ts`
- `src/core/messaging/transports/WebSocketTransport.ts`

---

### 2. Channel Layer (Backend-side, per-channel)

Each frontend channel implements `ChannelAdapter` to bridge its wire protocol to the ChannelManager. Adding a new channel (e.g., Slack, Telegram, WhatsApp) only requires implementing this interface:

```typescript
interface ChannelAdapter {
  channelId: string;
  channelType: ChannelType;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  onSubmission(handler): void;       // inbound: ops from client
  sendEvent(event, clientId?): void;  // outbound: events to client
  getCapabilities(): ChannelCapabilities;
}
```

| Channel              | ID               | Inbound                       | Outbound                      |
|----------------------|------------------|-------------------------------|-------------------------------|
| `SidePanelChannel`   | `sidepanel-main` | `chrome.runtime.onMessage`    | `chrome.runtime.sendMessage`  |
| `TabPageChannel`     | `tabpage-{id}`   | `chrome.runtime.onMessage`    | `chrome.tabs.sendMessage`     |
| `TauriChannel`       | `tauri-main`     | `listen('pi:submit')`         | `emit('pi:event')`            |
| `ServerChannel`      | `server-main`    | WebSocket `onmessage`         | `ws.send()`                   |
| `ChannelPluginBridge`| per-plugin       | Plugin account events         | Plugin send API               |
| *(future)*           | e.g. `slack-bot` | Slack Events API              | Slack Web API                 |

**Files:**
- `src/core/channels/ChannelAdapter.ts`
- `src/core/channels/types.ts` (ChannelType, SubmissionContext, ChannelCapabilities)
- `src/extension/channels/SidePanelChannel.ts`
- `src/extension/channels/TabPageChannel.ts`
- `src/desktop/channels/TauriChannel.ts`
- `src/server/channels/ServerChannel.ts`

---

### 3. ChannelManager (Central Orchestrator)

Singleton that routes submissions and dispatches events:

```
Submission arrives from channel
    |
    +-- op.type === 'ServiceRequest'?
    |       YES --> ServiceRegistry.handle(service, params, context)
    |               --> sends ServiceResponse event back via channel
    |       NO  --> AgentHandler(op, context)
    |               --> RepublicAgent.submitOperation()
```

**Key methods:**
- `registerChannel(adapter)` -- wire channel's submissions to routing logic
- `setAgentHandler(handler)` -- set handler for non-service ops
- `dispatchEvent(event, channelId)` -- send event to specific channel
- `broadcastEvent(event)` -- send event to all channels
- `getServiceRegistry()` -- access the ServiceRegistry

**File:** `src/core/channels/ChannelManager.ts`

---

### 4. Service Layer (RPC Handlers)

The **ServiceRegistry** maps dotted service paths to async handler functions:

```typescript
registry.register('mcp.getServers', async (params, context) => { ... });
```

Services are registered via `registerAllServices(registry, deps)` -- each platform provides only the dependencies it supports:

| Service Domain | Example Paths                              | Source File                   |
|----------------|--------------------------------------------|-------------------------------|
| `agent`        | `healthCheck`, `configUpdate`, `interrupt`, `ping`, `initAuth` | `agent-services.ts`   |
| `approval`     | `updateConfig`                             | `agent-services.ts`           |
| `mcp`          | `getServers`, `addServer`, `callTool`, `connectServer` | `mcp-services.ts`   |
| `scheduler`    | `listJobs`, `createJob`, `deleteJob`       | `scheduler-services.ts`       |
| `skills`       | `getSkill`, `listSkills`                   | `skills-services.ts`          |
| `vault`        | `status`, `unlock`, `lock`                 | `vault-services.ts`           |
| `a2a`          | `listAgents`, `addAgent`, `connectAgent`   | `a2a-services.ts`             |
| `session`      | `list`, `resume`, `resetTabs`              | `session-services.ts`         |
| `storage`      | `get`, `set`                               | `storage-services.ts`         |

**Files:**
- `src/core/channels/ServiceRegistry.ts`
- `src/core/services/index.ts` (registerAllServices factory)
- `src/core/services/*.ts` (individual service modules)

---

### 5. Protocol Layer (Op + EventMsg types)

**Ops** (Client --> Agent submissions):

| Op Type          | Purpose                              | Routing        |
|------------------|--------------------------------------|----------------|
| `ServiceRequest` | RPC call to a registered service     | ServiceRegistry |
| `UserTurn`       | User message to agent                | AgentHandler    |
| `ExecApproval`   | Approval decision for tool execution | AgentHandler    |
| `Interrupt`      | Abort current task                   | AgentHandler    |
| `Shutdown`       | Graceful shutdown                    | AgentHandler    |
| `Review`         | Code review request                  | AgentHandler    |
| ...              | (see `protocol/types.ts` for full list) |              |

**EventMsgs** (Agent --> Client events):

| Category   | Event Types                                                    |
|------------|----------------------------------------------------------------|
| Agent      | `AgentMessage`, `AgentMessageDelta`, `AgentReasoning`, `AgentReasoningDelta` |
| Task       | `TaskStarted`, `TaskComplete`, `TaskFailed`, `TurnStarted`, `TurnComplete` |
| Tools      | `McpToolCallBegin/End`, `ExecCommandBegin/End/OutputDelta`, `ToolExecutionStart/End` |
| Approvals  | `ExecApprovalRequest`, `ApprovalRequested`, `ApprovalGranted`, `ApprovalDenied` |
| Service    | `ServiceResponse` (correlates to ServiceRequest via requestId) |
| System     | `StateUpdate`, `BackgroundEvent`, `TokenCount`, `Notification` |

**Files:**
- `src/core/protocol/types.ts`
- `src/core/protocol/events.ts`

---

## Request Flows

### serviceRequest() -- RPC with response

```
  Client                Transport              Channel              ChannelManager         ServiceRegistry
      |                          |                      |                      |                      |
      |-- serviceRequest() ----->|                      |                      |                      |
      |   (generate requestId)   |                      |                      |                      |
      |                          |-- sendOp(ServiceReq)->|                      |                      |
      |                          |                      |-- onSubmission() ---->|                      |
      |                          |                      |                      |-- handle(service) --->|
      |                          |                      |                      |                      |-- handler()
      |                          |                      |                      |                      |   (execute)
      |                          |                      |                      |<-- result ------------|
      |                          |                      |<-- ServiceResponse ---|                      |
      |                          |<-- event ------------|                      |                      |
      |<-- resolve(data) --------|                      |                      |                      |
      |   (match by requestId)   |                      |                      |                      |
```

### submitOp() -- Fire-and-forget to agent

```
  Client                Transport              Channel              ChannelManager          Agent
      |                          |                      |                      |                      |
      |-- submitOp(UserTurn) --->|                      |                      |                      |
      |                          |-- sendOp() --------->|                      |                      |
      |                          |                      |-- onSubmission() ---->|                      |
      |                          |                      |                      |-- agentHandler() --->|
      |                          |                      |                      |                      |-- processOp()
      |                          |                      |                      |                      |   ...
      |                          |                      |<----------------------|<-- dispatchEvent() --|
      |                          |<-- event ------------|                      |                      |
      |<-- onEvent(handler) -----|                      |                      |                      |
```

---

## Bootstrap Wiring (per platform)

Each platform bootstrap follows the same pattern:

1. Create `ChannelManager` (singleton)
2. Create platform-specific `Channel` (SidePanelChannel / TauriChannel / ServerChannel)
3. Create `RepublicAgent`
4. Set `AgentHandler` on ChannelManager (routes ops to agent)
5. Register channel with ChannelManager
6. Set event dispatcher on agent (routes events through ChannelManager to channel)
7. Call `registerAllServices(registry, deps)` with platform-specific deps

| Platform  | Bootstrap File                                    |
|-----------|---------------------------------------------------|
| Extension | `src/extension/background/service-worker.ts`      |
| Desktop   | `src/desktop/agent/DesktopAgentBootstrap.ts`       |
| Server    | `src/server/agent/ServerAgentBootstrap.ts`         |

---

## Platform Detection

Transport selection uses the **compile-time** constant `__BUILD_MODE__` (set by Vite):

```typescript
if (__BUILD_MODE__ === 'desktop')    --> TauriTransport
if (__BUILD_MODE__ === 'extension')  --> ChromeExtensionTransport
```

Runtime checks (e.g., `typeof __TAURI__`) are avoided because the chromePolyfill installs `chrome.runtime` before Tauri globals are available, making runtime detection unreliable.

---

## Chrome Polyfill (Desktop Only)

Desktop mode installs a minimal `chrome` API polyfill (`src/desktop/polyfills/chromePolyfill.ts`) for shared components that reference Chrome extension APIs:

| API                | Polyfill Behavior                        | Status              |
|--------------------|------------------------------------------|---------------------|
| `chrome.storage`   | Delegates to Tauri `invoke()` commands   | Active (90+ refs)   |
| `chrome.tabs`      | No-op stubs (returns empty/null)         | Active (70+ refs)   |
| `chrome.runtime.getURL` | Returns `file://` path              | Active              |
| `chrome.runtime.lastError` | Always null                       | Active              |
| `chrome.runtime.sendMessage` | **Removed** -- use UIChannelClient | Eliminated          |
| `chrome.notifications` | Not polyfilled                       | N/A                 |

Message routing is **fully platform-agnostic** -- no polyfill needed for messaging.
