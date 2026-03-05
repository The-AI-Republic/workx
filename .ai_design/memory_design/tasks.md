# Agent Memory System — Implementation Tasks

Reference: [agent_memory_system_design.md](./agent_memory_system_design.md)

---

## Phase 1: Foundation — Types, Schema & Storage Infrastructure

### Task 1.1: Define core types and interfaces
- **File:** `src/core/memory/types.ts`
- **Description:**
  - Define `MemoryFact` interface (id, factText, category, scope, contentHash, timestamps, accessCount, metadata)
  - Define `MemoryCategory` union type (preference, personal, professional, project, behavior, instruction, general)
  - Define `MemoryScope` interface (userId, agentId, sessionId)
  - Define `MemoryOperation` interface (id, memoryId, event, oldContent, newContent, timestamp)
  - Define `MemorySearchResult` interface (fact, distance)
  - Define `MemoryConfig` interface (enabled, embeddingModel, embeddingDimensions, maxMemories, recallLimit, extractionModel, customExtractionPrompt, customConflictPrompt, excludeCategories)
  - Define `MemoryProcessingState` interface (lastProcessedMessageIndex)
  - Define `ALWAYS_INJECT_CATEGORIES` constant array: `['preference', 'instruction', 'behavior']`
  - Define `DEFAULT_MEMORY_CONFIG` with sensible defaults (enabled: true, dimensions: 1536, maxMemories: 10000, recallLimit: 10)
- **Depends on:** Nothing
- **Design ref:** §3.1, §3.2, §3.3, §9.4

### Task 1.2: Define MemoryStore abstract interface
- **File:** `src/core/memory/MemoryStore.ts`
- **Description:**
  - Define abstract `MemoryStore` class/interface with methods:
    - `initialize(config: MemoryConfig): Promise<void>`
    - `insert(fact: MemoryFact, embedding: Float32Array): Promise<void>`
    - `update(id: string, fact: Partial<MemoryFact>, embedding: Float32Array): Promise<void>`
    - `delete(id: string): Promise<void>`
    - `search(embedding: Float32Array, limit: number, scope?: MemoryScope): Promise<MemorySearchResult[]>`
    - `getByCategories(categories: MemoryCategory[], scope?: MemoryScope): Promise<MemoryFact[]>`
    - `getById(id: string): Promise<MemoryFact | null>`
    - `getAll(scope?: MemoryScope, limit?: number): Promise<MemoryFact[]>`
    - `updateAccessStats(ids: string[]): Promise<void>`
    - `count(scope?: MemoryScope): Promise<number>`
    - `getSchemaDimensions(): Promise<number | null>`
    - `migrateDimensions(newDimensions: number): Promise<void>`
    - `close(): Promise<void>`
  - Define `MemoryHistoryStore` interface:
    - `logOperation(op: MemoryOperation): Promise<void>`
    - `getHistory(memoryId: string): Promise<MemoryOperation[]>`
    - `getAllHistory(limit?: number, offset?: number): Promise<MemoryOperation[]>`
- **Depends on:** Task 1.1
- **Design ref:** §2.2, §3.5

### Task 1.3: Create MemoryStore factory with build mode routing
- **File:** `src/core/memory/createMemoryStore.ts`
- **Description:**
  - Implement factory function following the existing `createStorageAdapter.ts` pattern
  - Route to `TauriMemoryStore` for `__BUILD_MODE__ === 'desktop'`
  - Route to `NodeMemoryStore` for `__BUILD_MODE__ === 'server'`
  - Throw error for `'extension'` build mode (memory not supported in BrowserX)
  - Use dynamic imports to avoid bundling unused platform code
- **Depends on:** Task 1.2
- **Design ref:** §2.3

### Task 1.4: Add sqlite-vec to Tauri/Rust backend
- **Files:** `tauri/Cargo.toml`, `tauri/src/main.rs`
- **Description:**
  - Add `sqlite-vec = "0.1"` and `zerocopy = { version = "0.7", features = ["derive"] }` to Cargo.toml
  - Register sqlite-vec extension at app startup via `sqlite3_auto_extension()` in `main.rs`, before any DB connections are opened
  - Verify the extension loads correctly with a `SELECT vec_version()` health check
  - Handle the `unsafe` block for `sqlite3_auto_extension` with appropriate comments
- **Depends on:** Nothing
- **Design ref:** §8.1

