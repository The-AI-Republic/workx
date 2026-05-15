# Message Routing v2: Implementation Tasks

Reference: [design.md](./design.md)

---

## Phase 1: Add Service Infrastructure (Non-Breaking)

No existing behavior changes. Adds the new types and plumbing alongside the current system.

### T1.1 — Add `ServiceRequest` to Op union

**File:** `src/core/protocol/types.ts`

- Add `ServiceRequest` variant to the `Op` discriminated union:
  ```typescript
  | {
      type: 'ServiceRequest';
      requestId: string;
      service: string;
      params: Record<string, unknown>;
    }
  ```
- Add Zod schema in `src/core/protocol/schemas.ts` if Op validation exists there

**Acceptance:** TypeScript compiles. Existing Op handling (switch statements, if-chains) has default/else branches that won't break.

---

### T1.2 — Add `ServiceResponse` and `StateUpdate` to EventMsg union

**File:** `src/core/protocol/events.ts`

- Add `ServiceResponse` variant:
  ```typescript
  | {
      type: 'ServiceResponse';
      data: {
        requestId: string;
        service: string;
        success: boolean;
        data?: unknown;
        error?: string;
      };
    }
  ```
- Add `StateUpdate` variant:
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

**Acceptance:** TypeScript compiles. Existing EventMsg handlers have default branches that won't break.

---

### T1.3 — Add `services` capability to ChannelCapabilities

**File:** `src/core/channels/types.ts`

- Add `services: boolean` to `ChannelCapabilities` interface
- Update `ChannelAdapter` interface in `src/core/channels/ChannelAdapter.ts` — add `supportsServices(): boolean` method

**Files to update for compile:**
- `src/extension/channels/SidePanelChannel.ts` — `supportsServices() { return true; }`, add `services: true` to `getCapabilities()`
- `src/extension/channels/TabPageChannel.ts` — same
- `src/desktop/channels/TauriChannel.ts` — same
- `src/server/channels/ServerChannel.ts` — `supportsServices() { return true; }`
- `src/desktop/channels/WebSocketChannel.ts` — `supportsServices() { return true; }`
- `src/server/channel-connectors/connector-bridge.ts` — `supportsServices() { return false; }`

**Acceptance:** All channel implementations compile with the new capability.

---

### T1.4 — Create ServiceRegistry

**Create:** `src/core/channels/ServiceRegistry.ts`

```typescript
export type ServiceHandler = (
  params: Record<string, unknown>,
  context: SubmissionContext
) => Promise<unknown>;

export class ServiceRegistry {
  private handlers: Map<string, ServiceHandler>;

  register(servicePath: string, handler: ServiceHandler): void;
  unregister(servicePath: string): void;
  async handle(servicePath: string, params: Record<string, unknown>, context: SubmissionContext): Promise<unknown>;
  has(servicePath: string): boolean;
  listServices(): string[];
}
```

- Throw meaningful error from `handle()` if service not registered
- Export from `src/core/channels/index.ts`

**Acceptance:** Unit tests pass for register, unregister, handle (success + error), has, listServices.

---

### T1.5 — Add ServiceRegistry to ChannelManager + route ServiceRequest Ops

**File:** `src/core/channels/ChannelManager.ts`

- Add `private serviceRegistry: ServiceRegistry`
- Add `getServiceRegistry(): ServiceRegistry` method
- Modify `registerChannel()` — in the `onSubmission` callback, check `op.type === 'ServiceRequest'`:
  - If yes → call `this.handleServiceRequest(op, context, channel)`
  - If no → existing `agentHandler` path (unchanged)
- Add private `handleServiceRequest()` method:
  - Call `serviceRegistry.handle(op.service, op.params, context)`
  - On success → `channel.sendEvent({ type: 'ServiceResponse', data: { requestId, service, success: true, data: result } })`
  - On error → `channel.sendEvent({ type: 'ServiceResponse', data: { requestId, service, success: false, error: message } })`

