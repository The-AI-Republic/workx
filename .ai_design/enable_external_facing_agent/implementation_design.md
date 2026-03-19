# Enable External-Facing Agent — Implementation Design

**Status:** Ready for implementation
**Date:** 2026-03-18
**Decision:** Build from scratch in TypeScript, copy only model clients from BrowserX

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

### Why build from scratch

We considered forking BrowserX but decided to build fresh:

| BrowserX | digitalme-agent |
|----------|-----------------|
| Complex state machine (RepublicAgent) | Simple request handler |
| Multi-platform (extension, desktop, server) | Server only |
| Single user (trusted) | Multi-tenant (fans untrusted) |
| Session/Turn management | Stateless per-request |
| Tool registry with risk assessment | Simple allowlist |
| Approval workflows | Creator pre-approves |
| MCP support | Future, with restrictions |

**BrowserX is ~15,000+ lines. digitalme-agent needs ~1,500 lines.**

The only code worth copying: **model clients** (OpenAI, Anthropic, etc.)

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

digitalme-agent is fundamentally a **stateless request handler**:

```
Fan message → Safety filter → LLM call → Stream response → Persist
```

Each request:
1. Loads conversation history from DB
2. Creates fresh agent instance
3. Calls LLM with history + new message
4. Streams response
5. Persists to DB

**No shared state between requests = isolation is automatic.**

---

## 2. Goals & Non-Goals

### Goals

- Build `digitalme-agent` from scratch as a new repository
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

**One agent instance per creator, serving many fans:**

```
┌─────────────────────────────────────────────────────────────────┐
│              ONE Agent Instance (per Creator)                    │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Shared Runtime                         │   │
│   │  • HTTP server (stateless)                               │   │
│   │  • Model client (stateless API calls)                    │   │
│   │  • Persona config (read-only)                            │   │
│   │  • Tool definitions (read-only)                          │   │
│   └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│         Request A       Request B       Request C               │
│         (Fan A)         (Fan B)         (Fan A)                 │
│              │               │               │                  │
│              ▼               ▼               ▼                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│   │ Agent inst.  │  │ Agent inst.  │  │ Agent inst.  │         │
│   │ (ephemeral)  │  │ (ephemeral)  │  │ (ephemeral)  │         │
│   │              │  │              │  │              │         │
│   │ History from │  │ History from │  │ History from │         │
│   │ conv_id=aaa  │  │ conv_id=bbb  │  │ conv_id=ccc  │         │
│   └──────────────┘  └──────────────┘  └──────────────┘         │
│              │               │               │                  │
│              └───────────────┴───────────────┘                  │
│                              │                                   │
│                              ▼                                   │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   Shared Storage                         │   │
│   │  • SQLite/Postgres (all conversations, all fans)         │   │
│   │  • Isolated by conversation_id in queries                │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Resource allocation

| What | How many |
|------|----------|
| Docker container | 1 per creator |
| HTTP server | 1 per container |
| Database | 1 per container (all fans' data) |
| Agent instance | 1 per request (ephemeral, GC'd after) |
| Fans | Many, sharing the same container |

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
│   ├── index.ts                 # Entry point
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
│   │   ├── Agent.ts             # Core agent (simple!)
│   │   └── types.ts
│   │
│   ├── models/
│   │   ├── index.ts             # Model client factory
│   │   ├── openai.ts            # OpenAI client (from browserx)
│   │   ├── anthropic.ts         # Anthropic client (from browserx)
│   │   └── types.ts
│   │
│   ├── tools/
│   │   ├── index.ts             # Tool registry (static allowlist)
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
│   │   └── types.ts
│   │
│   ├── streaming/
│   │   └── sse.ts               # SSE formatting + heartbeat
│   │
│   └── config/
│       ├── schema.ts            # Zod validation
│       └── loader.ts            # YAML + env var loading
│
├── config.example.yaml
├── Dockerfile
├── docker-compose.yml
├── package.json
└── tsconfig.json
```