### Task 1.5: Implement Rust memory schema migration
- **File:** `tauri/src/memory_commands.rs` (new file)
- **Description:**
  - Create the `memory_facts` table with all columns (id, fact_text, category, user_id, agent_id, session_id, content_hash, created_at, updated_at, last_accessed_at, access_count, metadata)
  - Create the `memory_embeddings` vec0 virtual table with configurable dimensions
  - Create the `memory_history` table (id, memory_id, event, old_content, new_content, timestamp)
  - Create the `memory_meta` table (key, value) for storing schema metadata (embedding_dimensions, embedding_provider, schema_version, migration_status)
  - Create all indexes (idx_memory_facts_user, idx_memory_facts_category, idx_memory_facts_hash, idx_memory_history_memory)
  - Insert initial metadata row for embedding_dimensions and set migration_status to 'COMPLETE'
  - Run migration only if tables don't exist (idempotent)
  - Integrate with existing Tauri storage initialization flow
- **Depends on:** Task 1.4
- **Design ref:** §3.4, §3.5

### Task 1.6: Implement Rust Tauri IPC commands for memory operations
- **File:** `tauri/src/memory_commands.rs`
- **Description:**
  - Implement `memory_search` command: accepts embedding Vec<f32>, limit, optional user_id; performs KNN search via `SELECT ... FROM memory_embeddings WHERE embedding MATCH ? AND k = ?`, JOINs with memory_facts, returns results
  - Implement `memory_insert` command: inserts into both memory_facts and memory_embeddings in a transaction
  - Implement `memory_update` command: updates both tables in a transaction
  - Implement `memory_delete` command: deletes from both tables in a transaction
  - Implement `memory_get_by_categories` command: SELECT from memory_facts WHERE category IN (...)
  - Implement `memory_get_all` command: SELECT from memory_facts with optional user_id filter and limit
  - Implement `memory_update_access_stats` command: batch update last_accessed_at and increment access_count
  - Implement `memory_count` command: COUNT(*) with optional scope filter
  - Implement `memory_get_schema_dimensions` command: read from memory_meta
  - Implement `memory_migrate_dimensions` command: DROP and recreate vec0 table with new dimensions, update memory_meta
  - Implement `memory_log_operation` command: INSERT into memory_history
  - Implement `memory_get_history` command: SELECT from memory_history
  - Use zerocopy for efficient Vec<f32> → byte conversion
  - Register all commands in `tauri/src/main.rs` command handler
- **Depends on:** Task 1.5
- **Design ref:** §8.1, §8.3

### Task 1.7: Implement TauriMemoryStore (desktop adapter)
- **File:** `src/desktop/storage/TauriMemoryStore.ts`
- **Description:**
  - Implement `MemoryStore` interface
  - Each method calls the corresponding Tauri `invoke()` command from Task 1.6
  - Handle Float32Array ↔ number[] conversion for Tauri IPC serialization
  - Implement `MemoryHistoryStore` by calling `memory_log_operation` and `memory_get_history` commands
  - Handle initialization: call schema migration on first use, check dimension mismatch
- **Depends on:** Task 1.2, Task 1.6
- **Design ref:** §2.3, §8.1

### Task 1.8: Add sqlite-vec to server mode (Node.js)
- **Files:** `package.json`, `src/server/storage/NodeMemoryStore.ts`
- **Description:**
  - Add `sqlite-vec` as an optional dependency in package.json
  - Verify that the project's `better-sqlite3` is compiled with loadable-extension support
  - Implement `NodeMemoryStore` class implementing `MemoryStore` interface
  - Load sqlite-vec extension via `sqliteVec.load(db)` after opening better-sqlite3 connection
  - Run schema migration (same SQL as Rust, but via better-sqlite3 `exec()`)
  - Implement all MemoryStore methods using better-sqlite3 prepared statements
  - Implement `MemoryHistoryStore` methods
  - Handle Float32Array → Buffer conversion for sqlite-vec binary format
  - Handle dimension mismatch detection and migration
- **Depends on:** Task 1.2
- **Design ref:** §8.2, §8.3

---

## Phase 2: Embedding System

### Task 2.1: Define EmbeddingProvider interface and factory
- **Files:** `src/core/memory/EmbeddingClient.ts`
- **Description:**
  - Define `EmbeddingProvider` interface: `embed(text)`, `embedBatch(texts)`, `getDimensions()`
  - Implement `EmbeddingClientFactory` that selects provider based on the user's LLM provider config
  - OpenAI/xai/groq/together/fireworks → OpenAI embeddings (1536)
  - Google → Google embeddings (768)
  - Anthropic → fallback to OpenAI embeddings (1536)
  - Default → OpenAI embeddings (1536)
  - Return provider config including model name and dimensions
