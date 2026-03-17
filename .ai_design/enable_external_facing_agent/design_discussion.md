# Enable External-Facing Agent — Design Discussion

Date: 2026-03-16

## Context

We are building an AI agent platform (DigitalMe / sodapop) that allows creators to deploy external-facing AI agents. The platform code is at `/home/irichard/dev/git_repos/sodapop/platform` and the design at `/home/irichard/dev/git_repos/sodapop/.ai_design/digitalme`. The platform currently serves as a relay layer — it routes fan messages to creator-hosted agent endpoints and streams responses back. It has no agent functionality itself.

The question: is browserx ready to serve as the open source agent that creators deploy behind the platform?

---

## Q1: Is browserx ready to be used for the agent purpose?

### Answer: Not directly, but browserx server mode could serve as a creator's agent backend behind the platform.

### Why not directly

| | BrowserX | DigitalMe Platform |
|---|---|---|
| **Model** | Personal automation (user → agent → web) | Public-facing persona relay (fan → platform → agent) |
| **Language** | TypeScript | Python (FastAPI) |
| **Session** | Single-user, persistent browser context | Multi-tenant, stateless relay |
| **Tools** | ~80% browser automation (DOM, CDP, screenshots) | 0% browser tools — inference + safety filtering |
| **Data flow** | User drives the agent | Platform relays fan messages to creator's agent |

The design docs explicitly note that browserx and DigitalMe are fundamentally different products that shouldn't share a core.

### Where browserx can fit

BrowserX server mode could act as a creator's agent backend. A creator would register a running browserx server instance as their `agent_endpoint_url` in the platform. To make this work, browserx server would need to implement the DigitalMe agent endpoint protocol:

1. `POST /conversations` — create conversation
2. `POST /conversations/{id}/messages` — accept fan message, stream SSE response
3. `GET /conversations/{id}/messages` — return history
4. `GET /health` — health check
5. HMAC-SHA256 request signature verification

### What's missing for that use case

- **No DigitalMe endpoint protocol support** — browserx server currently exposes WebSocket + its own HTTP RPC, not the platform's REST+SSE protocol
- **No multi-tenant safety layer** — browserx trusts its user; external-facing agents need input/output moderation, rate limiting, jailbreak detection
- **No persona/system prompt management** — creators need to configure personality, knowledge boundaries, topic restrictions
- **Session model mismatch** — browserx sessions are user-driven; the platform needs fan-driven, concurrent conversations per creator

---

## Q2: Should we offer browserx directly or create a new open source agent?

### Clarification from user

The goal is to offer an open source agent (not just an LLM chatbot) that creators can deploy. The agent needs full capabilities — tools, browser automation, MCP, multi-turn reasoning.

### Answer: browserx IS the right answer — it just needs a DigitalMe protocol adapter.

Building agent capabilities (tool use, MCP, web search, browser automation, planning, multi-turn reasoning) from scratch would be massive. BrowserX already has all of this.

The actual gap is narrow — browserx needs a DigitalMe protocol adapter:

| Gap | Effort | What to build |
|---|---|---|
| REST+SSE endpoints (5 routes) | Small | HTTP handler alongside existing WebSocket server |
| HMAC-SHA256 auth verification | Small | Middleware for `X-DigitalMe-*` headers |
| `conversation_id` → session mapping | Small | Thin mapping layer over existing SessionIndex |
| Persona config (system prompt, knowledge boundaries) | Small | Config file for creator's persona |
| SSE streaming output (`text_delta`/`done`) | Small | Convert existing AgentMessage deltas to SSE format |

---

## Q3: Beyond the protocol adapter — security and session model concerns

### Security: Agent scope must be inverted

BrowserX today: **the user IS the operator** — the agent acts on behalf of whoever is chatting with it.

DigitalMe: **the creator is the operator, fans are visitors** — the agent acts on behalf of the creator (Alice), but fans (John/Alex/Mark) are talking to it.

| | BrowserX today | DigitalMe agent needed |
|---|---|---|
| Who controls the agent? | The person chatting | The creator (Alice) |
| Who chats with it? | The operator | External visitors (fans) |
| Tool access | Full — user trusts themselves | Restricted — Alice defines what fans can trigger |
| Browser access | User's own browser | **Never the creator's desktop** — sandboxed or disabled |
| File system | User's own files | **No access** to creator's machine |
| Credentials | User's own API keys | Creator provisions keys, fans never see them |

A fan sending "open my bank account" should **never** execute on Alice's machine. The agent needs a **principal separation**: Alice configures it, fans use it, and fan inputs can only trigger creator-approved actions within a sandbox.

### Session model: per-fan isolation

BrowserX today: sessions belong to one user. Multi-session means the same person running parallel tasks.

DigitalMe needs: **per-fan conversations, all under one creator's agent instance.**