**Acceptance:** Unit test: register a mock channel + mock service, submit a ServiceRequest Op, verify ServiceResponse EventMsg is sent back via `channel.sendEvent()` with correct requestId and data.

---

### T1.6 — Unit tests for Phase 1

**Create:** `src/core/channels/__tests__/ServiceRegistry.test.ts`

Test cases:
- Register and handle a service successfully
- Handle returns correct data
- Handle throws for unregistered service
- Unregister removes handler
- `has()` returns correct boolean
- `listServices()` returns registered paths
- Handler receives correct params and context

**Create:** `src/core/channels/__tests__/ChannelManager.serviceRequest.test.ts`

Test cases:
- ServiceRequest Op routes to ServiceRegistry (not AgentHandler)
- Non-ServiceRequest Ops still route to AgentHandler
- ServiceResponse EventMsg sent back on success with matching requestId
- ServiceResponse EventMsg sent back on error with matching requestId
- Unknown service returns error ServiceResponse

---

## Phase 2: Extract and Register Service Handlers

Extract service handler logic from extension's service-worker into shared modules. Register on all platforms.

### T2.1 — Extract MCP service handlers

**Create:** `src/core/services/mcp-services.ts`

- Export `createMcpServices(mcpManager): Record<string, ServiceHandler>`
- Extract handler bodies from `setupMCPMessageHandlers()` in `src/extension/background/service-worker.ts`
- Service paths: `mcp.getServers`, `mcp.addServer`, `mcp.updateServer`, `mcp.removeServer`, `mcp.connect`, `mcp.disconnect`, `mcp.getConnection`, `mcp.getConnections`, `mcp.getAllTools`, `mcp.executeTool`, `mcp.getAllResources`, `mcp.readResource`

**Acceptance:** Module exports a function. Handler logic matches existing service-worker handlers.

---

### T2.2 — Extract scheduler service handlers

**Create:** `src/core/services/scheduler-services.ts`

- Export `createSchedulerServices(schedulerStorage, scheduler): Record<string, ServiceHandler>`
- Extract from `setupSchedulerMessageHandlers()`
- Service paths: `scheduler.createDraft`, `scheduler.schedule`, `scheduler.trigger`, `scheduler.cancel`, `scheduler.complete`, `scheduler.fail`, `scheduler.pauseQueue`, `scheduler.resumeQueue`, `scheduler.getDraftTasks`, `scheduler.getScheduledTasks`, `scheduler.getMissedTasks`, `scheduler.getQueue`, `scheduler.getArchivedTasks`, `scheduler.getState`, `scheduler.getTaskDetails`

---

### T2.3 — Extract skills service handlers

**Create:** `src/core/services/skills-services.ts`

- Export `createSkillsServices(skillRegistry): Record<string, ServiceHandler>`
- Extract from `setupSkillsMessageHandlers()` (extension) and `handleSkillsMessage()` (TauriMessageService)
- Service paths: `skills.list`, `skills.load`, `skills.save`, `skills.delete`, `skills.updateMode`, `skills.import`, `skills.export`, `skills.trust`

---

### T2.4 — Extract vault service handlers

**Create:** `src/core/services/vault-services.ts`

- Export `createVaultServices(vaultManager): Record<string, ServiceHandler>`
- Extract from `setupVaultMessageHandlers()`
- Service paths: `vault.status`, `vault.unlock`, `vault.lock`, `vault.pin.set`, `vault.pin.change`, `vault.pin.remove`, `vault.pin.forgot`

---

### T2.5 — Extract A2A service handlers

**Create:** `src/core/services/a2a-services.ts`

- Export `createA2AServices(a2aManager): Record<string, ServiceHandler>`
- Extract from `setupA2AMessageHandlers()`
- Service paths: `a2a.getAgents`, `a2a.addAgent`, `a2a.updateAgent`, `a2a.removeAgent`, `a2a.connect`, `a2a.disconnect`, `a2a.getConnection`, `a2a.getConnections`, `a2a.getAllSkills`, `a2a.executeSkill`, `a2a.cancelTask`