### What to copy from BrowserX

Only model client implementations (~500 lines):

```
browserx/src/core/models/
├── OpenAIModelClient.ts      → digitalme-agent/src/models/openai.ts
├── AnthropicModelClient.ts   → digitalme-agent/src/models/anthropic.ts
├── GoogleModelClient.ts      → digitalme-agent/src/models/google.ts (optional)
└── types.ts                  → digitalme-agent/src/models/types.ts
```

Simplify during copy:
- Remove approval/risk assessment hooks
- Remove BrowserX-specific event types
- Keep streaming and tool call handling

---

## 5. Core Agent Design

### Stateless design (like ChatGPT/Claude backends)

The Agent is **completely stateless**. All conversation context is passed in via parameters, not stored in the instance. This matches how ChatGPT and Claude backends work at scale:

```
ChatGPT/Claude pattern:
├── 100M+ users, 500M+ conversations
├── Cannot keep agent instance per conversation (memory impossible)
├── Solution: stateless servers + database
│
│   On each request:
│   1. Load conversation history from DB
│   2. Pass full context to LLM (LLM is also stateless)
│   3. Stream response
│   4. Persist to DB
│   5. No server-side state kept
```

**Why stateless works:**
- Agent state = System prompt + History + Tools
- System prompt → Config (shared, read-only)
- History → Database (loaded per request)
- Tools → Config (shared, read-only)

There's no "agent memory" beyond conversation history. The LLM receives full context on every call.

**Implementation options:**

| Approach | Code | Notes |
|----------|------|-------|
| Instance per request | `new Agent(config, client, tools)` | Clear isolation, easy testing |
| Single shared instance | One `Agent` reused | Works because stateless |
| Just a function | `chat(config, client, tools, history, msg)` | Simplest, obviously stateless |

We use instance-per-request for clarity, but any approach works since there's no mutable state.

### The Agent class

```typescript
// src/agent/Agent.ts

export interface AgentConfig {
  systemPrompt: string;
  model: string;
  modelProvider: 'openai' | 'anthropic';
  maxTurns?: number;  // Prevent infinite tool loops
}

/**
 * Agent is stateless - all conversation context is passed in via parameters.
 * A new instance can be created per request, or a single instance can be
 * shared across requests since there is no mutable state.
 *
 * This design matches how ChatGPT/Claude backends work at scale:
 * - No per-user agent instances
 * - No per-conversation agent instances
 * - History loaded from DB on each request
 * - LLM receives full context each time
 */
export class Agent {
  private readonly modelClient: ModelClient;   // Shared, stateless API client
  private readonly tools: Tool[];              // Shared, read-only definitions
  private readonly config: AgentConfig;        // Shared, read-only config

  constructor(config: AgentConfig, modelClient: ModelClient, tools: Tool[]) {
    this.config = config;
    this.modelClient = modelClient;
    this.tools = tools;
  }

  async *chat(history: Message[], userMessage: string): AsyncGenerator<AgentEvent> {
    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...this.formatHistory(history),
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
          yield { type: 'text_delta', content: chunk };
        }
        yield { type: 'done' };
        return;
      }

      // Handle tool calls (ReAct loop)
      if (response.type === 'tool_calls') {
        for (const call of response.toolCalls) {
          yield { type: 'tool_start', name: call.name };

          const tool = this.tools.find(t => t.name === call.name);
          if (!tool) {
            throw new Error(`Unknown tool: ${call.name}`);
          }

          const result = await tool.execute(call.arguments);
          yield { type: 'tool_end', name: call.name };

          // Add to message history for next turn
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

    yield { type: 'error', message: 'Max turns exceeded' };
  }

  private formatHistory(history: Message[]): ChatMessage[] {
    return history.map(m => ({
      role: m.sender_type === 'fan' ? 'user' : 'assistant',
      content: m.content,
    }));
  }
}
```

### Agent events

```typescript
// src/agent/types.ts

export type AgentEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
```

