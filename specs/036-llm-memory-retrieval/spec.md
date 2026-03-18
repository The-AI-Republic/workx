# Feature Specification: File-Based LLM-Powered Memory

**Feature Branch**: `036-llm-memory-retrieval`
**Created**: 2026-03-17
**Status**: Draft
**Input**: Replace vector embeddings and SQLite with a file-based daily diary memory system. Store facts in date-sharded markdown files, use grep for keyword search, and a cheap LLM for relevance filtering. Zero database dependencies.

## Clarifications

### Session 2026-03-17

- Q: How should duplicate/conflict detection work without vector similarity? → A: Merge conflict resolution into the extraction step — the cheap LLM reads recent daily files during extraction and deduplicates inline, replacing the separate ConflictResolver.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Memory Search via Grep + LLM Filtering (Priority: P1)

As a user with memory enabled, when I ask the agent about something from a past conversation, the agent searches daily memory files using grep for keyword matches, then a cheap LLM filters and ranks the results for relevance — with zero database dependencies.

**Why this priority**: This is the core retrieval mechanism replacing vector search. It eliminates all native dependencies (sqlite-vec, better-sqlite3) and embedding API costs while providing better contextual understanding through LLM-powered filtering.

**Independent Test**: Enable memory, have several conversations over multiple days to accumulate facts, then ask "what do you remember about my project?" — the agent should find relevant facts by grepping across daily memory files and filtering with a cheap LLM.

**Acceptance Scenarios**:

1. **Given** memory is enabled and daily memory files contain facts, **When** the agent calls the search_memory tool with a query, **Then** the system generates keywords, greps across memory files, and uses a cheap LLM to filter results — no database or embedding operations involved.
2. **Given** a user asks "what did I say about my stack last time?", **When** the retriever processes the query, **Then** it searches recent daily files for stack-related keywords and returns temporally-aware results (including which day the facts were recorded).
3. **Given** grep returns zero keyword matches, **When** the search falls back, **Then** the system reads the most recent N daily files and lets the cheap LLM scan for contextually relevant facts.

---

### User Story 2 - Daily Diary Fact Storage (Priority: P1)

As a user chatting with the agent, when new facts are extracted from the conversation, they are appended to today's markdown memory file — organized by time and category, with no embedding or database operations.

**Why this priority**: The write path must be simple and reliable. Appending to a daily markdown file is the simplest possible storage mechanism — no schema, no migrations, no connections to manage.

**Independent Test**: Have a conversation where you share personal facts. Check that today's memory file (e.g., `2026-03-17.md`) exists and contains the extracted facts with timestamps and categories.

**Acceptance Scenarios**:

1. **Given** memory is enabled and a conversation produces extractable facts, **When** facts are stored, **Then** they are appended to today's date-named markdown file (e.g., `2026-03-17.md`) with timestamp and category metadata.
2. **Given** multiple conversations happen on the same day, **When** facts are extracted from each, **Then** all facts are appended to the same daily file in chronological order.
3. **Given** a new day begins, **When** the first fact is extracted, **Then** a new daily file is created automatically.

---

### User Story 3 - Core Memory Injection Unchanged (Priority: P2)

As a user, my core preferences, instructions, and behavior facts continue to be stored in core-memory.md and injected into every conversation — this path is unaffected by the storage changes.

**Why this priority**: Core memory is the most impactful memory feature (always-inject). It already uses a file-based approach that works well. No changes needed.

**Independent Test**: Enable memory, share preferences ("I prefer concise answers"), start a new conversation, verify the agent respects the preference without being reminded.

**Acceptance Scenarios**:

1. **Given** core facts (preferences, instructions, behaviors) have been extracted, **When** a new conversation starts, **Then** core-memory.md content is injected into the system prompt exactly as before.
2. **Given** the storage system has been replaced with daily files, **When** core memory operations occur (read, merge), **Then** they function identically to the previous implementation.

---

### User Story 4 - Zero-Dependency Deployment (Priority: P2)