- **Depends on:** Task 1.1
- **Design ref:** §7.1, §7.2, §11

### Task 2.2: Implement OpenAI embedding provider
- **File:** `src/core/memory/embeddings/OpenAIEmbeddingProvider.ts`
- **Description:**
  - Implement `EmbeddingProvider` interface using OpenAI SDK
  - Use `openai.embeddings.create()` with model `text-embedding-3-small` (default)
  - Implement `embed(text)`: normalize newlines, single embedding call, return Float32Array
  - Implement `embedBatch(texts)`: send all texts in single API call, return Float32Array[]
  - Handle API errors gracefully (rate limits, auth errors, network failures)
  - Respect configurable model override (e.g., `text-embedding-3-large`)
  - Pre-process text: replace newlines with spaces, trim whitespace
- **Depends on:** Task 2.1
- **Design ref:** §7.3

### Task 2.3: Implement Google embedding provider
- **File:** `src/core/memory/embeddings/GoogleEmbeddingProvider.ts`
- **Description:**
  - Implement `EmbeddingProvider` interface using Google AI SDK
  - Use `text-embedding-004` model (768 dimensions)
  - Implement `embed()` and `embedBatch()` methods
  - Handle Google-specific API format differences
  - Handle API errors gracefully
- **Depends on:** Task 2.1
- **Design ref:** §7.2

### Task 2.4: Implement embedding LRU cache
- **File:** `src/core/memory/EmbeddingCache.ts`
- **Description:**
  - Implement in-memory LRU cache for embedding results
  - Cache key: MD5 hash of input text
  - Max cache size: 100 entries (configurable)
  - Eviction policy: least recently used
  - Cache lives in memory only, not persisted, cleared on session end
  - Wrap the EmbeddingProvider so cache is transparent to callers
  - Track cache hit/miss stats for debugging
- **Depends on:** Task 2.1
- **Design ref:** §7.4

---

## Phase 3: Fact Extraction

### Task 3.1: Create extraction prompt template
- **File:** `src/core/memory/prompts/extraction.md`
- **Description:**
  - Write the fact extraction prompt as a markdown template file
  - Include the system prompt with all 7 extraction categories
  - Include the rule that full conversation is provided but facts are extracted about the USER only
  - Include the reference resolution instruction (assistant messages provide context for "the former", "that one", etc.)
  - Include the `{{currentDate}}` template variable
  - Include few-shot examples (4 examples from design doc §5.3)
  - Include the JSON output format instruction: `{"facts": ["fact1", ...]}`
  - Import as raw string via Vite's `?raw` import pattern (matching existing `compact_summarization.md` pattern)
- **Depends on:** Nothing
- **Design ref:** §5.1, §5.3

### Task 3.2: Create conflict resolution prompt template
- **File:** `src/core/memory/prompts/conflict.md`
- **Description:**
  - Write the conflict resolution prompt as a markdown template file
  - Include ADD/UPDATE/DELETE/NONE action definitions
  - Include the UPDATE vs NONE distinction rules
  - Include the explicit "forget" command handling instructions (DELETE matching memories, do not add meta-memory)
  - Include `{{existingMemories}}` and `{{newFacts}}` template variables
  - Include the JSON output format: `{"decisions": [{"fact", "action", "memoryId", "reasoning"}]}`
- **Depends on:** Nothing
- **Design ref:** §6.1

### Task 3.3: Implement FactExtractor
- **File:** `src/core/memory/FactExtractor.ts`
- **Description:**
  - Implement `FactExtractor` class with `extract(messages: ResponseItem[]): Promise<string[]>`
  - Implement `shouldExtract(messages)` pre-check:
    - Return false if no user messages
    - Return false if total user content < 20 chars
  - Implement `preprocessForExtraction(messages)`:
    - Strip code blocks > 500 chars from user messages (replace with `[code block removed]`)
    - Truncate user messages > 2000 chars (append `[...truncated for memory extraction]`)
    - Pass assistant messages through unmodified
  - Build the extraction prompt from template, inject `{{currentDate}}`
  - Call the LLM via existing `ModelClient.complete()` or equivalent
  - Parse the JSON response, extract `facts` array
  - Handle malformed LLM responses gracefully (return empty array)
  - Support custom extraction prompt override via `MemoryConfig.customExtractionPrompt`
  - Use a fast/cheap model for extraction if configured (e.g., `gpt-4.1-nano`)
