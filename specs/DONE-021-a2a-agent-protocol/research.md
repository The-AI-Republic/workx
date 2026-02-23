# Research: A2A Agent-to-Agent Protocol Integration

**Date**: 2026-02-15
**Feature**: 021-a2a-agent-protocol

## Decision 1: A2A SDK Package

**Decision**: Use `@a2a-js/sdk` (v0.3.10) with the new `ClientFactory` + `Client` API.

**Rationale**: The official TypeScript SDK provides browser-compatible JSON-RPC and HTTP+JSON transports using standard `fetch()`. The new `Client` API returns unwrapped results (Message | Task) instead of raw JSON-RPC envelopes, which is cleaner to work with. The package is ESM-only, compatible with the project's Vite build. Single runtime dependency: `uuid`.

**Alternatives considered**:
- Legacy `A2AClient` class: Still functional but deprecated. Uses raw JSON-RPC response envelopes requiring manual unwrapping.
- Raw HTTP/JSON-RPC implementation: Maximum control but duplicates SDK work. The protocol is complex enough (streaming SSE, error codes, agent card discovery) to warrant SDK use.
- gRPC transport: Node.js only, not browser-compatible. Excluded per spec assumption.

## Decision 2: Transport Protocol

**Decision**: Use JSON-RPC transport as primary, with automatic fallback to HTTP+JSON/REST based on agent card declaration.

**Rationale**: JSON-RPC is the A2A protocol's default transport (`preferredTransport: 'JSONRPC'`). The `ClientFactory` automatically selects the best transport by reading the agent card's `preferredTransport` and `additionalInterfaces` fields. Both JSON-RPC and REST transports are built into the default `ClientFactory` — no configuration needed. Both use standard `fetch()` and are fully browser-compatible.

**Alternatives considered**:
- REST-only: Simpler but some agents may only expose JSON-RPC.
- gRPC: Not browser-compatible, excluded.

## Decision 3: Module Architecture

**Decision**: Mirror the existing MCP module architecture exactly, placing code at `src/core/a2a/`.

**Rationale**: The MCP module (`src/core/mcp/`) already solves the same problem space — singleton manager, connection lifecycle, tool adaptation, storage, event-driven registration, platform abstraction. Following the same pattern ensures:
- Consistent developer experience
- Proven architecture for dual-platform (extension + desktop)
- Familiar code for maintainers
- Reuse of existing patterns (encryption, storage, message routing, tool registry)

**Alternatives considered**:
- Unified MCP+A2A manager: Would conflate two different protocols with different lifecycles and capabilities. MCP tools vs A2A tasks have fundamentally different interaction models.
- Plugin architecture: Over-engineered for two protocols. Can be refactored later if more protocols are added.

## Decision 4: Authentication Implementation

**Decision**: Wrap `fetch()` with authentication headers based on stored credentials. Support API key (header injection) and bearer token (Authorization header) at minimum.

**Rationale**: The A2A SDK accepts a custom `fetchImpl` parameter on both `A2AClient` and `ClientFactory`. This aligns with how the SDK expects auth to be handled:
```typescript
const authFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  return fetch(input, { ...init, headers });
};
```
This approach works in both browser (extension service worker) and desktop (Tauri webview) contexts.

**Alternatives considered**:
- SDK's `AuthenticationHandler` interface: More complex, supports 401 retry with token refresh. Overkill for API keys and bearer tokens. Can be adopted later if OAuth2 support is needed.
- Per-request auth from agent card `securitySchemes`: Would require parsing each agent's security scheme declaration. Good for future enhancement but unnecessary for MVP.

## Decision 5: Tool Naming Convention

**Decision**: Use `${agentName}__${skillId}` (double underscore separator), matching the MCP tool naming convention.

**Rationale**: The MCP module already uses `serverName__toolName` as the separator pattern. Using the same separator ensures consistent behavior across the tool registry, approval system, and LLM tool invocation. The double underscore avoids conflicts with hyphens/colons in agent names.

**Alternatives considered**:
- Colon separator (`agent:skill`): More readable but some LLM APIs restrict tool names to `[a-zA-Z0-9_-]`. The spec mentions colon, but the MCP implementation uses double underscore for this reason.
- Slash separator (`agent/skill`): Could conflict with path-like names.

## Decision 6: Context ID Lifecycle

**Decision**: Generate one `contextId` per remote agent per conversation session. Store in a `Map<agentName, contextId>` within the A2AManager, cleared when conversation session ends.

**Rationale**: Per the clarification, all invocations to the same remote agent within a conversation should share a contextId. This enables multi-turn interactions where the remote agent can reference prior exchanges. The contextId is a UUID generated on first invocation and reused for subsequent calls to the same agent within the session.

**Alternatives considered**:
- Global contextId across all agents: Would leak context between unrelated agents.
- Per-invocation contextId: Loses multi-turn capability, which is a core A2A protocol feature.

## Decision 7: Streaming Implementation

**Decision**: Use the SDK's `client.sendMessageStream()` which returns an `AsyncGenerator<A2AStreamEventData>`. Process events (status-update, artifact-update, message, task) and surface them to the UI via the existing channel/messaging architecture.

**Rationale**: The SDK handles SSE parsing and event typing. The `AsyncGenerator` pattern integrates naturally with async iteration. Streaming is conditionally used based on the agent card's `capabilities.streaming` field. When not supported, `sendMessage()` with `blocking: true` is used instead.

**Alternatives considered**:
- Raw SSE via EventSource: More control but duplicates SDK work. The SDK already handles reconnection, error parsing, and event typing.
- Push notifications via webhooks: Requires a reachable endpoint (complex for browser extensions). Better suited for P3 server mode.

## Decision 8: Approval System Integration

**Decision**: Register a custom `IRiskAssessor` for A2A tools that defaults to medium risk (score 45). Per-agent trust is implemented as a boolean flag on the remote agent configuration; trusted agents get risk score lowered to 10 (auto-approve).

**Rationale**: A2A skill invocations cross a network boundary to external services, warranting user approval by default. The existing approval system supports custom risk assessors per tool registration. A score of 45 (medium risk) triggers "ask_user" in balanced mode, while a score of 10 (low risk) auto-approves. The trust flag is persisted in the agent configuration alongside other settings.

**Alternatives considered**:
- Always auto-approve: Unsafe for external service calls.
- Always ask: Poor UX for trusted, frequently-used agents.
- Per-skill trust: Too granular for initial implementation. Can be added later.

## Decision 9: Server Mode (P3) Architecture

**Decision**: Defer detailed server design to implementation phase. High-level approach: use an HTTP server (Express-like for desktop, service worker fetch handler for extension) to expose the A2A JSON-RPC endpoint and agent card.

**Rationale**: Server mode is P3 priority. The `@a2a-js/sdk/server` package provides `DefaultRequestHandler` and `InMemoryTaskStore` for handling incoming requests. On desktop Pi, a local HTTP server (e.g., via Tauri's HTTP plugin or a bundled micro-server) can bind to a configurable port. On browserx, the service worker can intercept fetch events for the agent card path, but full JSON-RPC server in a service worker has limitations (no persistent connections for SSE). This needs more design when P3 is prioritized.

**Alternatives considered**:
- Skip server mode entirely: Limits the feature to one-way delegation. Keeping it as P3 maintains the option.
- WebSocket server: More complex than JSON-RPC over HTTP, not aligned with A2A spec.
