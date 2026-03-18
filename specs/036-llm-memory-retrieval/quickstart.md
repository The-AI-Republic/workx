# Quickstart: File-Based LLM-Powered Memory

## What Changed

The memory system's storage and retrieval layers are replaced:

| Before | After |
|--------|-------|
| SQLite + sqlite-vec (vector DB) | Date-sharded markdown files |
| OpenAI embeddings for search | grep + cheap LLM filtering |
| Separate ConflictResolver | Dedup merged into extraction |
| Native dependencies required | Zero external dependencies |

**What stays the same**: MemoryService public API, core-memory.md, FactExtractor, CoreMemoryManager, search_memory tool interface, TurnManager/Session integration.

## Architecture Overview

```
Write Path:
  TurnManager.fireMemoryExtraction()
    → MemoryService.processConversation(messages)
      → FactExtractor.extract(messages, recentFacts)  ← now reads recent files for dedup
        → Core facts → CoreMemoryManager.mergeCoreFacts()  (unchanged)
        → Topical facts → append to ~/.airepublic-pi/memory/YYYY-MM-DD.md

Read Path (global):
  TurnManager.runTurn()
    → MemoryService.getFormattedGlobalContext()
      → CoreMemoryManager.getCoreMemoryContent()  (unchanged)
      → Inject into system prompt as <agent_memory>

Read Path (search):
  search_memory tool call
    → MemoryService.searchTopical(query)
      → Cheap LLM generates keywords from query
      → String search across daily files for keyword matches
      → Fallback: read last 7 daily files if no matches
      → Cheap LLM filters and ranks results
      → Return [{fact, category, sourceDate, relevance}]
```

## Key Files to Modify

### Remove
- `src/core/memory/EmbeddingClient.ts`
- `src/core/memory/EmbeddingCache.ts`
- `src/core/memory/ConflictResolver.ts`
- `src/core/memory/createMemoryStore.ts`
- `src/core/memory/MemoryStore.ts` (interface)
- `src/core/memory/prompts/conflict.md`
- `src/server/storage/NodeMemoryStore.ts`
- `src/desktop/storage/TauriMemoryStore.ts`
- Related test files for removed components

### Modify
- `src/core/memory/MemoryService.ts` — replace store/embedding internals with file operations
- `src/core/memory/FactExtractor.ts` — add dedup by reading recent daily files
- `src/core/memory/createMemoryService.ts` — simplify (no embedding provider, no store creation)
- `src/core/memory/types.ts` — remove embedding-related types/config
- `src/core/memory/prompts/extraction.md` — add dedup instructions
- `src/core/TurnManager.ts` — update search_memory result format (relevance instead of distance)
- `src/core/Session.ts` — simplify memory initialization (no embedding setup)

### Keep Unchanged
- `src/core/memory/CoreMemoryManager.ts`
- `src/core/memory/MemoryFileSystem.ts`
- `src/core/memory/prompts/core_merge.md`
- `src/tools/MemorySearchTool.ts` (tool definition)

## Daily File Format

```markdown
# 2026-03-17

## 14:32 | personal
User's name is Isaac, software engineer at AI Republic

## 14:35 | project
Working on browserx memory system

## 15:10 | preference
Prefers simple file-based solutions over databases
```

## Search Flow Detail

1. Agent calls `search_memory({query: "user's tech stack"})`
2. Cheap LLM generates keywords: `["tech stack", "framework", "React", "TypeScript", "language"]`
3. System reads all daily files, searches for keyword matches (case-insensitive string search)
4. Matching sections extracted with their date and category
5. If no matches: read last 7 daily files entirely
6. Cap at 50 matched sections + last 7 days content
7. Cheap LLM reads candidates, filters for relevance to original query
8. Return top results with fact text, category, source date, relevance score
9. TurnManager formats results for the main agent

## Migration from SQLite

On first startup with file-based memory:
1. Check if `~/.airepublic-pi/storage/memory.db` exists
2. If yes, read all facts from `memory_facts` table
3. Group by `created_at` date
4. Write to corresponding `YYYY-MM-DD.md` files
5. Log migration summary
6. Leave `memory.db` in place as backup (don't delete)
