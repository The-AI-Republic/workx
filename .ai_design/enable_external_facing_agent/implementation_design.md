# Enable External-Facing Agent — Implementation Design

**Status:** Ready for implementation
**Date:** 2026-03-18
**Decision:** New repo in TypeScript, transplant SQ/EQ architecture and model clients from BrowserX

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User & Tenancy Model](#3-user--tenancy-model)
4. [Architecture](#4-architecture)
5. [Core Agent Design](#5-core-agent-design)
6. [Multi-Tenant Isolation](#6-multi-tenant-isolation)
7. [Resource Access Control](#7-resource-access-control)
8. [API Specification](#8-api-specification)
9. [Security](#9-security)
10. [Storage](#10-storage)
11. [Scaling Strategy](#11-scaling-strategy)
12. [Configuration](#12-configuration)
13. [Deployment](#13-deployment)
14. [Implementation Checklist](#14-implementation-checklist)

---

## 1. Overview

**digitalme-agent** is an external-facing AI agent that creators deploy behind the DigitalMe platform. Fans interact with creator-controlled AI personas through the DigitalMe mobile app.

### Why a new repo (not a fork)

digitalme-agent is a **new repository** that transplants key patterns from BrowserX while stripping everything that doesn't apply. We don't fork because BrowserX's multi-platform build system, extension/desktop code, and UI would be dead weight — but we adopt its proven architecture:

| What | From BrowserX | Adapted for digitalme-agent |
|------|--------------|----------------------------|
| **SQ/EQ pattern** | Serial processing (one user) | **Concurrent dispatch** (many fans) |
| **Model clients** | OpenAI, Anthropic, Google, etc. | Same, copied directly |
| Platform support | Extension, desktop, server | **Server only** |
| Trust model | Single user (trusted) | Multi-tenant (fans untrusted) |
| Turn execution | Complex state machine (Session, TurnManager) | Lightweight per-submission turn |
| Tool system | Registry with risk assessment + approval | Simple allowlist |
| Approval | Interactive workflows | Creator pre-approves at deploy time |
| MCP | Full support | Future, with restrictions |

**BrowserX is ~15,000+ lines. digitalme-agent will be ~6,000 lines (~3,500 copied directly, ~1,200 adapted, ~1,300 new).**

### What we transplant from BrowserX

| Component | Lines | Adaptation needed |
|-----------|-------|-------------------|
| **SQ/EQ architecture** | Pattern, not code | Serial → concurrent dispatch, add backpressure/cancellation |
| **Model clients** | ~500 | Remove approval hooks, keep streaming + tool call handling |
| **EventQueue concept** | ~30 | Simplified — per-request async iterable, no channel routing |

### Why TypeScript

| Consideration | TypeScript | Python | Rust |
|---------------|------------|--------|------|
| MCP servers available | ~100+ | ~20-30 | ~5-10 |
| LLM SDK maturity | Good | Best | Limited |
| BrowserX model clients | Ready to copy | Rewrite | Rewrite |
| Development speed | Fast | Fast | Slower |
| Concurrency for I/O | async/await | asyncio | Native threads |
| Our workload (I/O bound) | Fine | Fine | Overkill |

For I/O-bound LLM API calls, both TypeScript and Python have equivalent async models. TypeScript wins on MCP ecosystem and code reuse.

### Core insight

**LLMs are stateless.** The model has no memory between API calls. Every response from ChatGPT, Claude, or any LLM service works the same way:

```
Fan: "What's the latest news about Taylor Swift?"

1. Server loads conversation history from database
2. Server sends [system prompt + full history + fan message] to the model
3. Model decides to use a tool → calls web_search("Taylor Swift news")     ← LLM call 1
4. Server executes tool, appends result to local message array
5. Server sends [same context + tool result] back to model
6. Model decides to fetch more → calls web_fetch(url)                      ← LLM call 2
7. Server executes tool, appends result to local message array
8. Server sends [same context + both tool results] back to model
9. Model generates final text response → streamed to fan                   ← LLM call 3
10. Server persists fan message + final response to database
11. Server discards local message array, TurnContext — everything
```

A single fan message can trigger **multiple LLM calls** (the ReAct loop: Reason → Act → Observe → repeat). The intermediate state — tool calls and tool results — accumulates in a **local `messages` array** inside the TurnContext. This local state exists only for the duration of the request.

**Two levels of statelessness:**
- **Between requests** — fully stateless. History loaded from DB, nothing kept in memory. This is how ChatGPT serves 100M+ users.
- **Within a request** — local state accumulates during the ReAct loop (tool calls + results), then is discarded. Capped by `maxTurns` (default: 10) to prevent runaway chains.

Only the fan message and final response are persisted to the database. The intermediate tool calls are streamed to the fan as events (`tool_start`, `tool_end`) so the UI can show progress, but they don't need to be stored.

### Architecture: SQ/EQ with concurrent dispatch

On top of that stateless foundation, digitalme-agent adds BrowserX's SQ/EQ pattern for operational control:

```
Fan message → Submission Queue → Concurrent Dispatch → Turn Execution (ReAct loop) → Event Queue → SSE stream
```

The agent instance is long-lived but each fan request is stateless:
1. Fan message enters the Submission Queue
2. SQ dispatches concurrently (not serial — many fans in flight)
3. Turn execution loads conversation history from DB, runs the ReAct loop (multiple LLM calls + tool executions as needed)
4. Events (text deltas, tool status, done) route through the Event Queue back to the fan's SSE stream
5. Fan message + final response persisted to DB, TurnContext discarded

**Shared infrastructure (model clients, config, DB pool) + isolated execution (per-request TurnContext with local ReAct state) = efficiency + safety.**

---

## 2. Goals & Non-Goals

### Goals

- Build `digitalme-agent` as a new repository, transplanting SQ/EQ pattern and model clients from BrowserX
- **Docker/server mode only** — no browser extension, no desktop app
- Implement the DigitalMe platform agent endpoint protocol
- **Multi-tenant by design** — one deployment serves many fans
- **Isolation by architecture** — not by access control checks
- Per-fan conversation isolation with strict resource boundaries
- Enable creators to deploy via Docker with minimal configuration
- Ship MVP in days, not weeks
- **Design for horizontal scaling** from day one

### Non-Goals

- Code sharing with BrowserX at package level
- Browser extension or desktop app
- Building a UI — the DigitalMe mobile app IS the UI
- MCP support in MVP (future consideration)
- Complex tool orchestration
- Cross-conversation memory (per-fan fact extraction + injection — future design)
- Running untrusted creator code (MVP)

### Runtime constraint

**digitalme-agent runs as a headless Docker/Node.js server only.**

The DigitalMe mobile app provides the user interface. The agent is a backend service that creators deploy and the platform connects to.

### MVP scope

- **In scope:** HTTP server, HMAC auth, SSE streaming, multi-tenant isolation, conversation persistence, web search tool, Docker deployment
- **Out of scope:** Creator dashboard, sandboxed browser, MCP, custom creator code, horizontal scaling infrastructure (but designed for it)

---

## 3. User & Tenancy Model

### Deployment model

**One long-lived agent instance per creator, serving many fans concurrently via SQ/EQ:**

```
┌─────────────────────────────────────────────────────────────────┐
│              ONE Agent Instance (per Creator, long-lived)        │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │              Agent (shared, read-only / stateless)        │   │
│   │  • Model client (pooled connections, stateless calls)    │   │
│   │  • Persona config + system prompt (read-only)            │   │
│   │  • Tool definitions (read-only allowlist)                │   │
│   │  • DB connection pool                                    │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                    Submission Queue (SQ)                         │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│   │ TurnContext   │  │ TurnContext   │  │ TurnContext   │        │
│   │ (Fan A)       │  │ (Fan B)       │  │ (Fan A)       │        │
│   │ conv_id=aaa   │  │ conv_id=bbb   │  │ conv_id=ccc   │        │
│   │ history:[...] │  │ history:[...] │  │ history:[...] │        │
│   │ ↓             │  │ ↓             │  │ ↓             │        │
│   │ EQ(A) → SSE   │  │ EQ(B) → SSE   │  │ EQ(C) → SSE   │        │
│   └──────────────┘  └──────────────┘  └──────────────┘         │
│              │               │               │                  │
│              └───────────────┴───────────────┘                  │
│                              │                                   │
│                              ▼                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Shared Storage                         │   │
│   │  • SQLite/Postgres (all conversations, all fans)         │   │
│   │  • Isolated by conversation_id / fan_user_id in queries  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Resource allocation

| What | How many |
|------|----------|
| Docker container | 1 per creator |
| HTTP server | 1 per container |
| **Agent instance** | **1 per container (long-lived)** |
| Database | 1 per container (all fans' data) |
| TurnContext | 1 per request (ephemeral, GC'd after) |
| EventQueue | 1 per request (routes events → SSE stream) |
| Fans | Many, concurrent via SQ dispatch |

### Three principals

| Principal | Role | Trust level |
|-----------|------|-------------|
| **Creator** | Configures agent at deploy time | Trusted — full control |
| **Platform** | Routes messages, enforces auth | Trusted intermediary |
| **Fan** | Sends messages, receives responses | **Untrusted — sandboxed tenant** |

### What fans CAN do

- Start new conversations
- Send messages in their conversations
- View their own conversation history
- Use creator-approved tools (within sandbox)

### What fans CANNOT do

| Forbidden action | Why | Enforcement |
|------------------|-----|-------------|
| See other fans' conversations | Privacy | DB queries scoped by `fan_user_id` |
| Access creator's resources | Security | No filesystem/shell/browser tools |
| Modify agent behavior | Security | System prompt is read-only |
| Bypass rate limits | Fairness | Rate limit by `fan_user_id` |
| Execute arbitrary tools | Security | Tool allowlist, no dynamic registration |
| Inject prompts | Security | Input filtering |
| Access agent internals | Security | Only expose text responses via SSE |

---

## 4. Architecture

### Repository structure

```
digitalme-agent/
├── src/
│   ├── index.ts                 # Entry point, bootstrap agent + server
│   ├── server.ts                # Hono HTTP server
│   │
│   ├── routes/
│   │   ├── health.ts            # GET /health
│   │   ├── verify.ts            # POST /verify
│   │   └── conversations.ts     # Conversation endpoints
│   │
│   ├── middleware/
│   │   ├── hmac.ts              # HMAC-SHA256 auth
│   │   └── rate-limit.ts        # Per-fan rate limiting
│   │
│   ├── agent/
│   │   ├── Agent.ts             # Long-lived agent instance (SQ/EQ)
│   │   ├── SubmissionQueue.ts   # Fan message intake + concurrent dispatch
│   │   ├── EventQueue.ts        # Per-request event routing to SSE stream
│   │   ├── TurnExecutor.ts      # Stateless turn: history → LLM → tools → events
│   │   ├── TurnContext.ts       # Per-request isolation boundary
│   │   ├── shutdown.ts          # Graceful shutdown (drain + close)
│   │   └── types.ts             # Submission, AgentEvent, TurnContext types
│   │
│   ├── models/
│   │   ├── ModelClient.ts       # Base interface (from browserx)
│   │   ├── ModelClientFactory.ts # Provider factory (from browserx)
│   │   ├── ModelClientError.ts  # Error types (from browserx)
│   │   ├── ResponseStream.ts    # Streaming response handler (from browserx)
│   │   ├── SSEEventParser.ts    # SSE parsing from LLM APIs (from browserx)
│   │   ├── RequestQueue.ts      # Rate limiting + backoff (from browserx)
│   │   ├── client/              # Provider implementations (from browserx)
│   │   │   ├── openai.ts
│   │   │   ├── anthropic.ts
│   │   │   ├── google.ts
│   │   │   └── ...
│   │   └── types.ts
│   │
│   ├── tools/
│   │   ├── registry.ts          # Tool registry (static allowlist)
│   │   ├── web-search.ts        # Web search tool
│   │   └── types.ts
│   │
│   ├── safety/
│   │   ├── input-filter.ts      # Fan input validation
│   │   └── output-filter.ts     # Response filtering
│   │
│   ├── storage/
│   │   ├── db.ts                # Database interface
│   │   ├── sqlite.ts            # SQLite implementation (MVP)
│   │   ├── postgres.ts          # Postgres implementation (scale)
│   │   ├── TenantDB.ts          # Per-fan scoped DB wrapper
│   │   ├── TokenUsageStore.ts   # Token tracking (from browserx)
│   │   └── types.ts
│   │
│   ├── streaming/
│   │   ├── sse.ts               # SSE formatting + heartbeat
│   │   └── chat-stream.ts       # Delta throttling (from browserx)
│   │
│   ├── limits/
│   │   └── resource-limits.ts   # Concurrency + queue limits (from browserx)
│   │
│   ├── health/
│   │   └── health-monitor.ts    # CPU/memory/event-loop (from browserx)
│   │
│   ├── prompts/
│   │   ├── PromptComposer.ts    # Fragment-based composition (pattern from browserx)
│   │   └── fragments/           # Creator persona, safety, policies
│   │
│   └── config/
│       ├── schema.ts            # Zod validation (pattern from browserx)
│       └── loader.ts            # YAML + env var loading (pattern from browserx)
│
├── config.example.yaml
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

### What to transplant from BrowserX

After thorough inspection of the BrowserX codebase, here is the complete transplant map organized by reusability tier.

#### Tier 1: Copy directly (~3,500 lines, minimal changes)

These files are platform-agnostic and production-grade. Copy with minor cleanup.

| BrowserX source | digitalme-agent target | Lines | Changes needed |
|-----------------|----------------------|-------|----------------|
| `src/core/models/ModelClient.ts` | `src/models/ModelClient.ts` | 488 | None — base interface |
| `src/core/models/ModelClientFactory.ts` | `src/models/ModelClientFactory.ts` | 783 | Remove unused providers if desired |
| `src/core/models/ModelClientError.ts` | `src/models/ModelClientError.ts` | 517 | None |
| `src/core/models/ResponseStream.ts` | `src/models/ResponseStream.ts` | 372 | None |
| `src/core/models/SSEEventParser.ts` | `src/models/SSEEventParser.ts` | 472 | None |
| `src/core/models/RequestQueue.ts` | `src/models/RequestQueue.ts` | 604 | None — rate limiting + backoff |
| `src/core/models/client/*.ts` | `src/models/client/*.ts` | ~500 | Remove approval hooks |
| `src/server/streaming/chat-stream.ts` | `src/streaming/chat-stream.ts` | 199 | None — delta throttling |
| `src/server/connection/rate-limiter.ts` | `src/middleware/rate-limit.ts` | 155 | None — sliding window |
| `src/server/limits/resource-limits.ts` | `src/limits/resource-limits.ts` | 133 | Drop subagent tracking |
| `src/server/connection/auth.ts` | `src/middleware/auth.ts` | 156 | None — token/password modes |
| `src/server/agent/shutdown.ts` | `src/agent/shutdown.ts` | 92 | Adapt for SQ/EQ drain |
| `src/server/handlers/health.ts` | `src/routes/health.ts` | 125 | Simplify metrics |

#### Tier 2: Adapt significantly (~1,500 lines, keep core logic)

These need meaningful changes but carry proven patterns worth preserving.

| BrowserX source | digitalme-agent target | Lines | Adaptation |
|-----------------|----------------------|-------|------------|
| `src/core/TurnManager.ts` | `src/agent/TurnExecutor.ts` | 1,110 | **Keep**: turn loop, model streaming, tool execution, retry logic. **Strip**: browser tab context, MCP capability checks, approval gate calls, web search handlers. **Result**: ~400 lines |
| `src/core/QueueProcessor.ts` | `src/agent/SubmissionQueue.ts` + `EventQueue.ts` | 343 | **Keep**: PriorityQueue, async queue primitives. **Adapt**: serial dispatch → concurrent dispatch. **Split**: into two focused files |
| `src/core/TurnContext.ts` | `src/agent/TurnContext.ts` | 499 | **Keep**: model client getter, tools config. **Strip**: approval/sandbox policies, browser env policy, review mode. **Result**: ~100 lines |
| `src/server/config/server-config.ts` | `src/config/loader.ts` | 248 | **Keep**: env/file loading, Zod validation, hot-reload. **Adapt**: schema for creator config (persona, model, tools) |
| `src/server/streaming/agent-events.ts` | `src/streaming/sse.ts` | 170 | **Keep**: event → wire format conversion. **Adapt**: for SSE instead of WebSocket frames |
| `src/server/health/health-monitor.ts` | `src/health/health-monitor.ts` | 84 | **Keep**: CPU/memory/event-loop checks. **Adapt**: broadcast via SSE, add SQ depth metric |
| `src/core/prompts/PromptComposer.ts` | `src/prompts/PromptComposer.ts` | 143 | **Keep**: fragment-based composition pattern. **Rewrite**: all fragments for creator persona context |
| `src/storage/TokenUsageStore.ts` | `src/storage/TokenUsageStore.ts` | 148 | **Keep**: token tracking. **Adapt**: per-fan + per-creator aggregation |
| `src/core/protocol/types.ts` | `src/agent/types.ts` | 384 | **Cherry-pick**: Submission, InputItem, ResponseItem types. **Strip**: approval ops, sandbox policy, browser-specific types |

#### Tier 3: Pattern only (inspire, don't copy)

These are too coupled to BrowserX internals but carry useful architectural patterns.

| BrowserX source | Pattern to adopt | Why not copy directly |
|-----------------|-----------------|----------------------|
| `src/core/RepublicAgent.ts` (1,318 lines) | SQ/EQ lifecycle: queue intake → dispatch → event emission | Deeply coupled to Session, ApprovalManager, ChannelManager, serial execution |
| `src/core/Session.ts` (1,836 lines) | Event emission pattern | Stateful (accumulates history in memory), compaction, title generation |
| `src/core/tools/ToolRegistry.ts` (727 lines) | Registry + dispatch pattern | Tied to approval gate, risk assessment, browser tools |
| `src/server/agent/ServerAgentBootstrap.ts` (792 lines) | Startup/shutdown sequencing | Too complex (plugins, scheduler, multi-session registry) |
| `src/server/channels/ServerChannel.ts` (221 lines) | Event broadcasting | ChannelAdapter abstraction not needed for HTTP/SSE |

#### Tier 4: Do not transplant

| BrowserX module | Lines | Why |
|-----------------|-------|-----|
| `src/core/ApprovalManager.ts` | 546 | No approval workflows |
| `src/core/approval/*` | 990 | No risk assessment |
| `src/core/tools/DOMTool.ts`, `FormAutomationTool.ts`, `NavigationTool.ts`, etc. | 8,400+ | Browser-only tools |
| `src/core/scheduler/*` | 1,834 | No scheduled tasks |
| `src/core/compact/*` | 1,054 | No stateful history compaction |
| `src/core/TabManager.ts` | 581 | No browser tabs |
| `src/core/DiffTracker.ts` | 831 | No rollback workflows |
| `src/core/mcp/RustMCPBridge.ts` | 418 | Desktop-only Rust FFI |
| `src/server/plugins/*` | ~400 | Plugin system not needed |
| `src/server/persistence/SessionIndex.ts` | 206 | Multi-session registry not needed |
| `src/extension/*`, `src/desktop/*`, `src/webfront/*` | ~10,000+ | Wrong platform |

### Transplant summary

| Tier | Lines from BrowserX | Lines in digitalme-agent | Effort |
|------|--------------------|-----------------------|--------|
| **Tier 1** (copy) | ~3,500 | ~3,500 | Low — copy + minor cleanup |
| **Tier 2** (adapt) | ~3,100 | ~1,200 | Medium — keep core, strip platform specifics |
| **Tier 3** (pattern) | ~4,900 | ~500 | Medium — write new code following patterns |
| **New code** | — | ~800 | Routes, safety, TenantDB, docker config |
| **Total** | | **~6,000** | |

---

## 5. Core Agent Design

### SQ/EQ Architecture (adapted from BrowserX)

The agent uses BrowserX's **Submission Queue / Event Queue** pattern, adapted for concurrent multi-fan handling. One long-lived Agent instance per creator accepts fan messages via the SQ, dispatches them concurrently, and routes events back through per-request EQs.

```
                         ┌─────────────────────────────────┐
                         │     Agent (long-lived, 1/creator) │
                         │                                   │
  Fan A msg ──→ ┌────────┤  Submission Queue                 │
  Fan B msg ──→ │  SQ    │  (concurrent dispatch, not serial)│
  Fan C msg ──→ └────────┤                                   │
                         │     ┌──────────┬──────────┐       │
                         │     ▼          ▼          ▼       │
                         │  Turn(A)    Turn(B)    Turn(C)    │
                         │  load hist  load hist  load hist  │
                         │  LLM call   LLM call   LLM call  │
                         │  tools      tools      tools     │
                         │     │          │          │       │
                         │     ▼          ▼          ▼       │
                         │  EQ(A)      EQ(B)      EQ(C)     │
                         └─────┬──────────┬──────────┬───────┘
                               ▼          ▼          ▼
                          SSE(A)     SSE(B)     SSE(C)
```

**Key difference from BrowserX:** BrowserX's SQ processes submissions serially (one user, one turn at a time). digitalme-agent's SQ dispatches concurrently — many fans in flight simultaneously on the same Node.js event loop, since LLM calls are I/O-bound.

### Why SQ/EQ (not plain request handlers)

| Capability | Plain handler | SQ/EQ |
|------------|--------------|-------|
| Concurrent fan requests | ✓ (implicit via async) | ✓ (explicit, trackable) |
| Backpressure / max concurrency | Manual | Built-in (queue depth) |
| Request cancellation (fan disconnect) | Ad-hoc AbortController | `agent.cancel(requestId)` |
| Observability (active requests, queue depth) | Manual counters | `agent.activeRequestCount` |
| Priority handling (paid fans first) | Not possible | Queue ordering |
| Graceful shutdown (drain in-flight) | Manual tracking | `agent.drain()` |
| Future: rate limiting per fan | Separate middleware | Integrated with dispatch |

SQ/EQ provides the operational infrastructure that plain async handlers would need to build piecemeal over time.

### Types

```typescript
// src/agent/types.ts

export interface FanSubmission {
  requestId: string;           // Unique per-request, for event routing
  fanUserId: string;           // Fan identity
  conversationId: string;      // Conversation to continue
  content: string;             // Fan's message (already filtered)
}

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface TurnContext {
  requestId: string;
  fanUserId: string;
  conversationId: string;
  history: Message[];          // Loaded from DB at dispatch time
  events: EventQueue;          // Per-request event sink
}
```

### The Agent class

```typescript
// src/agent/Agent.ts

export interface AgentConfig {
  systemPrompt: string;
  model: string;
  modelProvider: 'openai' | 'anthropic';
  maxTurns?: number;           // Prevent infinite tool loops (default: 10)
  maxConcurrent?: number;      // Max concurrent fan requests (default: 50)
}

/**
 * Long-lived agent instance — one per creator, serving many fans concurrently.
 *
 * Uses SQ/EQ pattern from BrowserX:
 * - Submission Queue: accepts fan messages, dispatches concurrently
 * - Event Queue: per-request, routes events back to the fan's SSE stream
 *
 * Shared (creator-scoped, read-only):  model client, persona, tools, DB pool
 * Isolated (per-request, ephemeral):   TurnContext, conversation history, EQ
 */
export class Agent {
  private readonly config: AgentConfig;
  private readonly modelClient: ModelClient;
  private readonly tools: Tool[];
  private readonly db: Database;
  private readonly activeRequests = new Map<string, TurnContext>();

  constructor(config: AgentConfig, modelClient: ModelClient, tools: Tool[], db: Database) {
    this.config = config;
    this.modelClient = modelClient;
    this.tools = tools;
    this.db = db;
  }

  /**
   * Submit a fan message. Returns an async iterable of events for this request.
   * The turn executes concurrently — other fans are not blocked.
   */
  submit(submission: FanSubmission): AsyncIterable<AgentEvent> {
    // Backpressure check
    const maxConcurrent = this.config.maxConcurrent ?? 50;
    if (this.activeRequests.size >= maxConcurrent) {
      return toAsyncIterable({ type: 'error' as const, message: 'Agent at capacity, retry later' });
    }

    const events = new EventQueue<AgentEvent>();

    // Dispatch concurrently — do NOT await
    this.dispatchTurn(submission, events)
      .catch(err => events.push({ type: 'error', message: err.message }))
      .finally(() => {
        events.close();
        this.activeRequests.delete(submission.requestId);
      });

    return events;
  }

  /**
   * Cancel an in-flight request (e.g., fan disconnected).
   */
  cancel(requestId: string): void {
    const ctx = this.activeRequests.get(requestId);
    if (ctx) {
      ctx.events.push({ type: 'cancelled' });
      ctx.events.close();
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Drain all in-flight requests (graceful shutdown).
   */
  async drain(): Promise<void> {
    await Promise.all(
      [...this.activeRequests.values()].map(ctx =>
        ctx.events.waitUntilClosed()
      )
    );
  }

  get activeRequestCount(): number {
    return this.activeRequests.size;
  }

  // --- Private: turn execution ---

  private async dispatchTurn(submission: FanSubmission, events: EventQueue<AgentEvent>): Promise<void> {
    // 1. Load conversation history from DB
    const history = await this.db.getMessages(submission.conversationId);

    // 2. Create isolated turn context
    const ctx: TurnContext = {
      requestId: submission.requestId,
      fanUserId: submission.fanUserId,
      conversationId: submission.conversationId,
      history,
      events,
    };
    this.activeRequests.set(submission.requestId, ctx);

    // 3. Execute turn (ReAct loop)
    await this.executeTurn(ctx, submission.content);
  }

  private async executeTurn(ctx: TurnContext, userMessage: string): Promise<void> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...this.formatHistory(ctx.history),
      { role: 'user', content: userMessage },
    ];

    let turns = 0;
    const maxTurns = this.config.maxTurns ?? 10;

    while (turns < maxTurns) {
      turns++;

      const response = await this.modelClient.chat({
        model: this.config.model,
        messages,
        tools: this.tools.map(t => t.definition),
        stream: true,
      });

      // Stream text response
      if (response.type === 'text') {
        for await (const chunk of response.stream) {
          ctx.events.push({ type: 'text_delta', content: chunk });
        }
        ctx.events.push({ type: 'done' });
        return;
      }

      // Handle tool calls (ReAct loop)
      if (response.type === 'tool_calls') {
        for (const call of response.toolCalls) {
          ctx.events.push({ type: 'tool_start', name: call.name });

          const tool = this.tools.find(t => t.name === call.name);
          if (!tool) throw new Error(`Unknown tool: ${call.name}`);

          const result = await tool.execute(call.arguments);
          ctx.events.push({ type: 'tool_end', name: call.name });

          messages.push({
            role: 'assistant',
            tool_calls: [{ id: call.id, name: call.name, arguments: call.arguments }],
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result,
          });
        }
        continue;  // Next turn with tool results
      }
    }

    ctx.events.push({ type: 'error', message: 'Max turns exceeded' });
  }

  private formatHistory(history: Message[]): ChatMessage[] {
    return history.map(m => ({
      role: m.sender_type === 'fan' ? 'user' : 'assistant',
      content: m.content,
    }));
  }
}
```

### EventQueue

```typescript
// src/agent/EventQueue.ts

/**
 * Per-request event queue. The producer (turn execution) pushes events;
 * the consumer (SSE stream) async-iterates over them.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: (() => void) | null = null;
  private closed = false;

  push(event: T): void {
    if (this.closed) return;
    this.queue.push(event);
    this.resolve?.();
  }

  close(): void {
    this.closed = true;
    this.resolve?.();
  }

  async waitUntilClosed(): Promise<void> {
    while (!this.closed) {
      await new Promise<void>(r => { this.resolve = r; });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.closed) return;
      await new Promise<void>(r => { this.resolve = r; });
    }
  }
}
```

### Key design decisions

1. **SQ/EQ pattern** — Proven in BrowserX, adapted for concurrent multi-fan dispatch
2. **Long-lived instance** — One Agent per creator; shared model client, config, DB pool
3. **Concurrent dispatch** — SQ fires turns without awaiting; Node.js event loop handles I/O concurrency
4. **Per-request isolation** — Each fan gets own TurnContext + EventQueue; no shared mutable state
5. **Built-in backpressure** — `maxConcurrent` rejects when at capacity
6. **Cancellation** — `agent.cancel(requestId)` when fan disconnects mid-stream
7. **Graceful shutdown** — `agent.drain()` waits for all in-flight turns to complete
8. **Stateless turns** — History loaded from DB per request; no in-memory state between requests
9. **ReAct loop** — Tool calls followed by LLM reasoning, capped by `maxTurns`

---

## 6. Multi-Tenant Isolation

### Isolation by design, not enforcement

**Traditional approach:** Shared state + access control checks
**Our approach:** Shared agent instance with isolated per-request TurnContexts — no mutable state crosses request boundaries

```
┌─────────────────────────────────────────────────────────────┐
│              Agent Instance (long-lived, 1/creator)          │
│                                                              │
│  Shared (read-only / stateless):                             │
│  ├── Creator persona config                                  │
│  ├── Model client (stateless API calls)                      │
│  ├── Tool definitions                                        │
│  └── DB connection pool                                      │
│                                                              │
│  Concurrent TurnContexts (isolated, ephemeral):              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │ TurnContext(A)    │  │ TurnContext(B)    │                 │
│  │ fan_user_id: aaa  │  │ fan_user_id: bbb  │                │
│  │ conv_id: conv-1   │  │ conv_id: conv-2   │                │
│  │ history: [...]    │  │ history: [...]    │                │
│  │ events: EQ(A)     │  │ events: EQ(B)     │                │
│  │ ↓                 │  │ ↓                 │                │
│  │ No reference to B │  │ No reference to A │                │
│  └──────────────────┘  └──────────────────┘                 │
└─────────────────────────────────────────────────────────────┘
```

### Isolation layers

| Layer | Shared or Isolated | Mechanism |
|-------|-------------------|-----------|
| Container | Shared (all fans) | 1 per creator |
| Process | Shared (all fans) | 1 per container |
| HTTP server | Shared (all fans) | Stateless routing |
| **Agent instance** | **Shared (all fans)** | Long-lived, no mutable fan state |
| Model client | Shared (all fans) | Stateless API calls, pooled connections |
| Database pool | Shared (all fans) | Parameterized queries |
| **TurnContext** | **Isolated per request** | Ephemeral, GC'd after response |
| **EventQueue** | **Isolated per request** | Scoped to one fan's SSE stream |
| **Conversation data** | **Isolated per fan** | `WHERE fan_user_id = ?` |
| **Rate limits** | **Isolated per fan** | Keyed by `fan_user_id` |

### What's shared (safe)

| Component | Why it's safe |
|-----------|---------------|
| Agent instance | No mutable fan state; only holds read-only config + stateless clients |
| Persona config | Read-only, loaded at startup, same for all fans |
| Model client | Stateless HTTP API calls, connection pooling is transparent |
| Tool definitions | Read-only function references |
| DB connection pool | Queries parameterized by conversation_id / fan_user_id |
| `activeRequests` map | Keyed by requestId; entries only reference their own TurnContext |

### What's isolated (per-request)

| Component | Isolation mechanism |
|-----------|---------------------|
| TurnContext | Created at dispatch, contains only this fan's data, GC'd after |
| EventQueue | Per-request; producer = turn execution, consumer = this fan's SSE |
| Conversation history | Loaded from DB with `WHERE conversation_id = ?` at dispatch time |
| Tool execution context | Receives only this fan's conversation_id |
| SSE response stream | Scoped to HTTP response, fed by this request's EventQueue |

### Request flow with isolation (SQ/EQ)

```typescript
// src/routes/conversations.ts
// Note: `agent` is the long-lived Agent instance, created at startup

app.post('/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id');
  const { fan_user_id, content } = await c.req.json();

  // 1. Verify ownership
  const conversation = await db.getConversation(conversationId);
  if (!conversation) {
    return c.json({ error: 'conversation_not_found' }, 404);
  }
  if (conversation.fan_user_id !== fan_user_id) {
    return c.json({ error: 'conversation_access_denied' }, 403);
  }

  // 2. Filter input
  const filtered = await inputFilter.filter(content);
  if (filtered.blocked) {
    return c.json({ error: 'input_blocked', reason: filtered.reason }, 422);
  }

  // 3. Persist fan message
  await db.appendMessage(conversationId, 'fan', filtered.content);

  // 4. Submit to agent's SQ — returns EventQueue (async iterable)
  const requestId = generateRequestId();
  const events = agent.submit({
    requestId,
    fanUserId: fan_user_id,
    conversationId,
    content: filtered.content,
  });

  // 5. Stream events from EQ → SSE
  return streamSSE(c, async (stream) => {
    let fullResponse = '';

    // Handle fan disconnect → cancel the in-flight turn
    c.req.raw.signal.addEventListener('abort', () => agent.cancel(requestId));

    for await (const event of events) {
      if (event.type === 'text_delta') {
        fullResponse += event.content;
        await stream.writeSSE({ data: JSON.stringify(event) });
      } else if (event.type === 'done') {
        await db.appendMessage(conversationId, 'agent', fullResponse);
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } else if (event.type === 'error') {
        await stream.writeSSE({ data: JSON.stringify(event) });
      }
    }
  });
});
```

### Tenant-scoped database access

```typescript
// src/storage/TenantDB.ts

// Pattern: Create tenant-scoped DB wrapper per request
export class TenantDB {
  constructor(
    private db: Database,
    private fanUserId: string
  ) {}

  // All queries automatically scoped - can't forget tenant filter
  async getConversations(): Promise<Conversation[]> {
    return this.db.query(
      'SELECT * FROM conversations WHERE fan_user_id = ?',
      [this.fanUserId]
    );
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    // Double-check: conversation must belong to this fan
    const conv = await this.db.query(
      'SELECT * FROM conversations WHERE id = ? AND fan_user_id = ?',
      [conversationId, this.fanUserId]
    );
    if (!conv) throw new ConversationAccessDeniedError();

    return this.db.query(
      'SELECT * FROM messages WHERE conversation_id = ?',
      [conversationId]
    );
  }
}
```

---

## 7. Resource Access Control

### Resource domains

```
┌─────────────────────────────────────────────────────────────┐
│                         CREATOR DOMAIN                       │
│                    (configured at deploy time)               │
├─────────────────────────────────────────────────────────────┤
│  ✓ System prompt         (read-only for fans)               │
│  ✓ Model selection       (read-only for fans)               │
│  ✓ Tool allowlist        (read-only for fans)               │
│  ✓ Safety rules          (enforced on fans)                 │
│  ✓ Rate limits           (enforced on fans)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                          FAN DOMAIN                          │
│                    (per-fan, strictly isolated)              │
├─────────────────────────────────────────────────────────────┤
│  ✓ Own conversations     (can create, read, continue)       │
│  ✓ Own messages          (can send, view history)           │
│  ✓ Own rate limit quota  (tracked per fan)                  │
│  ✗ Other fans' data      (NEVER accessible)                 │
│  ✗ Creator's resources   (NEVER accessible)                 │
│  ✗ Agent configuration   (NEVER modifiable)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                        TOOL DOMAIN                           │
│                    (what tools can access)                   │
├─────────────────────────────────────────────────────────────┤
│  ✓ Public internet       (web search, if enabled)           │
│  ✓ Creator's knowledge   (via approved MCP, future)         │
│  ✗ Local filesystem      (BLOCKED - not implemented)        │
│  ✗ Shell/processes       (BLOCKED - not implemented)        │
│  ✗ Creator's browser     (BLOCKED - not implemented)        │
│  ✗ Other fans' contexts  (BLOCKED - no access path)         │
└─────────────────────────────────────────────────────────────┘
```

### Tool capability classes

**MVP allowed:**
- Public web search
- Public web fetch (read-only)

**Future (with restrictions):**
- Creator's knowledge base (read-only MCP)
- Approved read-only integrations

**Forever forbidden:**
- Arbitrary process spawn
- Shell execution
- Local file read/write
- Browser profile/session access
- Outbound messaging, purchases, account actions

### Tool implementation

```typescript
// src/tools/types.ts

export interface ToolContext {
  conversationId: string;
  fanUserId: string;
  // Tools receive context for logging but cannot access other conversations
}

export interface Tool {
  name: string;
  description: string;
  definition: ToolDefinition;
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
}
```

```typescript
// src/tools/web-search.ts

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for information',
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
        },
        required: ['query'],
      },
    },
  },
  execute: async (args: { query: string }, ctx: ToolContext) => {
    // Stateless - just performs search
    // ctx available for logging/auditing only
    const results = await searchProvider.search(args.query);
    return JSON.stringify(results);
  },
};
```

### Tool registry (static allowlist)

```typescript
// src/tools/index.ts

export function createToolRegistry(config: PersonaConfig): Tool[] {
  const tools: Tool[] = [];

  if (config.tools.allowWebSearch) {
    tools.push(webSearchTool);
  }

  // MVP: Dangerous tools are simply not implemented
  // No filesystem, no shell, no browser

  return tools;
}
```

---

## 8. API Specification

### Authentication

All requests (except `/health`) include:

| Header | Value |
|--------|-------|
| `X-DigitalMe-Key` | API key (64-char URL-safe base64) |
| `X-DigitalMe-Signature` | HMAC-SHA256 hex digest |
| `X-DigitalMe-Timestamp` | Unix timestamp (seconds) |

Signature: `HMAC-SHA256(signing_secret, "{timestamp}:{body}")`

### Endpoints

#### `GET /health`

```json
{ "status": "ok" }
```

Returns degraded status if model provider or database unavailable.

#### `POST /verify`

Request:
```json
{ "type": "verification", "challenge": "{32-char}" }
```

Response:
```json
{ "challenge": "{echo-same-value}" }
```

#### `POST /conversations`

Request:
```json
{ "fan_user_id": "{uuid}" }
```

Headers: `X-DigitalMe-Request-Id` for idempotency

Response:
```json
{ "id": "{conversation_id}", "status": "active" }
```

#### `GET /conversations?fan_user_id={uuid}`

Response:
```json
[{ "id": "{id}", "fan_user_id": "{uuid}", "status": "active" }]
```

#### `GET /conversations/:id/messages`

Response:
```json
[{ "id": "{id}", "sender_type": "fan", "content": "Hello!", "sequence_no": 1 }]
```

#### `POST /conversations/:id/messages`

Request:
```json
{ "fan_user_id": "{uuid}", "content": "Hello!" }
```

Headers: `X-DigitalMe-Request-Id` for idempotency

Response: `Content-Type: text/event-stream`
```
data: {"type":"text_delta","content":"Hi"}

data: {"type":"text_delta","content":" there!"}

data: {"type":"done"}

```

### Error responses

| Case | Status | Body |
|------|--------|------|
| Invalid HMAC | `401` | `{ "error": "unauthorized" }` |
| Replay rejected | `401` | `{ "error": "replay_rejected" }` |
| Conversation not found | `404` | `{ "error": "conversation_not_found" }` |
| Wrong fan | `403` | `{ "error": "conversation_access_denied" }` |
| Input blocked | `422` | `{ "error": "input_blocked", "reason": "..." }` |
| Rate limited | `429` | `{ "error": "rate_limited" }` |

---

## 9. Security

### HMAC middleware

```typescript
// src/middleware/hmac.ts

export function hmacMiddleware(config: {
  apiKey: string;
  signingSecret: string;
  toleranceSeconds: number;
}) {
  return async (c: Context, next: Next) => {
    const key = c.req.header('X-DigitalMe-Key');
    const signature = c.req.header('X-DigitalMe-Signature');
    const timestamp = c.req.header('X-DigitalMe-Timestamp');

    if (!key || !signature || !timestamp) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Check API key
    if (key !== config.apiKey) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Check timestamp (prevent replay)
    const now = Math.floor(Date.now() / 1000);
    const ts = parseInt(timestamp, 10);
    if (Math.abs(now - ts) > config.toleranceSeconds) {
      return c.json({ error: 'replay_rejected' }, 401);
    }

    // Verify HMAC
    const body = await c.req.text();
    const message = `${timestamp}:${body}`;
    const expected = createHmac('sha256', config.signingSecret)
      .update(message)
      .digest('hex');

    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    c.set('rawBody', body);
    await next();
  };
}
```

### Input filtering

```typescript
// src/safety/input-filter.ts

export class InputFilter {
  constructor(private config: { blockedTopics: string[]; maxLength: number }) {}

  async filter(content: string): Promise<FilterResult> {
    // Length check
    if (content.length > this.config.maxLength) {
      return { blocked: true, reason: 'message_too_long' };
    }

    // Blocked topics
    for (const topic of this.config.blockedTopics) {
      if (content.toLowerCase().includes(topic.toLowerCase())) {
        return { blocked: true, reason: `blocked_topic:${topic}` };
      }
    }

    // Basic injection detection
    const injectionPatterns = [
      /ignore previous instructions/i,
      /you are now/i,
      /forget your instructions/i,
      /new system prompt/i,
    ];
    for (const pattern of injectionPatterns) {
      if (pattern.test(content)) {
        return { blocked: true, reason: 'injection_detected' };
      }
    }

    return { blocked: false, content };
  }
}
```

### Rate limiting (per-fan)

```typescript
// src/middleware/rate-limit.ts

// MVP: In-memory (single instance)
// Scale: Replace with Redis

const fanLimits = new Map<string, { count: number; resetAt: number }>();

export function rateLimitMiddleware(config: { perMinute: number }) {
  return async (c: Context, next: Next) => {
    const fanUserId = c.get('fanUserId');
    const now = Date.now();

    let limit = fanLimits.get(fanUserId);
    if (!limit || now > limit.resetAt) {
      limit = { count: 0, resetAt: now + 60_000 };
      fanLimits.set(fanUserId, limit);
    }

    if (limit.count >= config.perMinute) {
      return c.json({ error: 'rate_limited' }, 429);
    }

    limit.count++;
    await next();
  };
}
```

---

## 10. Storage

### Database interface

```typescript
// src/storage/types.ts

export interface Database {
  // Conversations
  createConversation(id: string, fanUserId: string): Promise<void>;
  getConversation(id: string): Promise<Conversation | null>;
  getConversationsByFan(fanUserId: string): Promise<Conversation[]>;

  // Messages
  getMessages(conversationId: string): Promise<Message[]>;
  appendMessage(conversationId: string, senderType: string, content: string): Promise<void>;

  // Idempotency
  checkIdempotency(key: string): Promise<IdempotencyRecord | null>;
  setIdempotency(key: string, conversationId: string, response: string, ttlSeconds: number): Promise<void>;
}
```

### SQLite implementation (MVP)

```sql
-- src/storage/schema.sql

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  fan_user_id TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_conv_fan ON conversations(fan_user_id);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  sender_type TEXT NOT NULL,  -- 'fan' | 'agent'
  content TEXT NOT NULL,
  sequence_no INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_msg_conv ON messages(conversation_id);

CREATE TABLE idempotency (
  key TEXT PRIMARY KEY,
  conversation_id TEXT,
  response TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Postgres implementation (scale)

Same schema, swap driver:

```typescript
// src/storage/postgres.ts

import { Pool } from 'pg';

export class PostgresDB implements Database {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async getMessages(conversationId: string): Promise<Message[]> {
    const result = await this.pool.query(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY sequence_no',
      [conversationId]
    );
    return result.rows;
  }

  // ... same interface, different driver
}
```

---

## 11. Scaling Strategy

### Single instance limits

```
┌─────────────────────────────────────────────────────────────┐
│              Single Instance Capacity                        │
├─────────────────────────────────────────────────────────────┤
│  Concurrent requests: ~50-100 (limited by connections)      │
│  SQLite writes: ~1000/sec (good enough for MVP)             │
│  Memory: ~10-50MB per active request                        │
│  Bottleneck: LLM API rate limits, not our code              │
└─────────────────────────────────────────────────────────────┘
```

### Horizontal scaling architecture

```
                         ┌─────────────────┐
                         │  Load Balancer  │
                         └────────┬────────┘
                                  │
          ┌───────────────────────┼───────────────────────┐
          ▼                       ▼                       ▼
   ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
   │  Instance 1 │         │  Instance 2 │         │  Instance N │
   │  (stateless)│         │  (stateless)│         │  (stateless)│
   └──────┬──────┘         └──────┬──────┘         └──────┬──────┘
          │                       │                       │
          └───────────────────────┼───────────────────────┘
                                  │
                    ┌─────────────┼─────────────┐
                    ▼             ▼             ▼
             ┌──────────┐  ┌──────────┐  ┌──────────┐
             │ Postgres │  │  Redis   │  │  Queue   │
             │  (data)  │  │ (cache/  │  │ (async)  │
             │          │  │  limits) │  │          │
             └──────────┘  └──────────┘  └──────────┘
```

### Scaling tiers

| Tier | Fans | Req/sec | Changes needed |
|------|------|---------|----------------|
| **MVP** | 1-1,000 | 10-20 | None (SQLite, single instance) |
| **Growth** | 1,000-10,000 | 50-100 | Bigger instance, maybe Redis |
| **Scale** | 10,000-100,000 | 200+ | Postgres, multiple instances, LB |
| **Hot creator** | 100,000-1M+ | 500+ | LLM gateway, queue, caching, multi-key |

### What changes per tier

| Component | MVP | Growth | Scale | Hot |
|-----------|-----|--------|-------|-----|
| Database | SQLite | SQLite | Postgres | Postgres + replicas |
| Rate limiting | In-memory | Redis | Redis cluster | Redis cluster |
| Idempotency | SQLite | SQLite | Redis | Redis |
| Instances | 1 | 1 | 3+ | 10+ |
| LLM keys | 1 | 1 | 1-2 | Multiple + gateway |

### Why our design scales

**Stateless requests = any instance can handle any request**

```typescript
// Every request is independent
app.post('/messages', async (c) => {
  const agent = new Agent(...);           // Fresh instance
  const history = await db.getMessages(); // From shared DB
  const response = await agent.chat();    // Stateless LLM call
  await db.saveMessage();                 // To shared DB
});
```

No sticky sessions. No instance affinity. Just add more containers.

### The real bottleneck

LLM API rate limits, not our architecture:

```
OpenAI rate limits:
├── GPT-4o: ~10,000 RPM = ~166 req/sec
└── Shared across ALL instances

Anthropic rate limits:
├── Claude: 1,000-4,000 RPM = ~16-66 req/sec
└── Depends on tier
```

For truly hot creators:
- Negotiate higher API limits
- Multiple API keys with load balancing
- Or self-hosted models

---

## 12. Configuration

### config.yaml

```yaml
persona:
  name: "Agent Name"
  system_prompt: |
    You are a helpful assistant representing the creator.
    Be friendly and informative.
  model: gpt-4o
  model_provider: openai

  tools:
    allow_web_search: true

  safety:
    blocked_topics: ["financial advice", "medical advice"]
    max_response_length: 4000

server:
  port: 8080
  bind: "0.0.0.0"

auth:
  api_key: ${DIGITALME_API_KEY}
  signing_secret: ${DIGITALME_SIGNING_SECRET}

model:
  api_key: ${MODEL_API_KEY}

storage:
  type: sqlite  # or postgres
  data_dir: ./data  # for sqlite
  # connection_string: ${DATABASE_URL}  # for postgres

limits:
  max_message_length: 4000
  rate_limit_per_fan: 20  # per minute
  max_turns: 10  # prevent infinite tool loops
  max_conversations_per_fan: 50

security:
  hmac_tolerance_seconds: 300
  idempotency_ttl_seconds: 900
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DIGITALME_API_KEY` | Yes | Platform API key |
| `DIGITALME_SIGNING_SECRET` | Yes | Platform signing secret |
| `MODEL_API_KEY` | Yes | LLM provider API key |
| `DATABASE_URL` | For Postgres | Postgres connection string |
| `REDIS_URL` | For scale | Redis connection string |
| `DIGITALME_PORT` | No | Server port (default: 8080) |

---

## 13. Deployment

### Dockerfile

```dockerfile
FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --production

# Copy built code
COPY dist ./dist

# Create data directory
RUN mkdir -p /app/data

EXPOSE 8080

ENV NODE_ENV=production
ENV DIGITALME_DATA_DIR=/app/data
ENV DIGITALME_PORT=8080

CMD ["node", "dist/index.js"]
```

### docker-compose.yml (MVP)

```yaml
version: '3.8'

services:
  agent:
    build: .
    ports:
      - "8080:8080"
    environment:
      - DIGITALME_API_KEY=${DIGITALME_API_KEY}
      - DIGITALME_SIGNING_SECRET=${DIGITALME_SIGNING_SECRET}
      - MODEL_API_KEY=${MODEL_API_KEY}
    volumes:
      - agent-data:/app/data
      - ./config.yaml:/app/config.yaml:ro
    restart: unless-stopped

volumes:
  agent-data:
```

### docker-compose.yml (scaled)

```yaml
version: '3.8'

services:
  agent:
    build: .
    deploy:
      replicas: 3
    environment:
      - DIGITALME_API_KEY=${DIGITALME_API_KEY}
      - DIGITALME_SIGNING_SECRET=${DIGITALME_SIGNING_SECRET}
      - MODEL_API_KEY=${MODEL_API_KEY}
      - DATABASE_URL=${DATABASE_URL}
      - REDIS_URL=${REDIS_URL}
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: digitalme
      POSTGRES_USER: digitalme
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data

  nginx:
    image: nginx:alpine
    ports:
      - "8080:80"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:
      - agent

volumes:
  postgres-data:
  redis-data:
```

---

## 14. Implementation Checklist

### Phase 1: Project setup (Day 1)

- [ ] Create repository
- [ ] Initialize npm project with TypeScript
- [ ] Add dependencies: hono, better-sqlite3, zod, uuid
- [ ] Set up build (tsup or esbuild)
- [ ] Create config loader with Zod validation
- [ ] Set up ESLint + Prettier

### Phase 2: Core agent (Day 1-2)

- [ ] Copy model clients from browserx (OpenAI, Anthropic)
- [ ] Simplify model clients (remove browserx-specific code)
- [ ] Implement `Agent` class with ReAct loop
- [ ] Implement web search tool
- [ ] Test agent standalone (no HTTP)

### Phase 3: HTTP server (Day 2-3)

- [ ] Set up Hono server
- [ ] Implement HMAC middleware
- [ ] Implement rate limit middleware
- [ ] Implement `/health` endpoint
- [ ] Implement `/verify` endpoint
- [ ] Implement `POST /conversations`
- [ ] Implement `GET /conversations`
- [ ] Implement `GET /conversations/:id/messages`
- [ ] Implement `POST /conversations/:id/messages` with SSE

### Phase 4: Storage & safety (Day 3-4)

- [ ] Implement Database interface
- [ ] Implement SQLite storage
- [ ] Implement TenantDB wrapper for scoped access
- [ ] Implement idempotency handling
- [ ] Implement input filter
- [ ] Implement SSE streaming with heartbeat

### Phase 5: Testing & deployment (Day 4-5)

- [ ] Write unit tests (HMAC, input filter, storage, tenant isolation)
- [ ] Write integration tests (full request cycle)
- [ ] Create Dockerfile
- [ ] Create docker-compose.yml
- [ ] Test with DigitalMe platform
- [ ] Document deployment

### Future phases (post-MVP)

- [ ] Postgres storage implementation
- [ ] Redis rate limiting
- [ ] Redis idempotency
- [ ] Horizontal scaling setup
- [ ] MCP integration (restricted)
- [ ] Output filtering
- [ ] Usage tracking / analytics

---

## Appendix: Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Build vs Fork | New repo, transplant SQ/EQ + model clients | Proven patterns from BrowserX, no multi-platform baggage |
| Language | TypeScript | MCP ecosystem, browserx model clients |
| Database MVP | SQLite | Simple, single file, good enough |
| Database scale | Postgres | Proven, horizontal scaling |
| Multi-tenancy | Logical isolation | Stateless requests, parameterized queries |
| Agent architecture | SQ/EQ, long-lived instance per creator | Concurrent fan dispatch, shared infra, isolated turns |
| Tool policy | Static allowlist | No dynamic registration, no untrusted code |
| Scaling approach | Horizontal + shared DB | Stateless design enables this |
