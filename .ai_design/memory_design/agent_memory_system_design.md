# Agent Long-Term Memory System Design

## 1. Overview

Build a built-in, invisible-to-the-user long-term memory system for the AI agent. The agent automatically extracts facts from conversations, stores them as vector embeddings in SQLite (via `sqlite-vec`), and retrieves relevant memories to inject into future conversations. Users never configure or enable memory — it just works.

**Target platforms:** Apple Pi (desktop/Tauri) and Apple Pi Server (Node.js). BrowserX (extension) is out of scope.

**Core approach:** Inspired by Mem0's architecture, implemented natively on the existing SQLite + Tauri stack. No external dependencies for vector storage — `sqlite-vec` provides SIMD-accelerated KNN search within the same database file.

### Why not Mem0 SDK?

| Factor | Mem0 SDK | Native sqlite-vec |
|--------|----------|-------------------|
| Desktop deployment | Needs Qdrant sidecar or in-memory (loses data on restart) | Single binary, same SQLite file |
| Server deployment | Needs Qdrant Docker container | Same SQLite, no sidecar |
| Size impact | ~6 MB net new + Qdrant (~50-100 MB) | ~200 KB (statically linked C) |
| Control | Black box prompts and extraction logic | Full control, tune for our agent |
| Architecture fit | Different storage abstraction | Extends existing `StorageProvider` / `db_storage.rs` |
| Cross-platform consistency | Different vector backends per platform | Identical behavior on desktop and server |

### Design principles

1. **Invisible**: No user setup, no toggles, no memory management UI (initially)
2. **Local-only**: All data stays on the user's machine — no cloud memory service
3. **Platform-agnostic core**: Memory logic lives in `src/core/`, uses `StorageProvider` interfaces
4. **Incremental**: Start with semantic memory (facts), add episodic and procedural later
5. **LLM-as-judge**: The LLM decides what to extract, when to update, and when to delete — no hardcoded similarity thresholds for dedup

---

## 2. Architecture

### 2.1 System diagram

```
                    Conversation Turn
                          │
                          ▼
              ┌───────────────────────┐
              │     TurnManager       │
              │  (after turn complete)│
              └───────────┬───────────┘
                          │
                    ┌─────▼─────┐
                    │  Memory   │
                    │  Service  │
                    └─────┬─────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
   │    Fact      │ │  Embedding  │ │   Memory    │
   │  Extractor   │ │  Generator  │ │   Store     │
   │ (LLM call)   │ │ (API call)  │ │(sqlite-vec) │
   └─────────────┘ └─────────────┘ └─────────────┘
                                          │
                                   ┌──────┴──────┐
                                   │   SQLite    │
                                   │  (existing) │
                                   └─────────────┘
```

### 2.2 Component responsibilities

| Component | Location | Responsibility |
|-----------|----------|---------------|
| `MemoryService` | `src/core/memory/MemoryService.ts` | Orchestrates extract → embed → store → retrieve |
| `FactExtractor` | `src/core/memory/FactExtractor.ts` | LLM-based fact extraction from conversations |
| `EmbeddingClient` | `src/core/memory/EmbeddingClient.ts` | Generates vector embeddings via provider API |
| `MemoryStore` | `src/core/memory/MemoryStore.ts` | CRUD + vector search over sqlite-vec |
| `MemoryHistory` | `src/core/memory/MemoryHistory.ts` | Audit log of all memory operations |
| Rust: `memory_commands.rs` | `tauri/src/memory_commands.rs` | Tauri IPC commands for vector operations (desktop) |
| Node: `NodeMemoryAdapter` | `src/server/storage/NodeMemoryAdapter.ts` | sqlite-vec via better-sqlite3 (server) |

### 2.3 Platform routing

Following the existing `__BUILD_MODE__` pattern:

```typescript
// src/core/memory/createMemoryStore.ts
export async function createMemoryStore(): Promise<MemoryStore> {
  if (__BUILD_MODE__ === 'desktop') {
    const { TauriMemoryStore } = await import('@/desktop/storage/TauriMemoryStore');
    return new TauriMemoryStore();
  }
  if (__BUILD_MODE__ === 'server') {
    const { NodeMemoryStore } = await import('@/server/storage/NodeMemoryStore');
    return new NodeMemoryStore();
  }
  throw new Error(`Memory system not supported in build mode: ${__BUILD_MODE__}`);
}
```

---

## 3. Data Model

### 3.1 Memory fact

