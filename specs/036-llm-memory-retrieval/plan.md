# Implementation Plan: File-Based LLM-Powered Memory

**Branch**: `036-llm-memory-retrieval` | **Date**: 2026-03-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/036-llm-memory-retrieval/spec.md`

## Summary

Replace the vector embedding storage and retrieval layer (sqlite-vec, better-sqlite3, OpenAI embeddings) with a zero-dependency file-based system. Facts are stored in date-sharded markdown files (`YYYY-MM-DD.md`), searched via string matching, and filtered by a cheap LLM. Core memory (core-memory.md) remains unchanged. The MemoryService public API stays the same — Session, TurnManager, and the search_memory tool require minimal changes.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (target: ES2020)
**Primary Dependencies**: Node.js fs.promises (filesystem), existing OpenAIChatCompletionClient (cheap LLM calls)
**Storage**: Date-sharded markdown files in `~/.airepublic-pi/memory/`
**Testing**: Vitest 3.2.4
**Target Platform**: Desktop (Tauri) + Server (Node.js). Extension excluded (memory not supported).
**Project Type**: Single project (Chrome extension / desktop app / server)
**Performance Goals**: Memory search < 3 seconds for up to 10,000 facts across hundreds of daily files
**Constraints**: Per-query LLM cost < $0.002, zero native dependencies, same MemoryService public API
**Scale/Scope**: Hundreds to low thousands of facts per user, accumulated over months

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No project-specific constitution defined (template only). Gate passes by default. This feature reduces complexity (removes native dependencies, eliminates embedding infrastructure) — aligned with simplicity principles.

## Project Structure

### Documentation (this feature)

```text
specs/036-llm-memory-retrieval/
├── spec.md              # Feature specification
├── plan.md              # This file
├── research.md          # Phase 0: research decisions
├── data-model.md        # Phase 1: data model
├── quickstart.md        # Phase 1: implementation guide
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/core/memory/
├── MemoryService.ts         # Refactored — file-based internals, same public API
├── FactExtractor.ts         # Enhanced — now handles dedup by reading recent files
├── CoreMemoryManager.ts     # Unchanged
├── MemoryFileSystem.ts      # Unchanged — platform filesystem abstraction
├── DailyMemoryStore.ts      # NEW — read/write/search daily markdown files
├── MemorySearcher.ts        # NEW — grep + LLM keyword generation and filtering
├── types.ts                 # Simplified — remove embedding types
├── createMemoryService.ts   # Simplified — no embedding/store setup
├── prompts/
│   ├── extraction.md        # Enhanced — includes dedup instructions
│   ├── core_merge.md        # Unchanged
│   ├── keyword_gen.md       # NEW — keyword generation for search
│   └── relevance_filter.md  # NEW — relevance filtering prompt
└── __tests__/
    ├── DailyMemoryStore.test.ts      # NEW
    ├── MemorySearcher.test.ts        # NEW
    ├── MemoryService.test.ts         # Updated
    ├── FactExtractor.test.ts         # Updated
    └── CoreMemoryManager.test.ts     # Unchanged

# Files to DELETE:
src/core/memory/EmbeddingClient.ts
src/core/memory/EmbeddingCache.ts
src/core/memory/ConflictResolver.ts
src/core/memory/MemoryStore.ts
src/core/memory/createMemoryStore.ts
src/core/memory/prompts/conflict.md
src/core/memory/__tests__/MemoryStore.integration.test.ts
src/core/memory/__tests__/ConflictResolver.test.ts
src/server/storage/NodeMemoryStore.ts
src/desktop/storage/TauriMemoryStore.ts
```

**Structure Decision**: This is a refactor within the existing `src/core/memory/` module. Two new files (`DailyMemoryStore.ts`, `MemorySearcher.ts`) replace the removed store/embedding/conflict components. All changes are contained within the memory module boundary.

## Component Design

### 1. DailyMemoryStore

Handles reading, writing, and searching daily markdown memory files.

**Responsibilities**:
- Create/append facts to today's `YYYY-MM-DD.md` file
- Read and parse daily files into structured MemoryEntry arrays
- List available daily files (sorted by date, newest first)
- Read recent N days of files
- String search across all files for keyword matches
- Handle concurrent writes (append-only with atomic write)

**Key Methods**:
```
appendFact(category, text): Promise<void>
readDay(date: string): Promise<MemoryEntry[]>
readRecentDays(n: number): Promise<{date: string, entries: MemoryEntry[]}[]>
searchKeywords(keywords: string[]): Promise<{date: string, entry: MemoryEntry, matchedKeyword: string}[]>
listDays(): Promise<string[]>
```

### 2. MemorySearcher

Orchestrates the two-stage search: keyword generation → file search → LLM filtering.

**Responsibilities**:
- Take a user query and use cheap LLM to generate search keywords
- Execute keyword search across daily files via DailyMemoryStore
- Fall back to recent files when keywords return nothing
- Use cheap LLM to filter and rank results for relevance
- Cap results to prevent unbounded token usage

**Key Methods**:
```
search(query: string, limit?: number): Promise<MemorySearchResult[]>
```

### 3. MemoryService (Refactored)

Same public API. Internal changes:
- Constructor takes: `DailyMemoryStore`, `MemorySearcher`, `LLMCaller`, `FileSystem`, `memoryDir`, `MemoryConfig`
- `processConversation()`: extract facts → dedup against recent files → route core facts to CoreMemoryManager, topical facts to DailyMemoryStore
- `searchTopical()`: delegates to MemorySearcher
- `getFormattedGlobalContext()`: unchanged (reads core-memory.md)
- `close()`: no-op (no database connections to close)

### 4. FactExtractor (Enhanced)

- Now accepts recent facts as context for dedup
- Extraction prompt updated to include existing facts and instruct LLM to skip duplicates
- Returns only genuinely new facts

### 5. createMemoryService (Simplified)

- No embedding provider creation
- No store creation
- Creates DailyMemoryStore, MemorySearcher, wires into MemoryService
- Still requires cheap LLM caller (for extraction, dedup, search filtering)

## Integration Changes

### TurnManager (Minimal)

- `search_memory` handler: change `distance` → `relevance` in result format
- `similarity: 1 / (1 + m.distance)` → `similarity: m.relevance`
- Everything else unchanged

### Session (Simplified)

- Remove embedding provider setup
- Remove backend routing configuration for embeddings
- Remove OpenAI API key requirement for embeddings (still needed for cheap LLM)
- Simplify `createMemoryService` call

### Settings UI

- Remove "Use own OpenAI API key" toggle for memory embeddings (no embeddings anymore)
- Keep memory enabled/disabled toggle
- Note: OpenAI key still needed for cheap LLM calls (extraction, search filtering)

## Migration Strategy

1. On first startup with file-based memory, check for existing `~/.airepublic-pi/storage/memory.db`
2. If found, import facts: read `memory_facts` table → group by `created_at` date → write daily files
3. Log migration count and status
4. Leave `memory.db` in place as backup
5. Migration runs once, tracked by a `migration_complete` marker file

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| LLM keyword generation misses relevant terms | Medium | Fallback to recent files scan; iterative prompt improvement |
| Concurrent file writes from multiple sessions | Low | Append-only writes; atomic write (write to temp file, rename) |
| String search too slow for 10,000+ facts | Low | Daily files are small; search is bounded; can add file-level caching later |
| Cheap LLM filtering adds latency | Medium | Cap input size; use fastest available model (gpt-4o-mini) |
| Migration from SQLite fails | Low | Leave old DB intact; migration is idempotent and can be re-run |