---

### T2.6 — Extract session service handlers

**Create:** `src/core/services/session-services.ts`

- Export `createSessionServices(agent, agentBootstrap): Record<string, ServiceHandler>`
- Extract from `setupSessionMessageHandlers()` and `handleGetState()`, `handleSessionReset()`, `handleResumeSession()` in TauriMessageService
- Service paths: `session.getState`, `session.reset`, `session.resume`, `session.list`, `session.getActiveCount`

---

### T2.7 — Extract agent service handlers

**Create:** `src/core/services/agent-services.ts`

- Export `createAgentServices(agent, agentBootstrap): Record<string, ServiceHandler>`
- Extract from health check, interrupt, config update handlers
- Service paths: `agent.healthCheck`, `agent.interrupt`, `agent.configUpdate`, `agent.initAuth`

---

### T2.8 — Extract storage service handlers

**Create:** `src/core/services/storage-services.ts`

- Export `createStorageServices(storageProvider): Record<string, ServiceHandler>`
- Service paths: `storage.get`, `storage.set`

---

### T2.9 — Create shared service registration helper

**Create:** `src/core/services/index.ts`

- Export a `registerAllServices(registry, dependencies)` function that calls all `create*Services()` and registers them
- `dependencies` is an object with optional fields: `{ mcpManager?, scheduler?, skillRegistry?, vaultManager?, a2aManager?, agent?, agentBootstrap?, storageProvider? }`
- Only registers services for which dependencies are provided

---

### T2.10 — Register services in Chrome Extension bootstrap

**File:** `src/extension/background/service-worker.ts`

- After existing `setupXxxMessageHandlers()` calls, also call `registerAllServices()` on `channelManager.getServiceRegistry()`
- Pass available dependency instances (mcpManager, scheduler, skillRegistry, etc.)
- Both systems (MessageRouter handlers + ServiceRegistry) run in parallel during migration

**Acceptance:** Extension still works as before. Service requests through the new path also work.

---

### T2.11 — Register services in Desktop bootstrap

**File:** `src/desktop/agent/DesktopAgentBootstrap.ts`

- Call `registerAllServices()` on `channelManager.getServiceRegistry()`
- Pass available dependency instances
- This gives desktop mode full service parity for the first time

**Acceptance:** Desktop mode can handle ServiceRequest Ops for all registered services (MCP, skills, session, agent, etc.).

---

### T2.12 — Register services in Server bootstrap

**File:** `src/server/agent/ServerAgentBootstrap.ts`

- Call `registerAllServices()` on `channelManager.getServiceRegistry()`
- Pass available dependency instances
- Add `ServiceResponse` → `'service.response'` mapping in `ServerChannel.eventMsgToName()` if applicable

**Acceptance:** Server mode can handle ServiceRequest Ops via WebSocket.

---

## Phase 3: Create UIChannelClient and Transports

Replace `ChromeMessageService` and `TauriMessageService` with the unified `UIChannelClient`.

### T3.1 — Create UIChannelTransport interface

**Create:** `src/core/messaging/transports/types.ts`

```typescript
export interface UIChannelTransport {
  sendOp(op: Op, context?: Record<string, unknown>): Promise<void>;
  onEvent(handler: (event: EventMsg) => void): () => void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
}
```

---

### T3.2 — Create ChromeExtensionTransport

**Create:** `src/core/messaging/transports/ChromeExtensionTransport.ts`

- `sendOp()` → `chrome.runtime.sendMessage({ type: 'submission', op, ...context })`
- `onEvent()` → `chrome.runtime.onMessage.addListener`, filter for `{ type: 'event' }` messages, return unlisten function
- `initialize()` → ping/pong health check (port from ChromeMessageService retry logic)
- `destroy()` → remove listeners

---

### T3.3 — Create TauriTransport