As a developer deploying the application, the memory system works with zero external dependencies — no SQLite, no native extensions, no WASM. Just the filesystem and Node.js built-ins.

**Why this priority**: Eliminating all database dependencies makes the memory system work everywhere — any platform, any CI environment, any build pipeline.

**Independent Test**: Run the full test suite on a clean machine with only npm install. All memory-related tests pass with no native addons, no SQLite libraries, no special setup.

**Acceptance Scenarios**:

1. **Given** a fresh environment with no database libraries installed, **When** the application is built and memory tests run, **Then** all tests pass using only filesystem operations.
2. **Given** the memory system is initialized, **When** it sets up storage, **Then** it creates the memory directory structure using only Node.js fs APIs.

---

### User Story 5 - Human-Readable Memory (Priority: P3)

As a user, I can browse my agent's memory by opening the daily markdown files in any text editor, and I can manually edit or delete memories.

**Why this priority**: Transparency and user control. Users can see exactly what the agent remembers, when it learned it, and can correct or remove facts directly.

**Independent Test**: After several conversations, open the memory directory and read the daily files. Facts should be clearly organized with timestamps and categories. Edit a fact, start a new conversation, and verify the agent uses the updated information.

**Acceptance Scenarios**:

1. **Given** facts have been stored across multiple days, **When** a user opens the memory directory, **Then** they see clearly named daily files (YYYY-MM-DD.md) that are readable in any text editor.
2. **Given** a user manually edits a fact in a daily file, **When** the agent next searches memory, **Then** it finds the updated content.
3. **Given** a user deletes a daily file, **When** the agent searches memory, **Then** the deleted day's facts are no longer returned.

---

### Edge Cases

- What happens when grep returns too many matches across many daily files? The system caps results (e.g., top 50 matches) and the cheap LLM filters for relevance.
- What happens when the cheap LLM retriever is unavailable (API error, rate limit)? Memory search fails gracefully, returning an empty result set with a warning — the main conversation continues unaffected.
- What happens with months of accumulated daily files? Grep remains fast across thousands of small files. For very old files (e.g., 6+ months), the system can prioritize searching recent files first.
- What happens when multiple concurrent sessions write to today's file simultaneously? Use append-only writes with a simple file lock or atomic append to prevent corruption.
- What happens when the user's query has no obvious keywords (e.g., "what do you know about me")? The cheap LLM generates broad keyword variations and also reads the most recent daily files directly.
- How does migration work from the old SQLite-based memory.db? A one-time migration reads existing facts from the database and writes them to daily files grouped by their creation date.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST store extracted facts in date-sharded markdown files (one file per day, named YYYY-MM-DD.md) within a dedicated memory directory.
- **FR-002**: Each fact entry MUST include a timestamp, category, and the fact text — formatted as human-readable markdown.
- **FR-003**: System MUST retrieve relevant facts using a two-stage process: (a) cheap LLM generates keywords from the query, grep searches across daily files for matches, (b) cheap LLM filters and ranks the grep results for relevance to the original query.
- **FR-004**: When grep returns zero results, the system MUST fall back to reading the most recent N daily files (e.g., last 7 days) and passing them to the cheap LLM for direct scanning.
- **FR-005**: System MUST maintain the existing search_memory tool interface so the main agent LLM calls it the same way as before.
- **FR-006**: System MUST preserve the existing core-memory.md write/read path for always-inject categories (preference, instruction, behavior) without changes.
- **FR-007**: System MUST NOT require any database library, vector embedding API, or native extension for memory operations — only Node.js filesystem APIs and grep.
- **FR-008**: System MUST use a cost-efficient LLM for keyword generation and relevance filtering, keeping per-query costs under $0.002.
- **FR-009**: System MUST cap the volume of content sent to the cheap LLM retriever to prevent unbounded token usage (e.g., maximum 50 grep matches + content from the last 7 daily files).
- **FR-010**: System MUST maintain the same MemoryService public API (processConversation, searchMemory, getFormattedGlobalContext, close) so upstream integrations (Session, TurnManager) require no changes.
- **FR-011**: System MUST handle retrieval failures gracefully — if the cheap LLM call or grep fails, return an empty result set and log a warning without interrupting the main conversation.
- **FR-012**: System MUST provide a one-time migration path to convert existing SQLite-based memory.db facts into daily markdown files.
- **FR-013**: System MUST handle concurrent writes to the same daily file safely (append-only with file locking or atomic operations).
- **FR-014**: System MUST perform duplicate and conflict detection during the extraction step — the cheap LLM reads recent daily files when extracting new facts and skips duplicates, updates contradicted facts, or merges overlapping information inline. The separate ConflictResolver component is replaced by this integrated approach.