```
Alice's Agent Instance
├── John's conversations
│   ├── conversation_1 (started Jan 5)
│   └── conversation_2 (started Mar 10)
├── Alex's conversations
│   └── conversation_1 (started Feb 20)
└── Mark's conversations
    ├── conversation_1 (started Jan 15)
    └── conversation_2 (started Mar 14)
```

Key differences:

- **Fan isolation** — John must never see Alex's history
- **Conversation ownership** — scoped to `(creator, fan_user_id, conversation_id)`
- **Shared persona context** — Alice's system prompt is shared across all fan conversations, but history is per-fan
- **Creator visibility** — Alice may review/moderate across all fans; fans only see their own
- **Concurrent conversations** — multiple fans chatting simultaneously must not interfere

### Architectural implications

These aren't adapter-level changes. They touch the agent's **trust model** and **data model**:

**Trust model changes:**
- New principal: `fan` (untrusted external user) vs `creator` (trusted operator)
- Tool allowlist defined by creator, not by the person chatting
- Fan input goes through safety filtering before reaching tools
- No tool should ever access creator's local resources unless explicitly sandboxed

**Data model changes:**
- Sessions need a `fan_user_id` dimension
- Conversation history: `(agent_instance, fan_user_id, conversation_id)`
- Creator dashboard: query across all fans
- Fan view: query only own conversations
- Token usage tracking per fan (for billing)

---

## Q4: How to extract the core? Should we split into a new repo?

### Three options considered

| Approach | Pros | Cons |
|---|---|---|
| **Add DigitalMe mode to browserx** | One codebase, shared core improvements | Complexity — two trust models in one codebase, risk of security leaks between modes |
| **Fork browserx core into a new repo** | Clean separation, purpose-built, simpler security audit | Duplicate maintenance, core improvements need backporting |
| **Extract shared core library + two thin shells** | Best of both — shared engine, separate trust boundaries | Refactoring effort upfront |

### Initial recommendation: monorepo with npm workspaces (Option 3)

Target structure:

```
browserx/
├── packages/
│   ├── core/                     # @browserx/core (shared engine)
│   │   ├── src/
│   │   │   ├── agent/            # RepublicAgent, TaskRunner, QueueProcessor
│   │   │   ├── session/          # Session, SessionState, TurnManager
│   │   │   ├── models/           # ModelClientFactory, OpenAI/Google/etc clients
│   │   │   ├── tools/            # ToolRegistry, BaseTool (abstractions only)
│   │   │   ├── channels/         # ChannelAdapter, ChannelManager (interfaces)
│   │   │   ├── protocol/         # Types, events, schemas, guards
│   │   │   ├── mcp/              # MCPManager
│   │   │   ├── storage/          # Abstract providers (interfaces)
│   │   │   ├── approval/         # Risk assessment framework
│   │   │   ├── streaming/        # StreamProcessor, delta handling
│   │   │   ├── compact/          # History compaction
│   │   │   ├── config/           # AgentConfig
│   │   │   ├── prompts/          # PromptComposer
│   │   │   ├── types/            # Shared types
│   │   │   └── utils/            # Shared utils
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   ├── browserx/                 # Personal assistant (current product)
│   │   ├── src/
│   │   │   ├── extension/        # Chrome extension shell
│   │   │   ├── desktop/          # Tauri desktop shell
│   │   │   ├── server/           # WebSocket server shell
│   │   │   ├── tools/            # Browser tools (DOM, CDP, screenshots)
│   │   │   └── webfront/         # Svelte UI
│   │   └── package.json          # depends on @browserx/core
│   │
│   └── digitalme-agent/          # External-facing agent (new)
│       ├── src/
│       │   ├── server/           # REST+SSE server (DigitalMe protocol)
│       │   ├── auth/             # HMAC-SHA256 verification
│       │   ├── conversations/    # Per-fan session isolation
│       │   ├── persona/          # Creator persona config
│       │   ├── safety/           # Fan input/output filtering
│       │   ├── tools/            # Creator-allowlisted tools only
│       │   └── storage/          # Fan-scoped persistence
│       ├── package.json          # depends on @browserx/core
│       ├── Dockerfile
│       └── config.example.yaml
│
├── package.json                  # workspaces: ["packages/*"]
├── tsconfig.base.json
└── turbo.json
```

---

## Q5: Deep research — will the extraction actually work?

### Answer: The core is NOT cleanly extractable today.

Deeper analysis revealed platform-specific code baked INTO `src/core/`:

| Problem | Severity | Details |
|---|---|---|
| `__BUILD_MODE__` in core | **CRITICAL** | 23+ locations — conditional compilation scattered throughout core |
| `chrome.tabs.*` in core | **CRITICAL** | TurnManager directly calls Chrome extension APIs |
| Tauri APIs in core | **CRITICAL** | MCPManager dynamically imports `@tauri-apps/api/core` |
| Circular dependency | **HIGH** | config imports from core, core imports from config |
| Singleton factory pattern | **HIGH** | RolloutRecorder internally calls `__BUILD_MODE__`-based factory |
| 569 path alias imports | **MEDIUM** | 212 files use `@/` aliases that all need updating |

### What refactoring is needed before extraction

1. **Abstract platform APIs out of core** — replace `chrome.tabs.*` calls in TurnManager with an injected `TabProvider` interface, remove Tauri imports from MCPManager
2. **Remove all `__BUILD_MODE__` from core** — push platform branching to the edges (bootstrap code)
3. **Break the config ↔ core circular dep** — merge config into core or extract shared types
4. **Convert RolloutRecorder from singleton+factory to pure DI** — platform code calls `setProvider()` at startup
5. **Update 569 imports across 212 files** + 4 vite configs + 3 tsconfigs + build scripts + test configs

### Build system coupling

| Category | Severity | Files Affected |
|----------|----------|----------------|
| TypeScript path aliases | **CRITICAL** | 6 config files, 212 source files |
| Vite `__BUILD_MODE__` injection | **CRITICAL** | 3 vite configs, 18+ source files |
| Build entry points | **HIGH** | vite.config.mjs, build.js |
| Test path discovery | **HIGH** | 3 test files use `__dirname` relative paths |
| SSR noExternal regex | **MEDIUM** | vite.config.server.mts |
| Build scripts | **MEDIUM** | build.js, build-sidecar.mjs |

### Rollout/storage system analysis

The RolloutRecorder uses a singleton + factory pattern with `__BUILD_MODE__`:

```
Session.initializeSession()
  └─> RolloutRecorder.create()
      └─> RolloutRecorder.getProvider()
          └─> createRolloutStorageProvider()
              └─> [Compile-time __BUILD_MODE__ check]
                  ├─ Extension: IndexedDBRolloutStorageProvider (browser APIs)
                  ├─ Desktop: TauriRolloutStorageProvider (Tauri IPC)
                  └─ Server: TSRolloutStorageProvider (better-sqlite3)
```

**Fix:** RolloutRecorder core logic is platform-agnostic. Keep that in shared core. Move provider factory + implementations to platform-specific code. Require platforms to call `setProvider()` at startup (the Chrome extension already does this).

---

## Q6: Two paths to the same destination

### Path A: Clean core first, then build agent
1. Refactor browserx core (remove chrome.tabs, Tauri imports, `__BUILD_MODE__` from core, convert singletons to DI)
2. Extract `packages/core/`
3. Build digitalme-agent on top of it

Result: shared core from day 1, but agent ships later.

### Path B: Build agent first, converge later
1. Build digitalme-agent as standalone, cherry-pick model clients + streaming + tool registry from browserx
2. Ship it
3. Later, refactor browserx core
4. Merge the duplicated code back into shared core

Result: agent ships sooner, but you carry some duplicated code temporarily.

---

## Q7: Which path serves long-term better?

### Decision: Path A — monorepo, clean core first.

**Reasoning:**

Duplicated code has a way of never getting converged back. "We'll merge it later" becomes tech debt that lives forever. Every bug fix, every new model provider, every streaming improvement gets patched in two places. The longer the two codebases drift, the harder the convergence becomes.

Path A forces the hard work upfront, but then every line of agent code is built on the real shared core. Both products benefit from every improvement immediately.

The refactoring browserx needs (removing platform code from core) is also good hygiene that should happen regardless. `chrome.tabs` calls in core is a design smell. DigitalMe gives the forcing function to clean it up now.

---

## Q8: Can we maintain a monorepo long-term as the two agents diverge?

### Answer: Yes.

As the products diverge:

```
Year 1:  80% shared, 20% divergent
Year 3:  50% shared, 50% divergent
Year 5:  30% shared, 70% divergent
```

That 30% shared in year 5 is the **hardest** stuff to keep in sync — model clients, streaming protocol, MCP integration, tool execution engine. If that lives in two repos, you're maintaining two implementations of the same foundational code forever.

The divergent parts just grow in their respective shells (`packages/browserx/`, `packages/digitalme-agent/`). They don't conflict because they don't touch each other.

Monorepos break down at **team/org boundaries** — different companies or separate teams that can't coordinate releases. Same team/org, monorepo scales fine.

**One thing to watch:** don't force shared code that shouldn't be shared. If digitalme-agent needs a different streaming model than browserx, let them each have their own. The core should only contain what genuinely serves both. Let it shrink over time if needed — a small, stable shared core is better than a large, awkward one.

---

## Final Decision

**Monorepo, Path A (clean core first, then build agent).**

Timing is not a concern — long-term maintainability is the priority.