- **Depends on:** Task 3.1, Task 1.1
- **Design ref:** §5.1, §5.2, §5.4

### Task 3.4: Implement ConflictResolver for Topical Memories
- **File:** `src/core/memory/ConflictResolver.ts`
- **Description:**
  - Implement `ConflictResolver` class with `resolve(newFacts, existingMemories): Promise<MemoryDecision[]>`
  - Define `MemoryDecision` type: `{fact, action: 'ADD'|'UPDATE'|'DELETE'|'NONE', memoryId?, reasoning?}`
  - Implement UUID hallucination prevention:
    - Map existing memory UUIDs to sequential integers (0, 1, 2...) before sending to LLM
    - Map integer IDs back to real UUIDs after receiving LLM response
    - Validate that returned memoryIds exist in the mapping
  - Build the conflict resolution prompt from template
  - Format existing memories as numbered list with content and category
  - Format new facts as numbered list
  - Call the LLM via existing `ModelClient.complete()`
  - Parse the JSON response, extract `decisions` array
  - Handle malformed responses (default to ADD for new facts)
  - Support custom conflict prompt override via `MemoryConfig.customConflictPrompt`
  - If no existing memories found, skip conflict resolution and ADD all new facts directly
- **Depends on:** Task 3.2, Task 1.1
- **Design ref:** §6.1, §6.2

### Task 3.5: Implement CoreMemoryManager
- **File:** `src/core/memory/CoreMemoryManager.ts`
- **Description:**
  - Implement `CoreMemoryManager` class to handle `core-memory.md`
  - Create a method to ensure the `core-memory.md` file exists in the user's data directory (specifically within the `~/.airepublic-pi/memory/` directory or the OS equivalent provided by the Tauri/Node paths config).
  - Create `mergeCoreFacts(facts: string[]): Promise<void>`
    - Read the existing contents of `core-memory.md`
    - Build the merge prompt combining the existing markdown and the list of new core facts
    - Call the LLM to return the fully updated markdown string
    - Write the updated string back to `core-memory.md`
  - Create `getCoreMemoryContent(): Promise<string>` to read the file for the read path
  - Handle file system errors (e.g., fallback to creating a blank template if missing)
- **Depends on:** Task 1.1
- **Design ref:** §6.3

---

## Phase 4: Memory Service Orchestrator

### Task 4.1: Implement MemoryService — write path
- **File:** `src/core/memory/MemoryService.ts`
- **Description:**
  - Implement `MemoryService` class that orchestrates the full write pipeline
  - Constructor takes `MemoryStore`, `EmbeddingProvider`, `ModelClient`, `MemoryConfig`
  - Implement `processConversation(messages, scope)`:
    1. Pre-process messages via FactExtractor's preprocessor
    2. Check `shouldExtract()` — return early if nothing to extract
    3. Call `FactExtractor.extract(messages)` → string[]
    4. If no facts extracted, return early
    5. Split facts into core (`preference`, `instruction`, `behavior`) and topical (everything else)
    6. For **core facts**:
       - Pass to `CoreMemoryManager.mergeCoreFacts(coreFacts)`
    7. For **topical facts**:
       - Call `EmbeddingClient.embedBatch(topicalFacts)` → Float32Array[]
       - For each fact+embedding, call `MemoryStore.search(embedding, 5, scope)` to find similar existing memories
       - Deduplicate existing memories by ID across all search results
       - If existing memories found, call `ConflictResolver.resolve(newFacts, existingMemories)`
       - If no existing memories, default all facts to ADD
       - Execute each decision: insert/update/delete via MemoryStore + log via MemoryHistory
       - For ADD: generate UUID, compute SHA-256 content hash, create MemoryFact, insert
       - For UPDATE: update fact text, re-use existing embedding or provided new one, update timestamps
       - For DELETE: delete from store, log old content
  - Handle errors at each step gracefully — never throw, always log and continue
  - Check `maxMemories` limit before ADDs, log warning if approaching limit
- **Depends on:** Task 1.2, Task 2.1, Task 3.3, Task 3.4, Task 3.5
- **Design ref:** §4.1