### Key Entities

- **DailyMemoryFile**: A date-named markdown file (YYYY-MM-DD.md) containing all facts extracted on that day, organized by timestamp and category.
- **MemoryFact**: An individual fact entry within a daily file, containing timestamp, category, and fact text.
- **MemorySearchResult**: A fact returned from search with its source date and a relevance indicator from the cheap LLM filtering step.
- **CoreMemory**: Markdown file (core-memory.md) containing always-inject preferences, instructions, and behaviors. Unchanged from current implementation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Memory search returns relevant results within 3 seconds for memory stores containing up to 10,000 facts across hundreds of daily files.
- **SC-002**: Per-query retrieval cost stays under $0.002 using a cost-efficient LLM for keyword generation and filtering.
- **SC-003**: All memory-related tests pass with zero database or native extension dependencies — only filesystem and Node.js built-ins required.
- **SC-004**: The memory system initializes and operates successfully on all platforms without compilation or binary compatibility issues.
- **SC-005**: Users can retrieve facts from past conversations with accuracy comparable to or better than the previous vector-based approach, including temporal queries ("what did I say last time about X").
- **SC-006**: Zero changes required to Session, TurnManager, or any upstream integration code — the refactor is contained within the memory module.
- **SC-007**: Memory files are human-readable and editable — users can inspect, modify, or delete their memory using any text editor.

## Assumptions

- The existing cheap LLM caller infrastructure (gpt-4o-mini) from the current memory system will be reused for keyword generation and relevance filtering.
- Node.js child_process or built-in string search can execute grep-like operations across files efficiently.
- Daily file sizes will typically be small (a few KB) since they contain extracted facts, not raw conversation text.
- The bounded search window (grep results + recent days) provides sufficient coverage for typical memory workloads.
- Users accumulate hundreds to low thousands of facts over months of usage — this volume is well-suited for file-based storage with grep search.

## Dependencies

- Existing FactExtractor and CoreMemoryManager components are retained and reused. ConflictResolver is replaced by integrated dedup logic in the extraction step.
- Node.js filesystem APIs (fs module) for file read/write/search operations.
- The cheap LLM caller (gpt-4o-mini or equivalent) for keyword generation and relevance filtering.

## Out of Scope

- Episodic memory (conversation-level summaries with temporal context) — planned as a separate feature.
- Memory consolidation (periodic background synthesis of old memories) — separate feature.
- Singleton memory service refactor (sharing one instance across concurrent sessions) — separate branch.
- Changes to the core-memory.md merge/injection pipeline.
- Changes to the memory settings UI.
- Removing the OpenAI API key requirement from settings UI (still needed for the cheap LLM retriever calls).

## Storage Structure

```
~/.airepublic-pi/storage/
├── core-memory.md              # Always-inject preferences/instructions/behaviors
└── memory/
    ├── 2026-03-15.md           # Facts extracted on March 15
    ├── 2026-03-16.md           # Facts extracted on March 16
    └── 2026-03-17.md           # Facts extracted on March 17
```

### Daily File Format

```markdown
# 2026-03-17

## 14:32 | personal
User's name is Isaac, software engineer at AI Republic

## 14:35 | project
Working on browserx memory system, replacing sqlite-vec with LLM retrieval

## 15:10 | preference
Prefers simple file-based solutions over databases when possible
```