### Key design decisions

1. **Stateless** — No mutable instance state; history passed as parameter
2. **Scalable** — Same pattern as ChatGPT/Claude backends (100M+ users)
3. **Simple ReAct loop** — Tool calls followed by LLM reasoning, max turns limit
4. **Streaming first** — All responses stream via AsyncGenerator
5. **No internal history** — History loaded from DB, passed in
6. **Flexible instantiation** — Can create per-request or share single instance

---

## 6. Multi-Tenant Isolation

### Isolation by design, not enforcement

**Traditional approach:** Shared state + access control checks
**Our approach:** No shared state to leak

```
┌─────────────────────────────────────────────────────────────┐
│                        Request 1 (Fan A)                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Agent instance (created for this request)          │    │
│  │  ├── History: loaded from DB WHERE conv_id = 'aaa'  │    │
│  │  └── No reference to any other conversation         │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                        Request 2 (Fan B)                     │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Agent instance (created for this request)          │    │
│  │  ├── History: loaded from DB WHERE conv_id = 'bbb'  │    │
│  │  └── No reference to any other conversation         │    │
│  └─────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### Isolation layers

| Layer | Shared or Isolated | Mechanism |
|-------|-------------------|-----------|
| Container | Shared (all fans) | N/A |
| Process | Shared (all fans) | N/A |
| HTTP server | Shared (all fans) | Stateless routing |
| Model client | Shared (all fans) | Stateless API calls |
| Database connection | Shared (all fans) | Parameterized queries |
| **Agent instance** | **Isolated per request** | Created fresh, GC'd after |
| **Conversation data** | **Isolated per fan** | `WHERE fan_user_id = ?` |
| **Rate limits** | **Isolated per fan** | Keyed by `fan_user_id` |

### What's shared (safe)

| Component | Why it's safe |
|-----------|---------------|
| HTTP server | Stateless request routing |
| Persona config | Read-only, same for all fans |
| Model client | Stateless API calls, no caching |
| Tool definitions | Read-only function references |
| DB connection | Queries parameterized by conversation_id |

### What's isolated (per-request)

| Component | Isolation mechanism |
|-----------|---------------------|
| Agent instance | Created fresh per request, GC'd after |
| Conversation history | Loaded from DB with `WHERE conversation_id = ?` |
| Tool execution context | Passed conversation_id, cannot query others |
| Response stream | Scoped to HTTP response object |

### Request flow with isolation

```typescript
// src/routes/conversations.ts

app.post('/conversations/:id/messages', async (c) => {
  const conversationId = c.req.param('id');
  const { fan_user_id, content } = await c.req.json();

  // 1. Verify ownership (only check, not shared state)
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

  // 3. Load ONLY this conversation's history
  const history = await db.getMessages(conversationId);

  // 4. Create FRESH agent instance (no shared state)
  const agent = new Agent(persona, modelClient, tools);

  // 5. Persist fan message
  await db.appendMessage(conversationId, 'fan', filtered.content);

  // 6. Stream response
  return streamSSE(c, async (stream) => {
    let fullResponse = '';

    for await (const event of agent.chat(history, filtered.content)) {
      if (event.type === 'text_delta') {
        fullResponse += event.content;
        await stream.writeSSE({ data: JSON.stringify(event) });
      } else if (event.type === 'done') {
        await db.appendMessage(conversationId, 'agent', fullResponse);
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
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
| Build vs Fork | Build from scratch | Simpler, faster, isolation by design |
| Language | TypeScript | MCP ecosystem, browserx model clients |
| Database MVP | SQLite | Simple, single file, good enough |
| Database scale | Postgres | Proven, horizontal scaling |
| Multi-tenancy | Logical isolation | Stateless requests, parameterized queries |
| Agent architecture | Ephemeral per-request | No shared state = automatic isolation |
| Tool policy | Static allowlist | No dynamic registration, no untrusted code |
| Scaling approach | Horizontal + shared DB | Stateless design enables this |