### Task 4.2: Implement MemoryService — per-user sequential processing queue
- **File:** `src/core/memory/MemoryService.ts`
- **Description:**
  - Add `processingQueues: Map<string, Promise<void>>` to MemoryService
  - Wrap `processConversation()` to chain onto the existing queue for the given userId
  - Each call to `processConversation()` waits for the previous one (for the same user) to complete before starting
  - Slice messages and update `lastProcessedMessageIndex` *inside* the execution of the queue item, not when queuing, to prevent race conditions
  - Cleanup: remove queue entry when the chain is idle
  - Ensure errors in one queue item don't prevent subsequent items from running (catch per item)
  - This prevents race conditions when users send rapid messages
- **Depends on:** Task 4.1
- **Design ref:** §4.5

### Task 4.3: Implement MemoryService — read path (global recall)
- **File:** `src/core/memory/MemoryService.ts`
- **Description:**
  - Implement `getGlobalContextText(): Promise<string>`
  - Call `CoreMemoryManager.getCoreMemoryContent()` to read `core-memory.md`
  - Return the raw markdown string
  - Implement `searchTopical(query, scope, limit): Promise<MemorySearchResult[]>`
    - Embed the query using `EmbeddingClient.embed(query)`
    - Call `MemoryStore.search(embedding, limit, scope)`
    - Exclude categories already covered by the global path
    - Return the MemorySearchResult array
- **Depends on:** Task 4.1
- **Design ref:** §4.2

### Task 4.4: Implement memory context formatter
- **File:** `src/core/memory/MemoryService.ts` (or separate `formatMemoryContext.ts`)
- **Description:**
  - Implement `formatGlobalMemoryContext(coreMarkdown: string): string`
  - Format as `<agent_memory>` XML block containing the core rules instructions and the raw markdown content
  - Return empty string if the core memory file is empty or missing
- **Depends on:** Task 1.1
- **Design ref:** §4.3

---

## Phase 5: Integration with Agent Pipeline

### Task 5.1: Integrate MemoryService into Session
- **File:** `src/core/Session.ts`
- **Description:**
  - Add `memoryService: MemoryService | null` property to Session
  - In Session constructor or initialization:
    - Check `__BUILD_MODE__` — only create MemoryService for desktop/server
    - Call `createMemoryStore()` to get platform-specific store
    - Create `EmbeddingProvider` via factory based on the user's LLM provider config
    - Instantiate `MemoryService` with store, embedding provider, model client, and config
    - Call `memoryStore.initialize(config)` (includes dimension mismatch check)
  - Expose `getMemoryService()` getter for TurnManager access
  - Handle initialization failures gracefully — log warning, set memoryService to null, agent works without memory
- **Depends on:** Task 4.1, Task 4.2, Task 4.3, Task 1.3
- **Design ref:** §9.1

### Task 5.2: Integrate global memory recall and define search tool (read path)
- **File:** `src/core/TurnManager.ts` & `src/tools/MemorySearchTool.ts`
- **Description:**
  - Create a new tool file `src/tools/MemorySearchTool.ts` that defines the `search_memory` tool interface and hooks into `session.getMemoryService().searchTopical(query, scope)`
  - Register this tool in `ToolRegistry` so the LLM has access to it on every turn
  - Before building the LLM request in `TurnManager.ts`, check if `session.getMemoryService()` is available
  - If available, call `memoryService.getGlobalContextText()`
  - If markdown content is returned, call `formatGlobalMemoryContext(markdown)` and append to `base_instructions_override`
  - Ensure memory recall does not block the turn if it fails — catch errors, log, continue without memories
- **Depends on:** Task 4.3, Task 4.4, Task 5.1
- **Design ref:** §9.2

### Task 5.3: Integrate memory extraction into TurnManager (write path)
- **File:** `src/core/TurnManager.ts`
- **Description:**
  - After the turn response is delivered to the user, call `memoryService.processConversation(turnMessages, scope)` as fire-and-forget
  - Use `void promise.catch(err => logger.warn(...))` pattern — never await, never throw
  - Only pass the current turn's messages (not the full history) to avoid re-extracting from old messages
  - Respect the `MemoryProcessingState.lastProcessedMessageIndex` to avoid re-processing compacted history
  - Skip extraction if the turn was a system/tool-only turn with no user messages
- **Depends on:** Task 4.1, Task 4.2, Task 5.1
- **Design ref:** §9.2, §9.3