**Create:** `src/core/messaging/transports/TauriTransport.ts`

- `sendOp()` → `emit('pi:submit', { op, context })`
- `onEvent()` → `listen('pi:event', handler)`, handle LargePayloadStore refs
- `initialize()` → load Tauri APIs dynamically (`@tauri-apps/api/event`)
- `destroy()` → call unlisten functions

---

### T3.4 — Create WebSocketTransport

**Create:** `src/core/messaging/transports/WebSocketTransport.ts`

- For server mode WebSocket clients
- `sendOp()` → `ws.send(JSON.stringify({ type: 'req', method: 'chat.send', params: { op } }))`
- `onEvent()` → `ws.onmessage` handler, filter for event frames
- `initialize()` → establish WebSocket connection, handshake
- `destroy()` → close connection

---

### T3.5 — Create UIChannelClient

**Create:** `src/core/messaging/UIChannelClient.ts`

- Constructor takes `UIChannelTransport`
- `submitOp(op, context)` — delegates to transport
- `serviceRequest<T>(service, params)` — generates requestId, sends `ServiceRequest` Op, returns Promise
- `onEvent(type, handler)` — registers event listener, returns unsubscribe
- `initialize()` — initializes transport, sets up event listener for `ServiceResponse` correlation
- `destroy()` — rejects pending requests, cleans up transport
- Pending request map with 30s timeout

---

### T3.6 — Unit tests for UIChannelClient

**Create:** `src/core/messaging/__tests__/UIChannelClient.test.ts`

Test cases:
- `submitOp()` delegates to transport
- `serviceRequest()` sends ServiceRequest Op with requestId
- `serviceRequest()` resolves when matching ServiceResponse arrives
- `serviceRequest()` rejects on timeout (30s)
- `serviceRequest()` rejects on error ServiceResponse
- `onEvent()` dispatches non-ServiceResponse events to handlers
- `destroy()` rejects all pending requests
- Multiple concurrent service requests resolve independently

---

### T3.7 — Create transport index and factory

**Create:** `src/core/messaging/transports/index.ts`

- Export all transports
- Export `createTransport()` factory that uses `__BUILD_MODE__` to select the right transport:
  - `'extension'` → `ChromeExtensionTransport`
  - `'desktop'` → `TauriTransport`
  - `'server'` → `WebSocketTransport` (or null if no UI)

---

### T3.8 — Update messaging index with UIChannelClient

**File:** `src/core/messaging/index.ts`

- Add `UIChannelClient` and `createTransport` exports
- Add `getUIClient()` singleton factory:
  ```typescript
  let _client: UIChannelClient | null = null;
  export function getUIClient(): UIChannelClient {
    if (!_client) {
      const transport = createTransport();
      _client = new UIChannelClient(transport);
    }
    return _client;
  }
  ```

---

### T3.9 — Add compatibility shim in webfront messaging

**File:** `src/webfront/lib/messaging.ts`

- Add `messageTypeToServicePath(type: MessageType): string | null` mapping function
- Update `sendMessage()` to use `getUIClient().serviceRequest()` for mapped types
- For unmapped types, keep existing behavior (temporary)

**Acceptance:** Existing UI components work without changes. They call `sendMessage(MessageType.MCP_GET_SERVERS)` which internally routes through `UIChannelClient.serviceRequest('mcp.getServers')`.

---

## Phase 4: Remove RepublicAgent's MessageRouter Dependency

### T4.1 — Replace `updateState()` with `StateUpdate` EventMsg

**File:** `src/core/RepublicAgent.ts`

- Remove `MessageRouter` import
- Remove `router: MessageRouter` from constructor parameter
- Remove `private messageRouter: MessageRouter` field
- Replace all `this.messageRouter.updateState({...})` calls (lines ~470, ~529, ~552) with:
  ```typescript
  this.emitEvent({ type: 'StateUpdate', data: { sessionId, tabId } });
  ```

