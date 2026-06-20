# Apple Pi Server Mode Execution Tasks

This document tracks the detailed implementation tasks for Server Mode and OpenClaw plugin compatibility, based on the [server_mode_design.md](./server_mode_design.md).

## Phase 1: Foundations & Core Refactoring
Goal: Prepare the existing codebase for multi-transport support.

- [ ] **Refactor `MessageRouter`**
    - [ ] Create `src/core/MessageRouter.ts` as an interface.
    - [ ] Rename current class to `ChromeMessageRouter` in `src/core/MessageRouter.ts` (or move to its own file).
    - [ ] Update all background/content script imports to use the new naming.
- [ ] **Define Protocol Types**
    - [ ] Implement `src/server/protocol/frames.ts` containing `RequestFrame`, `ResponseFrame`, and `EventFrame` interfaces.
    - [ ] Create Zod/TypeBox schemas for frame validation.
- [ ] **Update Project Config**
    - [ ] Add necessary dependencies to `package.json` (`ws`, `better-sqlite3`, `zod`, `dotenv`, `@opentelemetry/api`).
    - [ ] Add `npm run server` and `npm run server:dev` scripts.

## Phase 2: WebSocket Server & RBAC
Goal: Implement the communication and permission layer.

- [ ] **Implement `ServerMessageRouter`**
    - [ ] Implement the `MessageRouter` interface using a WebSocket transport.
    - [ ] Handle message serialization/deserialization into protocol frames.
- [ ] **Implement Handshake & Auth**
    - [ ] Create the `connect.challenge` and `connect` request/response flow.
    - [ ] Implement Handshake Timeout (10s) and Unauthorized Flood Guard.
    - [ ] Implement Auth modes: Token, Password, and Trusted-Proxy.
- [ ] **RBAC Enforcement**
    - [ ] Implement Role/Scope registry and method-level authorization check.
    - [ ] Implement Event Scope Guards (filtering events by client scope).
- [ ] **Network Policy**
    - [ ] Implement Bind policies (loopback, lan, tailnet) and optional TLS.

## Phase 3: Streaming & Agent Lifecycle
Goal: Real-time agent feedback and control.

- [ ] **Streaming Response Protocol**
    - [ ] Implement `ChatEvent` and `AgentEvent` streams with monotonic sequence numbers.
    - [ ] Implement **Delta Throttling** (150ms) to prevent UI flooding.
    - [ ] Implement `chat.send` acknowledgment and `chat.abort` logic.
- [ ] **Execution Approvals**
    - [ ] Implement `ApprovalManager` for manual tool execution gates.
    - [ ] Implement operator notification and resolution protocol events.
- [ ] **Develop `ServerAgentBootstrap`**
    - [ ] Create entry point at `src/server/bootstrap.ts`.
    - [ ] Wire up `RepublicAgent` with the new transport and maintenance timers.

## Phase 4: Session & Persistence
Goal: Reliable, file-based state management.

- [ ] **Implement SQLite Session Index**
    - [ ] Create `src/server/persistence/SessionIndex.ts` for fast listing/querying.
- [ ] **Implement JSONL Transcript Storage**
    - [ ] Create `src/server/persistence/TranscriptStore.ts` with write-ahead logic.
- [ ] **Session Lifecycle & Limits**
    - [ ] Implement `sessions.compact` (truncation) and stale session reaper.
    - [ ] Implement **Unified Agent Memory** (state locking across channels).
- [ ] **Backup & Recovery**
    - [ ] Implement automatic daily backups and SQLite index rebuild logic.

## Phase 5: OpenClaw Plugin Integration
Goal: Connectivity through third-party platform plugins.

- [ ] **Implement `ConnectorBridge`**
    - [ ] Build the bridge between OpenClaw adapters and Pi's `ChannelManager`.
    - [ ] Implement **Worker Thread isolation** and IPC for plugins.
- [ ] **Plugin Registry & Discovery**
    - [ ] Implement dynamic loading from `extensions/` and npm packages.
    - [ ] Implement plugin health monitoring and auto-restart supervisor.
- [ ] **Native Commands**
    - [ ] Implement `/pi` slash command routing in the channel adapter.

## Phase 6: Security & 1:1 Identity
Goal: Harden the agent for private deployment.

- [ ] **Owner Identity Verification**
    - [ ] Implement `owner.identities` mapping and **Static Whitelisting**.
    - [ ] Implement pairing request flow for unverified senders (if enabled).
- [ ] **CLI Identity Tool**
    - [ ] Create `scripts/workx-identity.js` for local management of platform IDs.
- [ ] **Resource Limits & Guardrails**
    - [ ] Implement concurrency limits (max runs/sub-agents).
    - [ ] Implement message queue policies (`summarize` on overflow) and deduplication.

## Phase 7: Tooling & Headless Chrome
Goal: Full browser capabilities in a server environment.

- [ ] **Node MCP Implementation**
    - [ ] Update `MCPManager` to use `@modelcontextprotocol/sdk` Stdio transport.
- [ ] **Headless Chromium Integration**
    - [ ] Create `scripts/install-chromium.sh` and ensure `--headless` flags.
    - [ ] Implement graceful degradation if browser features are missing.

## Phase 8: Deployment & Observability
Goal: Final packaging and monitoring.

- [ ] **OpenTelemetry Setup**
    - [ ] Implement OTLP tracing/metrics and structured JSON logging.
    - [ ] Implement `/health` endpoint and `logs.tail` protocol.
- [ ] **Containerization**
    - [ ] Finalize `Dockerfile` (with Chromium deps) and `docker-compose.yml`.
- [ ] **Graceful Shutdown**
    - [ ] Implement sequence: plugin stop -> run drain -> flush -> exit.

## Phase 9: Shared Package & Verification
- [ ] **Extract `@applepi/ws-server`**
    - [ ] Move protocol and server logic to a shared internal package.
- [ ] **Verification**
    - [ ] E2E integration tests for Slack/WhatsApp and 1:1 security verification.
- [ ] **Documentation**
    - [ ] Finalize deployment guides and environment variable reference.