### Task 5.4: Integrate with CompactService
- **File:** `src/core/Session.ts` or `src/core/TurnManager.ts`
- **Description:**
  - Track `lastProcessedMessageIndex` in session state
  - When compaction occurs, update the index so memory extraction doesn't re-process compacted/summarized messages
  - Ensure the summary text generated by CompactService is NOT fed to FactExtractor
  - After compaction, reset the message index tracking to account for the new shortened history
- **Depends on:** Task 5.3
- **Design ref:** §9.3

### Task 5.5: Add MemoryConfig to agent configuration
- **Files:** `src/config/` (agent config files), settings UI if applicable
- **Description:**
  - Add `memory` section to the agent's configuration schema
  - Define defaults: enabled=true, embeddingDimensions=1536, maxMemories=10000, recallLimit=10
  - Load config at Session initialization time
  - Support runtime config changes (at minimum, enabled/disabled toggle)
  - Persist config via existing `StorageProvider` (settings collection)
  - No UI needed for V1 — config via JSON/settings file
- **Depends on:** Task 1.1
- **Design ref:** §9.4

---

## Phase 6: Dimension Migration & Robustness

### Task 6.1: Implement dimension mismatch detection
- **File:** `src/core/memory/MemoryStore.ts` (abstract), platform implementations
- **Description:**
  - On `initialize(config)`, read the stored `embedding_dimensions` from `memory_meta` table
  - Compare against `config.embeddingDimensions`
  - If mismatch detected, log a warning and call `migrateDimensions(newDimensions)`
  - If no metadata row exists (first run), insert the current dimensions
- **Depends on:** Task 1.7, Task 1.8
- **Design ref:** §3.5

### Task 6.2: Implement dimension migration (DROP + recreate + background re-embed)
- **Files:** `TauriMemoryStore.ts`, `NodeMemoryStore.ts`, `MemoryService.ts`
- **Description:**
  - In `migrateDimensions(newDimensions)`:
    1. UPDATE `memory_meta` set `migration_status` = 'PENDING'
    2. DROP the `memory_embeddings` virtual table
    3. CREATE new vec0 table with `float[${newDimensions}]`
    4. UPDATE `memory_meta` with new dimensions value
  - After migration, queue a background re-embedding job:
    - Read all facts from `memory_facts`
    - Re-embed each fact text using the current EmbeddingProvider
    - INSERT new embeddings into the recreated vec0 table
    - Process in batches (e.g., 50 at a time) to avoid rate limits
    - Track progress, log completion
    - On success, UPDATE `memory_meta` set `migration_status` = 'COMPLETE'
  - On application boot/initialization, if `migration_status` is 'PENDING', immediately resume the background re-embedding job
  - During re-embedding, the memory system is partially functional:
    - Global/always-inject recall works (category-based, no vectors needed)
    - Vector search returns no results until re-embedding completes
- **Depends on:** Task 6.1, Task 2.1
- **Design ref:** §3.5

---

## Phase 7: Testing

### Task 7.1: Unit tests for types and utilities
- **File:** `src/core/memory/__tests__/types.test.ts`
- **Description:**
  - Test `MemoryCategory` type validation
  - Test `DEFAULT_MEMORY_CONFIG` values
  - Test `ALWAYS_INJECT_CATEGORIES` contains correct categories
  - Test content hash generation (SHA-256)
  - Test UUID generation for memory IDs
- **Depends on:** Task 1.1

### Task 7.2: Unit tests for FactExtractor
- **File:** `src/core/memory/__tests__/FactExtractor.test.ts`
- **Description:**
  - Test `shouldExtract()`:
    - Returns false for empty messages
    - Returns false for trivial messages ("ok", "hi", "thanks")
    - Returns true for substantive messages
  - Test `preprocessForExtraction()`:
    - Strips code blocks > 500 chars
    - Truncates messages > 2000 chars
    - Preserves assistant messages unmodified
    - Preserves short code blocks
  - Test `extract()` with mocked LLM:
    - Extracts facts from well-formed conversation
    - Returns empty array for "Hi there"
    - Resolves pronoun references when assistant context is available
    - Handles malformed LLM JSON response gracefully
    - Returns empty array on LLM error
  - Test custom prompt override
- **Depends on:** Task 3.3

### Task 7.3: Unit tests for ConflictResolver
- **File:** `src/core/memory/__tests__/ConflictResolver.test.ts`
- **Description:**
  - Test UUID → integer mapping and back-mapping
  - Test with mocked LLM returning ADD decisions
  - Test with mocked LLM returning UPDATE decisions
  - Test with mocked LLM returning DELETE decisions (including forget commands)
  - Test with mocked LLM returning NONE decisions
  - Test with mixed decisions
  - Test with no existing memories (should skip conflict resolution)
  - Test handling of invalid memoryId references in LLM response
  - Test malformed LLM response handling
  - Test custom conflict prompt override