```typescript
// src/core/memory/types.ts

export interface MemoryFact {
  id: string;                    // UUID v4
  factText: string;              // The extracted fact ("User prefers dark mode")
  category: MemoryCategory;      // Classification of the fact
  scope: MemoryScope;            // Who this memory belongs to
  contentHash: string;           // MD5 hash of factText for fast dedup
  createdAt: number;             // Unix timestamp ms
  updatedAt: number;             // Unix timestamp ms
  lastAccessedAt: number;        // Updated on retrieval (for future decay)
  accessCount: number;           // How often this memory has been retrieved
  metadata?: Record<string, unknown>; // Extensible key-value pairs
}

export type MemoryCategory =
  | 'preference'       // User likes/dislikes, style preferences
  | 'personal'         // Names, relationships, important dates
  | 'professional'     // Job, skills, career context
  | 'project'          // Current projects, tech stack, codebase details
  | 'behavior'         // Communication style, workflow preferences
  | 'instruction'      // Explicit user instructions ("always use TypeScript")
  | 'general';         // Anything that doesn't fit above

export interface MemoryScope {
  userId?: string;       // Long-term user-specific memories
  agentId?: string;      // Agent-learned behaviors
  sessionId?: string;    // Session-scoped context (short-lived)
}
```

### 3.2 Memory operation history

```typescript
export interface MemoryOperation {
  id: string;                    // UUID v4
  memoryId: string;              // ID of the affected memory
  event: 'ADD' | 'UPDATE' | 'DELETE';
  oldContent: string | null;     // Previous factText (null for ADD)
  newContent: string | null;     // New factText (null for DELETE)
  timestamp: number;             // Unix timestamp ms
}
```

### 3.3 Search result

```typescript
export interface MemorySearchResult {
  fact: MemoryFact;
  distance: number;              // L2 distance from query vector (lower = more similar)
}
```

### 3.4 SQLite schema

**Desktop (Rust migration in `tauri/src/memory_commands.rs`):**

```sql
-- Vector table (sqlite-vec virtual table)
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[1536]
);

-- Fact metadata table (regular SQLite)
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  fact_text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  user_id TEXT,
  agent_id TEXT,
  session_id TEXT,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  metadata TEXT                   -- JSON blob
);

CREATE INDEX idx_memory_facts_user ON memory_facts(user_id);
CREATE INDEX idx_memory_facts_category ON memory_facts(category);
CREATE INDEX idx_memory_facts_hash ON memory_facts(content_hash);

-- Operation history (audit log)
CREATE TABLE memory_history (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  event TEXT NOT NULL,            -- 'ADD', 'UPDATE', 'DELETE'
  old_content TEXT,
  new_content TEXT,
  timestamp INTEGER NOT NULL
);

CREATE INDEX idx_memory_history_memory ON memory_history(memory_id);
```

**Server (better-sqlite3 migration):** Identical schema. The `sqlite-vec` extension is loaded via `db.loadExtension()` in Node.js.

**Embedding dimensions:** Default 1536 (OpenAI `text-embedding-3-small`). Configurable via `MemoryConfig.embeddingDimensions`. Changing dimensions requires re-embedding all memories (migration).

### 3.5 Dimension mismatch detection & migration

**Problem:** The sqlite-vec virtual table is created with a fixed dimension (`float[1536]`). If a user switches from OpenAI (1536) to Google (768), the next insert will crash because the vector dimensions don't match the schema.

**Solution:** On startup, detect a mismatch between the configured embedding dimensions and the schema dimensions. If they differ, trigger a migration:

```typescript
// src/core/memory/MemoryStore.ts

async initialize(config: MemoryConfig): Promise<void> {
  const schemaDimensions = await this.getSchemaDimensions();  // Read from metadata table
  const configDimensions = config.embeddingDimensions;

  if (schemaDimensions && schemaDimensions !== configDimensions) {
    logger.warn(
      `Embedding dimension mismatch: schema=${schemaDimensions}, config=${configDimensions}. ` +
      `Re-embedding all memories in background.`
    );
    await this.migrateDimensions(configDimensions);
  }
}
```