**Acceptance:** TypeScript compiles. Agent emits `StateUpdate` events instead of calling `messageRouter.updateState()`.

---

### T4.2 — Map ResponseEvent to EventMsg

**File:** `src/core/RepublicAgent.ts` (or wherever ResponseEvent is generated)

- Instead of relying on `MessageRouter.sendTypedResponseEvent()` and specific `MessageType.RESPONSE_*` mappings, convert `ResponseEvent` variants into the core `EventMsg` variants (e.g. `AgentMessageDelta`, `AgentReasoningDelta`, `WebSearchBegin`, etc.) before dispatching via `this.emitEvent(...)`.

**Acceptance:** Streaming events properly flow through the ChannelAdapter pipeline as `EventMsg` variants instead of dedicated `MessageType` enums.

---

### T4.3 — Update Chrome Extension bootstrap

**File:** `src/extension/background/service-worker.ts`

- Stop creating `MessageRouter` instance (or keep temporarily for the remaining setupXxxMessageHandlers)
- Stop passing `router` to `RepublicAgent` constructor
- Handle `StateUpdate` EventMsg in the event forwarding path if needed

---

### T4.3 — Update Desktop bootstrap

**File:** `src/desktop/agent/DesktopAgentBootstrap.ts`

- Remove `DesktopMessageRouter` creation (`this.messageRouter = new DesktopMessageRouter(...)`)
- Stop passing `this.messageRouter as any` to `RepublicAgent` constructor
- Remove `DesktopMessageRouter` import
- Remove `pi:message` event listener from TauriMessageService (no longer emitted)

---

### T4.4 — Update Server bootstrap

**File:** `src/server/agent/ServerAgentBootstrap.ts`

- Remove `ServerMessageRouter` creation
- Stop passing `this.messageRouter as any` to `RepublicAgent` constructor
- Remove `ServerMessageRouter` import
- Remove event sink wiring

---

### T4.5 — Update AgentRegistry

**File:** `src/core/registry/AgentRegistry.ts`

- Update any `RepublicAgent` instantiation to not pass `MessageRouter`

---

## Phase 5: Migrate UI Components

Update Svelte components to use `UIChannelClient` directly instead of `sendMessage(MessageType.X)`.

### T5.1 — Migrate MCP settings

**File:** `src/webfront/settings/MCPSettings.svelte`

- Replace `sendMessage(MessageType.MCP_GET_SERVERS)` → `getUIClient().serviceRequest('mcp.getServers')`
- Replace all MCP_* message type calls with corresponding service requests
- Remove `MessageType` imports for migrated types

---

### T5.2 — Migrate A2A settings

**File:** `src/webfront/settings/A2ASettings.svelte`

- Replace all `A2A_*` message type calls with `a2a.*` service requests

---

### T5.3 — Migrate Skills page

**File:** `src/webfront/pages/skills/Skills.svelte`

- Replace all `SKILLS_*` message type calls with `skills.*` service requests

---

### T5.4 — Migrate Scheduler components

**Files:**
- `src/webfront/pages/scheduler/Scheduler.svelte`
- `src/webfront/components/scheduler/*.svelte`

- Replace all `SCHEDULER_*` message type calls with `scheduler.*` service requests

---

### T5.5 — Migrate Vault components

**Files:**
- `src/webfront/stores/vaultStore.ts`
- `src/webfront/components/vault/*.svelte`

- Replace all `VAULT_*` and `PIN_*` message type calls with `vault.*` service requests

---

### T5.6 — Migrate session/state calls

**Files:**
- `src/webfront/settings/GeneralSettings.svelte`
- Any component using `GET_STATE`, `SESSION_RESET`, `RESUME_SESSION`, `SESSION_LIST`, `SESSION_GET_ACTIVE_COUNT`

- Replace with `session.*` service requests

---

### T5.7 — Migrate agent/health calls

**Files:**
- `src/webfront/App.svelte`
- Any component using `HEALTH_CHECK`, `INTERRUPT`, `CONFIG_UPDATE`, `INIT_AUTH`