- **Depends on:** Task 3.4

### Task 7.4: Unit tests for MemoryService
- **File:** `src/core/memory/__tests__/MemoryService.test.ts`
- **Description:**
  - Test full write path with mocked FactExtractor, EmbeddingClient, MemoryStore, ConflictResolver
  - Test that processConversation skips trivial messages
  - Test that processConversation skips when no facts extracted
  - Test sequential queue: verify that concurrent processConversation calls execute sequentially
  - Test that errors in one queue item don't block subsequent items
  - Test full read path (dual-path recall):
    - Always-inject categories loaded without embedding
    - Topical search uses embedding
    - Results merged and deduplicated
    - Access stats updated
  - Test memory context formatting:
    - Empty memories → empty string
    - Global memories listed first
    - Token budget truncation
  - Test maxMemories limit warning
  - Test that write path is truly async (doesn't block caller)
- **Depends on:** Task 4.1, Task 4.2, Task 4.3, Task 4.4

### Task 7.5: Unit tests for EmbeddingClient
- **File:** `src/core/memory/__tests__/EmbeddingClient.test.ts`
- **Description:**
  - Test OpenAI embedding provider with mocked API
  - Test Google embedding provider with mocked API
  - Test `embedBatch()` sends single API call for multiple texts
  - Test embedding cache: second call with same text returns cached result
  - Test cache eviction when max size exceeded
  - Test error handling (API errors, rate limits)
  - Test text preprocessing (newline normalization)
  - Test provider selection based on LLM provider config
- **Depends on:** Task 2.1, Task 2.2, Task 2.3, Task 2.4

### Task 7.6: Integration tests for MemoryStore (SQLite)
- **File:** `src/core/memory/__tests__/MemoryStore.integration.test.ts`
- **Description:**
  - Use an in-memory SQLite database (or temp file) for testing
  - Test schema migration creates all tables and indexes
  - Test insert: fact + embedding stored correctly
  - Test search: KNN returns correct top-K results ordered by distance
  - Test update: fact text and embedding updated
  - Test delete: removed from both tables
  - Test getByCategories: returns only matching categories
  - Test updateAccessStats: increments access_count, updates last_accessed_at
  - Test count: returns correct count with scope filter
  - Test history logging: operations recorded with before/after content
  - Test dimension mismatch detection and migration
  - Test that search works after dimension migration + re-embedding
  - Run against both Node.js (better-sqlite3) implementation to validate SQL
- **Depends on:** Task 1.8

### Task 7.7: Integration tests for TurnManager memory integration
- **File:** `src/core/__tests__/TurnManager.memory.test.ts`
- **Description:**
  - Test that memory recall is injected into system prompt before LLM call
  - Test that memory extraction fires after turn completion (async)
  - Test that memory recall failure doesn't break the turn
  - Test that memory extraction failure doesn't break the turn
  - Test that compacted history is not re-processed for memory extraction
  - Test that memory is not injected when MemoryService is null (extension mode)
  - Test that memory recall respects context window budget
- **Depends on:** Task 5.2, Task 5.3, Task 5.4

---

## Phase 8: Edge Cases & Hardening

### Task 8.1: Handle first-run initialization gracefully
- **Description:**
  - Ensure the memory system works correctly on first app launch (no existing DB tables)
  - Schema migration runs idempotently
  - No errors when memory_meta has no rows
  - First recall returns empty results gracefully
  - First processConversation creates tables if needed
- **Depends on:** Task 5.1
- **Design ref:** §3.4

### Task 8.2: Handle missing/invalid API key for embeddings
- **Description:**
  - If the user hasn't configured an API key for the embedding provider, disable memory silently
  - Log a warning: "Memory system disabled: no API key configured for embedding provider"
  - Don't show error dialogs to the user
  - Re-enable automatically when a valid API key is configured
  - Handle the case where the chat model uses a different provider than the embedding model (e.g., Anthropic chat → OpenAI embeddings needs an OpenAI key)
- **Depends on:** Task 5.1, Task 2.1

### Task 8.3: Handle LLM provider changes
- **Description:**
  - When the user switches LLM providers (e.g., OpenAI → Google), detect the embedding dimension change
  - Trigger dimension migration if needed (§3.5)
  - Handle the transition period: global recall works, vector search degrades during re-embedding
  - Log progress of re-embedding job
  - Handle case where user switches providers back before re-embedding completes
- **Depends on:** Task 6.1, Task 6.2

### Task 8.4: Handle storage errors and DB corruption
- **Description:**
  - Wrap all MemoryStore calls in try/catch
  - If the database is corrupted, log error and disable memory (don't crash the app)
  - If sqlite-vec extension fails to load, fall back to no vector search (global recall only works)
  - Consider adding a "reset memory" escape hatch (clear all tables) for recovery
- **Depends on:** Task 4.1

### Task 8.5: Rate-limit memory extraction
- **File:** `src/core/memory/MemoryService.ts`
- **Description:**
  - Add a minimum interval between extraction runs (e.g., 10 seconds per user)
  - If processConversation is called within the cooldown period, queue it but don't execute immediately
  - This prevents excessive API calls during rapid back-and-forth conversations
  - Configurable via MemoryConfig
  - Log when extraction is throttled
- **Depends on:** Task 4.2

---

## Phase 9: Documentation & Cleanup

### Task 9.1: Update CLAUDE.md with memory system info
- **File:** `CLAUDE.md`
- **Description:**
  - Add memory system to the Active Technologies section
  - Document the new file structure under Project Structure
  - Add memory-related test commands
  - Note that BrowserX (extension) does not support the memory system
- **Depends on:** All previous tasks

### Task 9.2: Add inline code documentation
- **Description:**
  - Add JSDoc comments to all public interfaces and methods in `src/core/memory/`
  - Add Rust doc comments to all public functions in `memory_commands.rs`
  - Document the prompt template variables and expected LLM output formats
  - Document the async processing queue behavior
  - Document the dual-path recall strategy
- **Depends on:** All implementation tasks

### Task 9.3: Verify build for all platforms
- **Description:**
  - Run `npm run build:desktop` — verify memory code is included, sqlite-vec links
  - Run `npm run build:server` — verify sqlite-vec extension loads, schema creates
  - Run `npm run build` (extension) — verify memory code is tree-shaken out, no errors
  - Run `npm run tauri:build` — verify Rust compiles with sqlite-vec crate
  - Run full test suite: `npm test && npm run lint`
- **Depends on:** All previous tasks

---

## Task Dependency Graph

```
Phase 1 (Foundation):
  1.1 ──→ 1.2 ──→ 1.3
  1.4 ──→ 1.5 ──→ 1.6 ──→ 1.7
                          1.2 ──→ 1.7
  1.2 ──→ 1.8

Phase 2 (Embeddings):
  1.1 ──→ 2.1 ──→ 2.2
                ──→ 2.3
                ──→ 2.4

Phase 3 (Extraction):
  (none) ──→ 3.1
  (none) ──→ 3.2
  3.1 + 1.1 ──→ 3.3
  3.2 + 1.1 ──→ 3.4

Phase 4 (Orchestrator):
  1.2 + 2.1 + 3.3 + 3.4 ──→ 4.1 ──→ 4.2
                                    ──→ 4.3
  1.1 ──→ 4.4

Phase 5 (Integration):
  4.1 + 4.2 + 4.3 + 1.3 ──→ 5.1 ──→ 5.2
                                   ──→ 5.3 ──→ 5.4
  1.1 ──→ 5.5

Phase 6 (Migration):
  1.7 + 1.8 ──→ 6.1 ──→ 6.2

Phase 7 (Testing):
  Depends on respective implementation tasks

Phase 8 (Hardening):
  Depends on Phase 5

Phase 9 (Documentation):
  Depends on all
```

## Parallelization Opportunities

The following task groups can be worked on **in parallel**:

- **Group A:** Tasks 1.4 → 1.5 → 1.6 → 1.7 (Rust/Tauri storage)
- **Group B:** Tasks 1.8 (Node.js storage) — parallel with Group A
- **Group C:** Tasks 2.1 → 2.2, 2.3, 2.4 (Embedding system) — parallel with Groups A/B
- **Group D:** Tasks 3.1, 3.2 (Prompt templates) — parallel with everything
- **Group E:** Tasks 3.3, 3.4 (Extraction/Conflict) — after Group D + Task 1.1

After Phase 1-3 complete, Phases 4-5 are sequential. Phase 6-9 can partially overlap.