**Migration steps:**
1. DROP the `memory_embeddings` virtual table
2. Recreate with new dimensions: `CREATE VIRTUAL TABLE memory_embeddings USING vec0(... float[${newDims}])`
3. Update the stored schema dimension in a metadata row
4. Queue a background job to re-embed all facts from `memory_facts.fact_text`
5. Facts remain fully usable during re-embedding (they're stored in the regular table) — only vector search is degraded until re-embedding completes

**Schema metadata table** (added to the SQLite schema):
```sql
CREATE TABLE memory_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Stores: embedding_dimensions, embedding_provider, schema_version
```

---

## 4. Memory Lifecycle

### 4.1 Write path (after each conversation turn)

```
1. TurnManager completes a turn
2. MemoryService.processConversation(messages) called asynchronously (non-blocking)
   - Enqueued into per-user sequential processing queue (see §4.5)
3. Pre-process messages (strip code blocks, truncate large pastes — see §5.2)
   - Skip extraction entirely if user content is trivial (<20 chars)
4. FactExtractor.extract(messages) → LLM returns {"facts": ["fact1", "fact2", ...]}
   - Full conversation window is sent (user + assistant) for reference resolution
5. EmbeddingClient.embedBatch(facts) → float[1536][] (single batched API call)
6. For each fact + embedding pair:
   a. MemoryStore.search(embedding, limit=5, scope) → existing similar memories
   b. Collect all similar existing memories (deduplicated by ID)
7. Route based on category:
   a. If category is `preference`, `instruction`, or `behavior`:
      - Route to `CoreMemoryManager.ts`
      - Load existing `core-memory.md`
      - LLM merges the new facts into the markdown structure
      - Save updated `core-memory.md` to disk
   b. Otherwise (topical facts):
      - ConflictResolver.resolve(newFacts, existingMemories) → LLM returns decisions
      - Execute each decision:
        - ADD:    MemoryStore.insert(fact, embedding) + log to history
        - UPDATE: MemoryStore.update(id, newFact, newEmbedding) + log to history
        - DELETE: MemoryStore.delete(id) + log to history
        - NONE:   skip (fact already exists or is irrelevant)
```

**Note on batching (step 5):** Embedding all extracted facts in a single `embedBatch()` call reduces network round-trips from N to 1, cutting extraction time significantly and lowering the risk of hitting provider rate limits.

**Important:** Step 2 is async/non-blocking. Memory extraction happens in the background after the turn response is delivered to the user. This prevents memory operations from adding latency to the conversation.

### 4.2 Read path (before each conversation turn)

The retrieval uses a **dual-path strategy** to solve the semantic mismatch problem: a raw user message like "Write a Python script to sort this" will match memories about Python but will miss global preferences like "User prefers concise answers." Core profile facts must be handled separately from topical recall.

```
1. User sends a new message
2. TurnManager prepares the request
3. MemoryService.getGlobalContext(scope) called
   a. GLOBAL PATH: Load the `core-memory.md` file from the user's workspace/vault
      - This file contains explicit, human-editable core rules and preferences
      - Loaded directly from the file system, no database query needed
   b. Format the contents of `core-memory.md` as a context block and inject into system prompt
4. User message is sent to LLM along with the `search_memory` tool
5. If the LLM determines it needs historical context, it calls `search_memory(query)`
6. Tool execution:
   a. EmbeddingClient.embed(query) → float[1536]
   b. MemoryStore.search(embedding, limit, scope) → MemorySearchResult[]
   c. Exclude categories already covered by global path
   d. Update lastAccessedAt and accessCount for returned memories
   e. Return formatted results to LLM
7. LLM uses the tool response to answer the user's message
```

**Why this hybrid approach?** Vector similarity search is great for finding topical matches, but we don't want to force the LLM to guess when to search for core rules. Always-injecting the core profile facts (global path) ensures they're never lost. By storing these global facts in a standard markdown file (`core-memory.md`), the user gains full transparency and the ability to manually edit, organize, or version-control their core agent instructions, while the `search_memory` tool handles the vast, messy history of topical facts behind the scenes.

**Category classification:**

| Category | Storage Location | Rationale |
|----------|---------------|-----------|
| `preference` | `core-memory.md` | Style/UX preferences apply to every response |
| `instruction` | `core-memory.md` | Explicit user directives must always be followed |
| `behavior` | `core-memory.md` | Communication style is always relevant |
| `personal` | SQLite (Vector) | Name/relationships are topical |
| `professional` | SQLite (Vector) | Job context is topical |
| `project` | SQLite (Vector) | Project details are topical |
| `general` | SQLite (Vector) | Catch-all, topical by default |

### 4.3 Memory Tool Definition

The agent is provided with the following tool for topical recall:

```typescript
{
  name: 'search_memory',
  description: 'Search the user\'s long-term memory for facts, past conversations, or context relevant to the current task. Use this when you need to recall project details, past decisions, or specific facts the user mentioned previously.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query to find relevant memories (e.g., "React setup instructions", "Alex\'s dog\'s name")'
      }
    },
    required: ['query']
  }
}
```

The injected global context block is read directly from `core-memory.md` and wrapped like this:

```
<agent_memory>
The following are core rules and preferences you must always follow for this user:

# User Profile
- Name: Alex
- Role: Senior Engineer

# Communication
- Always use TypeScript instead of plain JavaScript
- Prefer concise, direct answers
</agent_memory>
```

### 4.4 Async processing model

Memory writes are fire-and-forget from the TurnManager's perspective:

```typescript
// In TurnManager, after turn completion:
void this.memoryService.processConversation(turnMessages).catch(err => {
  logger.warn('Memory extraction failed (non-critical)', err);
});
```

Failures in memory extraction never affect the user's conversation. Memory is a best-effort enhancement.

### 4.5 Sequential processing queue (race condition prevention)

**Problem:** If a user sends 2-3 messages in rapid succession, TurnManager spawns concurrent `processConversation` calls. They all read the existing memory state simultaneously, evaluate in parallel, and write — causing duplicate insertions or clobbered updates.

**Solution:** `MemoryService` maintains an internal **async processing queue** scoped per userId. Memory extraction for a given user always runs sequentially:

```typescript
// src/core/memory/MemoryService.ts

export class MemoryService {
  private processingQueues = new Map<string, Promise<void>>();

  async processConversation(messages: ResponseItem[], scope: MemoryScope): Promise<void> {
    const queueKey = scope.userId ?? 'default';

    // Chain onto the existing queue for this user
    const previousTask = this.processingQueues.get(queueKey) ?? Promise.resolve();
    const currentTask = previousTask
      .then(() => this._doProcessConversation(messages, scope))
      .catch(err => logger.warn('Memory extraction failed', err));

    this.processingQueues.set(queueKey, currentTask);

    // Cleanup: remove queue entry when chain is idle
    currentTask.then(() => {
      if (this.processingQueues.get(queueKey) === currentTask) {
        this.processingQueues.delete(queueKey);
      }
    });
  }

  private async _doProcessConversation(messages: ResponseItem[], scope: MemoryScope): Promise<void> {
    // Actual extraction + embed + store logic (runs sequentially per user)
  }
}
```

This ensures that each extraction sees the results of the previous one, preventing duplicate inserts and conflicting updates.

---

## 5. Fact Extraction

### 5.1 Extraction prompt

Adapted from Mem0's production-tested prompt, customized for our agent.

**Important:** The FactExtractor receives the **full recent conversation window** (both user and assistant messages). This is critical because user responses often reference assistant context — e.g., if the assistant asks "Do you prefer Tailwind or vanilla CSS?" and the user replies "I prefer the former," extracting from the user message alone yields nothing. The assistant's messages provide the context needed to resolve references, pronouns, and elliptical responses.

```
You are a memory extraction system. Your role is to identify and extract important
facts, preferences, and personal details about the USER from a conversation.

You will receive the full conversation including both user and assistant messages.
Use the assistant's messages ONLY as context to understand what the user is
referring to. Extract facts ONLY about the user based on what they explicitly state
or clearly imply through their responses.

For example:
- Assistant: "Do you prefer Tailwind or vanilla CSS?"
- User: "The first one"
- Extract: "User prefers Tailwind CSS"

Types of information to extract:
1. Personal preferences (likes, dislikes, style preferences)
2. Personal details (name, role, relationships, important dates)
3. Professional context (job title, tech stack, tools, workflows)
4. Project details (project names, architecture, conventions)
5. Behavioral preferences (communication style, verbosity, format preferences)
6. Explicit instructions ("always do X", "never do Y", "I prefer Z")
7. Important context (goals, plans, constraints)

Rules:
- Extract facts about the USER only — do not extract assistant capabilities or behaviors
- Use assistant messages only to resolve references, pronouns, and context
- Each fact should be a single, atomic statement
- Resolve references before storing (e.g., "the first one" → the actual option name)
- Use the same language as the user's input
- Keep facts concise but complete
- Do not infer or assume information not explicitly stated
- If no extractable facts exist, return an empty array

Current date: {{currentDate}}

Return a JSON object: {"facts": ["fact1", "fact2", ...]}
```

### 5.2 Pre-processing filter (token burn prevention)

Before sending messages to the FactExtractor, apply pre-processing to avoid wasting tokens on messages that contain no extractable personal facts:

```typescript
// src/core/memory/FactExtractor.ts

function shouldExtract(messages: ResponseItem[]): boolean {
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return false;

  // Skip if the only user content is very short (greetings, "ok", "thanks")
  const totalUserChars = userMessages.reduce((sum, m) => sum + getTextLength(m), 0);
  if (totalUserChars < 20) return false;

  return true;
}

function preprocessForExtraction(messages: ResponseItem[]): ResponseItem[] {
  return messages.map(m => {
    if (m.role !== 'user') return m;

    let text = getTextContent(m);

    // Strip large code blocks (``` ... ```) — they're raw data, not personal facts
    text = text.replace(/```[\s\S]{500,}?```/g, '[code block removed]');

    // Truncate excessively long messages (e.g., pasted logs, data dumps)
    if (text.length > 2000) {
      text = text.slice(0, 2000) + '\n[...truncated for memory extraction]';
    }

    return { ...m, content: [{ type: 'input_text', text }] };
  });
}
```

**Rules:**
- Skip extraction entirely for trivial messages (<20 chars total user content)
- Strip code blocks longer than 500 chars (unlikely to contain personal facts)
- Truncate user messages over 2,000 chars (large pastes are data, not preferences)
- Assistant messages are passed through unmodified (they provide context only)

### 5.3 Few-shot examples (included in prompt)

```
Input: "Hi there"
Output: {"facts": []}

Input: "My name is Alex and I'm a senior engineer at Acme Corp. I mostly work with TypeScript."
Output: {"facts": ["User's name is Alex", "User is a senior engineer at Acme Corp", "User mostly works with TypeScript"]}

Input: "I prefer short, direct answers. Don't be too verbose."
Output: {"facts": ["User prefers short, direct answers", "User dislikes verbose responses"]}

Input: "We're using Svelte 4 with Tailwind for the frontend, and the backend is Rust with Tauri."
Output: {"facts": ["Project uses Svelte 4 with Tailwind for frontend", "Project backend uses Rust with Tauri"]}
```

### 5.4 Custom prompts

Users can override the extraction prompt via configuration:

```typescript
interface MemoryConfig {
  customExtractionPrompt?: string;
  customConflictResolutionPrompt?: string;
}
```

---

## 6. Conflict Resolution & Merging

### 6.1 Topical DB Conflict Resolution Prompt

When new topical facts are extracted and similar existing memories are found in SQLite, the LLM decides what to do:

```
You are a memory manager. Compare new facts against existing memories and decide
the appropriate action for each new fact.

Actions:
- ADD: The fact is new information not covered by existing memories
- UPDATE: The fact updates or refines an existing memory (provide the memory ID to update)
- DELETE: The fact contradicts an existing memory that should be removed (provide the memory ID)
- NONE: The fact is already captured by existing memories (no action needed)

Rules:
- UPDATE when new info refines existing (e.g., "likes pizza" → "loves pepperoni pizza")
- NONE when facts convey the same meaning (e.g., "likes pizza" ≈ "enjoys pizza")
- DELETE when facts directly contradict (e.g., "is vegetarian" vs "eats steak regularly")
- ADD when the fact is genuinely new
- When in doubt between UPDATE and NONE, choose NONE (avoid unnecessary writes)

IMPORTANT — Handling explicit deletion requests:
If the user explicitly asks to forget, remove, or delete information (e.g., "forget everything
about my React preferences", "stop remembering my name", "delete my dietary info"), you MUST
output DELETE decisions for all matching existing memories. Do NOT add a new fact like "user
wants to forget X" — actually delete the matching memories. If the deletion request is broad
(e.g., "forget everything"), output DELETE for all existing memories.

Existing memories:
{{existingMemories}}

New facts:
{{newFacts}}

Return JSON:
{
  "decisions": [
    {"fact": "...", "action": "ADD|UPDATE|DELETE|NONE", "memoryId": "...", "reasoning": "..."}
  ]
}
```

### 6.3 Core Memory Merging

When facts are categorized as core (`preference`, `instruction`, or `behavior`), they bypass the SQLite vector store entirely. Instead, they are merged into the user's `core-memory.md` file.

**Component:** `src/core/memory/CoreMemoryManager.ts`

**Merge Prompt:**
```
You are a memory manager responsible for maintaining the user's core profile.
Merge the following newly learned core preferences into the existing core-memory.md file.

Rules:
- Integrate the new facts logically under existing headings, or create new headings if needed.
- Maintain the exact markdown formatting and structure.
- Replace or delete outdated information that directly contradicts the new facts.
- Do NOT erase unrelated existing information.
- Return the COMPLETE updated markdown file content.

Existing core-memory.md:
{{existingMarkdown}}

New core facts to merge:
{{newFacts}}
```

Following Mem0's pattern: before sending to the LLM, replace real UUIDs with sequential integer IDs (0, 1, 2...). Map them back after receiving the response. This prevents the LLM from generating non-existent memory IDs.

```typescript
// Before LLM call
const idMap = new Map<string, string>();
existingMemories.forEach((m, i) => {
  idMap.set(String(i), m.id);
  m.displayId = String(i);  // LLM sees "0", "1", "2"
});

// After LLM response
decisions.forEach(d => {
  if (d.memoryId) {
    d.memoryId = idMap.get(d.memoryId) ?? d.memoryId;
  }
});
```

---

## 7. Embedding Generation

### 7.1 Provider abstraction

```typescript
// src/core/memory/EmbeddingClient.ts

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  getDimensions(): number;
}
```

### 7.2 Supported providers

| Provider | Model | Dimensions | Notes |
|----------|-------|-----------|-------|
| OpenAI | `text-embedding-3-small` | 1536 | Default. Best cost/quality ratio. |
| OpenAI | `text-embedding-3-large` | 3072 | Higher quality, higher cost. |
| Google | `text-embedding-004` | 768 | For users on Google AI Studio. |

The embedding provider is selected based on the user's configured LLM provider. If using OpenAI for chat, use OpenAI for embeddings. If using Google, use Google embeddings.

### 7.3 Implementation

```typescript
// OpenAI example
async embed(text: string): Promise<Float32Array> {
  const response = await this.openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.replace(/\n/g, ' '),  // Normalize newlines
  });
  return new Float32Array(response.data[0].embedding);
}
```

### 7.4 Caching

Embedding API calls are expensive. Cache embeddings for frequently used queries:
- User messages that are identical to recent queries → cache hit
- Use content hash as cache key
- Cache lives in memory (not persisted), cleared on session end
- Max cache size: 100 entries (LRU eviction)

---

## 8. Vector Storage & Search

### 8.1 sqlite-vec integration (Desktop / Rust)

**Cargo.toml addition:**
```toml
[dependencies]
sqlite-vec = "0.1"
zerocopy = { version = "0.7", features = ["derive"] }
```

**Initialization (in `tauri/src/memory_commands.rs`):**
```rust
use sqlite_vec::sqlite3_vec_init;
use rusqlite::ffi::sqlite3_auto_extension;

// Register sqlite-vec at app startup (before any DB connections)
unsafe {
    sqlite3_auto_extension(Some(std::mem::transmute(
        sqlite3_vec_init as *const ()
    )));
}
```

**Tauri IPC commands:**
```rust
#[tauri::command]
pub async fn memory_search(
    embedding: Vec<f32>,   // Query vector
    limit: usize,          // Top-K results
    user_id: Option<String>,
) -> Result<Vec<MemorySearchRow>, String>;

#[tauri::command]
pub async fn memory_insert(
    id: String,
    embedding: Vec<f32>,
    fact_text: String,
    category: String,
    user_id: Option<String>,
    content_hash: String,
    metadata: Option<String>,  // JSON
) -> Result<(), String>;

#[tauri::command]
pub async fn memory_update(
    id: String,
    embedding: Vec<f32>,
    fact_text: String,
    category: String,
    content_hash: String,
) -> Result<(), String>;

#[tauri::command]
pub async fn memory_delete(id: String) -> Result<(), String>;

#[tauri::command]
pub async fn memory_get_all(
    user_id: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<MemoryFactRow>, String>;
```

### 8.2 sqlite-vec integration (Server / Node.js)

**Installation:**
```bash
npm install sqlite-vec
```

**Loading the extension:**
```typescript
import * as sqliteVec from 'sqlite-vec';

// After creating better-sqlite3 connection:
sqliteVec.load(db);
```

**Build requirement:** `better-sqlite3` must be compiled with loadable-extension support enabled. By default, `better-sqlite3` supports `loadExtension()`, but this can be disabled by build flags. Verify that the project's `better-sqlite3` build configuration does not pass `--disable-extension-loading`. If using prebuilt binaries (e.g., via `prebuild-install`), ensure the binary was built with extension support.

### 8.3 KNN search query

```sql
SELECT
  mf.id,
  mf.fact_text,
  mf.category,
  mf.user_id,
  mf.metadata,
  mf.created_at,
  mf.access_count,
  me.distance
FROM memory_embeddings me
INNER JOIN memory_facts mf ON mf.id = me.memory_id
WHERE me.embedding MATCH ?1       -- ?1 = query embedding as bytes
  AND k = ?2                       -- ?2 = limit (top-K)
ORDER BY me.distance
```

With optional scope filtering (post-filter since vec0 doesn't support WHERE on metadata):

```typescript
// Apply scope filter in application code after KNN results
results = results.filter(r => {
  if (scope.userId && r.userId !== scope.userId) return false;
  return true;
});
```

### 8.4 Performance characteristics

| Dataset size | Search latency | Notes |
|-------------|---------------|-------|
| 100 memories | <0.1 ms | Trivial |
| 1,000 memories | <1 ms | Typical user after months of use |
| 10,000 memories | ~5 ms | Power user after years |
| 100,000 memories | ~50 ms | Unlikely for personal agent memory |

sqlite-vec uses brute-force search with SIMD acceleration (AVX2/NEON). No index building or warm-up required. For the expected scale of agent memory (hundreds to low thousands), this is more than adequate.

---

## 9. Integration Points

### 9.1 Session integration

```typescript
// src/core/Session.ts — add MemoryService to session

export class Session {
  private memoryService: MemoryService;

  constructor(/* existing params */, memoryStore: MemoryStore) {
    this.memoryService = new MemoryService(memoryStore, this.modelClient);
  }
}
```

### 9.2 TurnManager integration

**Before turn (read path):**
```typescript
// In TurnManager.executeTurn(), before building the request:
const relevantMemories = await this.session.memoryService.recall(
  userMessage,
  { userId: this.session.userId },
  10  // top-K
);

// Inject into system prompt
if (relevantMemories.length > 0) {
  const memoryBlock = formatMemoryContext(relevantMemories);
  request.base_instructions_override = baseInstructions + '\n\n' + memoryBlock;
}
```

**After turn (write path):**
```typescript
// In TurnManager, after response is delivered:
void this.session.memoryService.processConversation(
  turnMessages,
  { userId: this.session.userId }
).catch(err => logger.warn('Memory extraction failed', err));
```

### 9.3 CompactService integration

When compaction occurs, the summary should NOT be used for memory extraction (it's already a summary of previous messages that may have been processed). The memory system tracks which messages have been processed via a high-water mark:

```typescript
interface MemoryProcessingState {
  lastProcessedMessageIndex: number;  // Avoid re-processing compacted history
}
```

### 9.4 Configuration

```typescript
// src/core/memory/types.ts

export interface MemoryConfig {
  enabled: boolean;                      // Default: true
  embeddingModel: string;                // Default: auto-detect from LLM provider
  embeddingDimensions: number;           // Default: 1536
  maxMemories: number;                   // Default: 10000 (soft limit, warn user)
  recallLimit: number;                   // Default: 10 (top-K for retrieval)
  extractionModel?: string;              // Default: same as chat model
  customExtractionPrompt?: string;       // Override default extraction prompt
  customConflictPrompt?: string;         // Override default conflict resolution prompt
  excludeCategories?: MemoryCategory[];  // Categories to skip during extraction
}
```

---

## 10. File Structure

```
src/core/memory/
  ├── MemoryService.ts          # Orchestrator (extract → embed → store → retrieve)
  ├── FactExtractor.ts          # LLM-based fact extraction
  ├── ConflictResolver.ts       # LLM-based ADD/UPDATE/DELETE/NONE decisions
  ├── EmbeddingClient.ts        # Embedding provider abstraction
  ├── MemoryStore.ts            # Abstract store interface
  ├── MemoryHistory.ts          # Audit log operations
  ├── createMemoryStore.ts      # Factory (build mode routing)
  ├── prompts/
  │   ├── extraction.md         # Fact extraction prompt template
  │   └── conflict.md           # Conflict resolution prompt template
  ├── types.ts                  # MemoryFact, MemoryConfig, etc.
  └── __tests__/
      ├── MemoryService.test.ts
      ├── FactExtractor.test.ts
      ├── ConflictResolver.test.ts
      └── MemoryStore.test.ts

src/desktop/storage/
  └── TauriMemoryStore.ts       # Desktop: Tauri IPC → Rust sqlite-vec

src/server/storage/
  └── NodeMemoryStore.ts        # Server: better-sqlite3 + sqlite-vec

tauri/src/
  └── memory_commands.rs        # Rust: sqlite-vec operations + Tauri commands
```

---

## 11. Embedding Provider Selection

The embedding model is automatically selected based on the user's configured LLM provider:

```typescript
function selectEmbeddingProvider(llmProvider: ModelProvider): EmbeddingProviderConfig {
  switch (llmProvider) {
    case 'openai':
    case 'xai':
    case 'groq':
    case 'together':
    case 'fireworks':
      // These providers use OpenAI-compatible APIs
      return { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };

    case 'google-ai-studio':
      return { provider: 'google', model: 'text-embedding-004', dimensions: 768 };

    case 'anthropic':
      // Anthropic doesn't offer embeddings — fall back to OpenAI
      return { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };

    default:
      return { provider: 'openai', model: 'text-embedding-3-small', dimensions: 1536 };
  }
}
```

**Important:** If the user switches embedding providers, all existing memories must be re-embedded (dimensions may differ). This is a migration operation, not a runtime concern.

---

## 12. Future Extensions (Not in V1)

### 12.1 Episodic memory
Store summaries of entire conversations (not just facts) for "what did we discuss last week?" queries. Would use the existing CompactService summaries as input.

### 12.2 Procedural memory
Track learned behaviors: "User always asks me to run tests after code changes." Would feed back into the agent's system prompt as behavioral rules.

### 12.3 Memory decay
Time-based relevance weighting: memories accessed frequently stay strong, rarely-accessed memories fade. The `lastAccessedAt` and `accessCount` fields are already in the schema to support this.

### 12.4 Memory management UI
A settings panel showing stored memories with ability to view, edit, and delete. Not needed for V1 — the system should work silently.

### 12.5 Graph memory
Entity-relationship graph for multi-hop reasoning (e.g., "Alex works at Acme" + "Acme uses React" → knows Alex likely uses React). Would require adding a graph layer on top of sqlite-vec.

### 12.6 Cross-device sync
Sync memories across desktop and server instances. Would require a sync protocol — out of scope for V1.

---

## 13. Key Design Decisions (Reference from Mem0)

The following decisions are informed by studying Mem0's open-source implementation:

| Decision | Mem0's approach | Our approach | Rationale |
|----------|----------------|-------------|-----------|
| Dedup engine | LLM decides (no threshold) | Same — LLM decides | Numeric thresholds are brittle; LLM understands semantic equivalence |
| UUID mapping | Map to integers before LLM | Same | Prevents LLM from hallucinating memory IDs |
| Extraction scope | User facts from user msgs only | Full conversation fed, extract user facts only | Assistant messages provide context for resolving references and pronouns |
| Content hashing | MD5 hash stored per memory | Same | Fast exact-match dedup before expensive LLM comparison |
| History/audit | SQLite table with before/after | Same | Full audit trail for debugging and future undo support |
| Temporal decay | Not implemented | Schema supports it, not in V1 | Fields exist (`lastAccessedAt`, `accessCount`) for future use |
| Custom prompts | User-configurable | Same | Power users can tune extraction for their domain |
| Async processing | Sync in Mem0 (blocks on add) | Async with per-user sequential queue | Non-blocking but serialized per user to prevent race conditions |
| Retrieval strategy | Single vector search | Dual-path (always-inject globals + vector search topical) | Global preferences are invisible to semantic search on task-specific queries |
| Input preprocessing | Send raw messages | Strip code blocks, truncate large pastes | Prevents token waste on data dumps with zero extractable facts |
| Forget handling | Not explicit in prompts | Explicit DELETE instructions in conflict prompt | Users expect "forget X" to actually delete, not add a meta-memory |
| Embedding batching | Per-fact sequential | Batch all facts in single API call | Reduces N API round-trips to 1, lowers latency and rate limit risk |
| Vector store | Qdrant (external) | sqlite-vec (embedded) | Single-binary deployment, no sidecar processes |
| Embedding model | Default `text-embedding-3-small` | Same default, auto-detect from provider | Best cost/quality ratio; Google users get Google embeddings |

---

## 14. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| LLM extraction produces low-quality facts | Noisy memories degrade future responses | Few-shot examples in prompt; NONE bias in conflict resolution; user can clear memories |
| Embedding API adds cost per conversation | Unexpected billing for users | Batch embedding calls (§4.1 step 5); cache embeddings; skip extraction for trivial messages (§5.2) |
| sqlite-vec not available on all platforms | Build failure on exotic architectures | sqlite-vec is pure C with no deps; fallback to brute-force cosine in TypeScript if needed |
| Memory grows unbounded | Storage bloat, slower search | `maxMemories` config (default 10,000); warn user; future: decay-based pruning |
| Provider switch requires re-embedding | Data migration complexity | Detect dimension mismatch at startup; auto-migrate schema + background re-embed (§3.5) |
| Memory injection bloats context window | Reduces space for actual conversation | Limit recalled memories (default 10); format concisely; respect token budget |
| Global preferences missed by vector search | User style preferences ignored | Dual-path recall: always-inject for preference/instruction/behavior categories (§4.2) |
| Context loss from pronoun references | "I prefer the former" extracts nothing | Feed full conversation (user + assistant) to FactExtractor (§5.1) |
| Race conditions on rapid messages | Duplicate inserts, clobbered updates | Per-user sequential processing queue in MemoryService (§4.5) |
| Large pastes burn tokens in extraction | Slow, expensive, zero useful facts | Pre-processing filter: strip code blocks >500 chars, truncate messages >2000 chars (§5.2) |
| User says "forget X" but memory persists | Trust violation, user frustration | Explicit deletion handling in conflict resolution prompt (§6.1) |
| better-sqlite3 extension loading disabled | sqlite-vec fails to load on server | Verify build config does not disable loadable extensions (§8.2) |