- Replace with `agent.*` service requests

---

### T5.8 — Migrate chat page event listening

**File:** `src/webfront/pages/chat/Main.svelte`

- Replace `messageService.on(MessageType.EVENT, handler)` with `getUIClient().onEvent('AgentMessage', handler)` etc.
- Replace `messageService.on(MessageType.RESPONSE_OUTPUT_TEXT_DELTA, handler)` with `getUIClient().onEvent('AgentMessageDelta', handler)`
- Remove MessageType imports

---

### T5.9 — Migrate built-in commands

**File:** `src/webfront/commands/builtinCommands.ts`

- Replace any `sendIpcMessage` / `sendMessage` calls with service requests

---

### T5.10 — Migrate storage calls

**Files:** Any component using `STORAGE_GET` / `STORAGE_SET`

- Replace with `storage.get` / `storage.set` service requests

---

## Phase 6: Delete Legacy Code

### T6.1 — Delete MessageRouter

**Delete:** `src/core/MessageRouter.ts`

- Remove the 152-value `MessageType` enum, `ExtensionMessage`, `MessageResponse`, `MessageRouter` class, `createRouter()`
- Update `src/core/index.ts` or any barrel exports

**Fix imports:** Search for all files importing from `@/core/MessageRouter` or `'../../core/MessageRouter'` and remove/replace.

---

### T6.2 — Delete DesktopMessageRouter

**Delete:** `src/desktop/channels/DesktopMessageRouter.ts`

- Remove all imports referencing this file

---

### T6.3 — Delete ServerMessageRouter

**Delete:** `src/server/channels/ServerMessageRouter.ts`

- Remove all imports referencing this file

---

### T6.4 — Delete ChromeMessageService

**Delete:** `src/core/messaging/ChromeMessageService.ts`

- Remove from `src/core/messaging/index.ts` exports

---

### T6.5 — Delete TauriMessageService

**Delete:** `src/core/messaging/TauriMessageService.ts`

- Remove from `src/core/messaging/index.ts` exports
- Remove usage in `src/desktop/ui/main.ts`

---

### T6.6 — Clean up IMessageService interface

**File:** `src/core/messaging/types.ts`

- Remove `IMessageService` interface (replaced by `UIChannelClient`)
- Remove `MessageHandler`, `Unsubscribe`, `ConnectionState`, `MessageServiceConfig` if only used by deleted classes
- Keep any types still referenced

---

### T6.7 — Remove compatibility shim

**File:** `src/webfront/lib/messaging.ts`

- Remove `messageTypeToServicePath()` mapping
- Remove `sendMessage()` shim function
- Remove `MessageType` re-export
- If file is empty after cleanup, delete it

---

### T6.8 — Replace DOM_CAPTURE usage in content scripts

**Files:** `src/extension/content/**/*.ts` (or wherever DOM_CAPTURE is used)

- Since `MessageType` is being deleted, replace `MessageType.DOM_CAPTURE_REQUEST` and `MessageType.DOM_CAPTURE_RESPONSE` with local string literals (`'DOM_CAPTURE_REQUEST'`) to ensure content-script logic doesn't break.

---

### T6.9 — Remove setupXxxMessageHandlers from service-worker

**File:** `src/extension/background/service-worker.ts`

- Delete `setupMCPMessageHandlers()`
- Delete `setupSchedulerMessageHandlers()`
- Delete `setupVaultMessageHandlers()`
- Delete `setupSkillsMessageHandlers()`
- Delete `setupA2AMessageHandlers()`
- Delete `setupSessionMessageHandlers()`
- Delete any other `setupXxx` functions that registered MessageRouter handlers
- Remove the `MessageRouter` instantiation and all `router.on(...)` calls

---

### T6.9 — Delete legacy tests

**Delete:**
- `src/core/__tests__/MessageRouter.test.ts`
- `src/core/__tests__/MessageRouter-ResponseEvent.test.ts`
- `src/core/__tests__/message-communication.integration.test.ts`
- `src/core/messaging/__tests__/ChromeMessageService.test.ts`
- `src/core/messaging/__tests__/TauriMessageService.test.ts`

---

### T6.11 — Final cleanup and verification

- Run `npm test && npm run lint` — all tests pass
- Run TypeScript compiler — no errors
- Search codebase for any remaining references to `MessageRouter`, `MessageType`, `ChromeMessageService`, `TauriMessageService`, `DesktopMessageRouter`, `ServerMessageRouter` — should be zero
- Verify no dead imports or unused files

---

## Phase 7: Verification

### T7.1 — Write Integration Tests

**Create/Update Integration Tests:**

- Implement full-pipeline integration tests corresponding to the 3 platforms:
  - Chrome Extension (`Frontend → SidePanelChannel → ChannelManager → ServiceRegistry → ServiceResponse → Frontend`)
  - Desktop (`Frontend → TauriChannel → ChannelManager → ServiceRegistry → ServiceResponse → Frontend`)
  - Server (`WebSocket client → ServerChannel → ChannelManager → ServiceRegistry → ServiceResponse → client`)

### T7.2 — Execute Manual Verification Plan

**Perform Manual Testing Sweeps:**

- Verify MCP settings page works identically across Extension, Desktop, and Server.
- Verify Scheduler task management functions correctly across all platforms.
- Verify Skills CRUD operations (list, load, save, delete) execute completely.
- Verify Vault locking, unlocking, and status operations succeed.
- Verify core Conversation flows (submissions, streaming, approvals) work smoothly without regression.

---

## Task Dependency Graph

```
Phase 1 (foundation):
  T1.1 ──┐
  T1.2 ──┤
  T1.3 ──┼──→ T1.4 ──→ T1.5 ──→ T1.6
         │
Phase 2 (services):    depends on Phase 1
  T2.1 ──┐
  T2.2 ──┤
  T2.3 ──┤
  T2.4 ──┤
  T2.5 ──┼──→ T2.9 ──→ T2.10
  T2.6 ──┤              T2.11  (parallel with T2.10)
  T2.7 ──┤              T2.12  (parallel with T2.10)
  T2.8 ──┘

Phase 3 (UI client):   depends on Phase 1
  T3.1 ──→ T3.2 ──┐
            T3.3 ──┼──→ T3.5 ──→ T3.6 ──→ T3.7 ──→ T3.8 ──→ T3.9
            T3.4 ──┘

Phase 4 (agent):       depends on Phase 2
  T4.1 ──→ T4.2 ──┐
            T4.3 ──┤ (parallel)
            T4.4 ──┤
            T4.5 ──┘

Phase 5 (UI migrate):  depends on Phase 3 + Phase 2
  T5.1 through T5.10 (all parallel, independent per component)

Phase 6 (cleanup):     depends on Phase 4 + Phase 5
  T6.1 ──┐
  T6.2 ──┤
  T6.3 ──┤
  T6.4 ──┼──→ T6.6 ──→ T6.7 ──→ T6.10
  T6.5 ──┤
  T6.8 ──┤
  T6.9 ──┘
```

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 | T1.1–T1.6 | Add ServiceRequest/ServiceResponse types, ServiceRegistry, ChannelManager routing |
| 2 | T2.1–T2.12 | Extract service handlers into shared modules, register on all platforms |
| 3 | T3.1–T3.9 | Create UIChannelClient, platform transports, compatibility shim |
| 4 | T4.1–T4.6 | Remove RepublicAgent's MessageRouter dependency |
| 5 | T5.1–T5.10 | Migrate all UI components to UIChannelClient |
| 6 | T6.1–T6.11 | Delete MessageRouter, shims, old services, legacy tests |
| 7 | T7.1–T7.2 | Final Integration testing and Manual Verification sweeps |
| **Total** | **45 tasks** | |
