# Design: Simplified File-Based Memory with Main LLM Control

**Date**: 2026-03-17
**Status**: Draft
**Branch**: TBD (replaces `036-llm-memory-retrieval` spec)

## Overview

Replace the current memory system (sqlite-vec + embeddings + background extraction pipeline) with a radically simpler design: the main agent LLM controls memory via two tools (`save_memory`, `search_memory`), facts are stored in date-sharded markdown files, and a cheap LLM handles search filtering. No database, no embeddings, no background extraction.

Inspired by ChatGPT's `bio` tool approach + Google's file-based "Always On Memory Agent."

## Current System (What We're Replacing)

```
Conversation happens
  → Turn ends
  → Cheap model (gpt-4o-mini) extracts facts in background
  → FactExtractor classifies facts into categories
  → ConflictResolver deduplicates against existing memories
  → Core facts → merged into core-memory.md via LLM
  → Topical facts → embedded via OpenAI API → stored in sqlite-vec
  → search_memory tool → embed query → KNN vector search → results
```

**Components**: MemoryService, FactExtractor, ConflictResolver, CoreMemoryManager,
EmbeddingClient, EmbeddingCache, NodeMemoryStore, TauriMemoryStore, createMemoryStore,
createMemoryService, 3 prompt files, MemoryStore interface, MemoryFileSystem

**Dependencies**: better-sqlite3, sqlite-vec, OpenAI embedding API

**Problems**:
- Native dependencies cause test/build/deployment failures
- Embedding API costs on every write and search
- Complex pipeline (extract → classify → dedup → embed → store)
- User has no control ("remember this" / "forget that" not supported)
- Each concurrent session creates its own memory instance
- Background extraction misses nuance — atomic facts lose context

## New Design

```
Conversation happens
  → Main LLM decides to call save_memory("fact") during the conversation
  → Fact appended to today's markdown file. Done.

User asks about past context
  → Main LLM calls search_memory("query")
  → Cheap LLM generates keywords → grep daily files → cheap LLM filters results
  → Results returned to main LLM
```

### Architecture

```
┌─────────────────────────────────────────────┐
│                 Main Agent LLM              │
│                                             │
│  Tools:                                     │
│    save_memory(text, category?)             │
│    search_memory(query)                     │
│    forget_memory(query)                     │
│                                             │
│  System prompt includes:                    │
│    - core-memory.md content (always)        │
│    - Memory tool instructions               │
└──────┬──────────────┬──────────────┬────────┘
       │              │              │
       ▼              ▼              ▼
  ┌─────────┐  ┌────────────┐  ┌──────────┐
  │  Write   │  │   Search   │  │  Forget  │
  │          │  │            │  │          │
  │ Append   │  │ Keywords   │  │ Find &   │
  │ to daily │  │ → grep     │  │ remove   │
  │ file     │  │ → LLM      │  │ from     │
  │          │  │   filter   │  │ files    │
  └─────────┘  └────────────┘  └──────────┘
       │              │              │
       ▼              ▼              ▼
  ┌──────────────────────────────────────────┐
  │  ~/.airepublic-pi/memory/               │
  │  ├── core-memory.md                     │
  │  ├── 2026-03-15.md                      │
  │  ├── 2026-03-16.md                      │
  │  └── 2026-03-17.md                      │
  └──────────────────────────────────────────┘
```

## Tools

### save_memory

The main agent calls this when it encounters information worth remembering.

```typescript
{
  name: "save_memory",
  description: "Save a fact, preference, or important detail about the user to long-term memory. Call this when the user shares personal details, preferences, project context, or explicitly asks you to remember something. Write plain text — be concise but complete.",
  parameters: {
    text: string,       // The fact to remember (plain text sentence)
    category?: string   // Optional: personal, professional, project, preference, instruction, behavior, general
  }
}
```

**Behavior**:
- Appends to today's daily file (`~/.airepublic-pi/memory/YYYY-MM-DD.md`)
- If category is `preference`, `instruction`, or `behavior` → also merge into `core-memory.md`
- Format: `## HH:MM | category\nfact text\n`

**When the main LLM should call it** (guided by system prompt):
- User shares personal details ("My name is Isaac")
- User states preferences ("I prefer dark mode")
- User gives instructions ("Always use TypeScript")
- User shares project context ("We're using Next.js")
- User explicitly says "remember that..."
- Any information the agent believes will be useful in future conversations

**When NOT to save** (guided by system prompt):
- Casual greetings or small talk
- Temporary task details ("fix this bug on line 42")
- Information already in memory
- Sensitive data (health, financial) unless explicitly asked

### search_memory

Unchanged interface from current system, but different internals.

```typescript
{
  name: "search_memory",
  description: "Search long-term memory for facts, preferences, or context the user mentioned in past conversations. Use this when you need historical context.",
  parameters: {
    query: string  // Short search query
  }
}
```

**Behavior**:
1. Cheap LLM generates keywords from the query
2. String search across all daily files for keyword matches
3. If no matches: read last 7 daily files as fallback
4. Cheap LLM filters and ranks results for relevance
5. Return top results with fact text, category, source date, relevance score

### forget_memory

New tool — allows users to ask the agent to forget things.

```typescript
{
  name: "forget_memory",
  description: "Remove a specific fact from memory when the user asks you to forget something.",
  parameters: {
    query: string  // What to forget
  }
}
```

**Behavior**:
1. Search daily files for matching facts
2. Cheap LLM identifies which entries match the forget request
3. Remove matching entries from daily files
4. If it's a core fact, also remove from core-memory.md
5. Confirm what was forgotten

## Storage

### Directory Structure

```
~/.airepublic-pi/
├── storage/
│   └── core-memory.md              # Always-inject (preferences, instructions, behaviors)
└── memory/
    ├── 2026-03-15.md
    ├── 2026-03-16.md
    └── 2026-03-17.md
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

## 16:20 | instruction
Always use TypeScript, never JavaScript
```

### core-memory.md Format (unchanged)

```markdown
# User Profile

# Preferences
- Prefers simple file-based solutions over databases
- Likes dark mode

# Instructions
- Always use TypeScript, never JavaScript

# Behavior
- Prefers concise answers
```

### Dual-Write for Core Facts

When `save_memory` is called with a core category (preference, instruction, behavior):
1. Append to today's daily file (for the historical log)
2. Merge into `core-memory.md` (for always-inject)

Daily file = complete log of what was learned and when.
core-memory.md = authoritative source for always-inject context.

## System Prompt Additions

The main agent's system prompt needs memory instructions. Added to `base_instructions`:

```
## Memory

You have long-term memory that persists across conversations. Use it to provide
personalized, contextual assistance.

### Reading Memory
Your core memory (preferences, instructions, behaviors) is included below in
<agent_memory> tags. This is always available — you don't need to search for it.

For other facts (personal details, project context, past conversations), use the
search_memory tool.

### Saving Memory
When the user shares important information, call save_memory to store it. Save:
- Personal details (name, role, company, interests)
- Preferences and instructions ("I prefer...", "always do...", "never do...")
- Project context (tech stack, architecture, team details, deadlines)
- Anything they explicitly ask you to remember

Do NOT save:
- Casual greetings or chitchat
- Temporary debugging details
- Information you've already saved
- Sensitive data (health, financial) unless explicitly requested

Write plain, concise text. One fact per save_memory call.

### Forgetting
When the user asks you to forget something, use forget_memory to remove it.

<agent_memory>
{core-memory.md content here}
</agent_memory>
```

## Components

### What's NEW

| Component | Purpose |
|-----------|---------|
| `DailyMemoryStore` | Read/write/delete entries in daily markdown files |
| `MemorySearcher` | Keyword generation + grep + LLM filtering |
| `save_memory` tool definition | Tool spec for the main agent |
| `forget_memory` tool definition | Tool spec for the main agent |
| `prompts/keyword_gen.md` | Prompt for keyword generation |
| `prompts/relevance_filter.md` | Prompt for relevance filtering |

### What's KEPT (unchanged or minimal changes)

| Component | Changes |
|-----------|---------|
| `CoreMemoryManager` | Unchanged — manages core-memory.md |
| `MemoryFileSystem` | Unchanged — platform filesystem abstraction |
| `prompts/core_merge.md` | Unchanged — core memory merge prompt |
| `search_memory` tool definition | Unchanged interface |
| `types.ts` | Simplified — remove embedding/store types |

### What's REMOVED

| Component | Why |
|-----------|-----|
| `FactExtractor` | Main LLM does extraction via save_memory tool |
| `ConflictResolver` | Main LLM handles dedup (won't save duplicates) |
| `EmbeddingClient` | No embeddings |
| `EmbeddingCache` | No embeddings |
| `NodeMemoryStore` | No database |
| `TauriMemoryStore` | No database |
| `MemoryStore` interface | No database |
| `createMemoryStore` | No database |
| `prompts/extraction.md` | No background extraction |
| `prompts/conflict.md` | No separate conflict resolution |
| `MemoryService.processConversation()` | No background extraction |

### What's REFACTORED

| Component | Changes |
|-----------|---------|
| `MemoryService` | Drastically simplified. No extraction pipeline. Exposes: `saveFact()`, `searchTopical()`, `forgetFact()`, `getFormattedGlobalContext()`. Internally uses DailyMemoryStore + MemorySearcher |
| `createMemoryService` | Simplified — no embedding provider, no store creation, no backend routing. Just creates DailyMemoryStore + MemorySearcher + CoreMemoryManager |
| `TurnManager` | Register save_memory + forget_memory tools alongside search_memory. Handle tool calls. Remove `fireMemoryExtraction()` entirely |
| `Session` | Simplify memory init — no embedding setup, no backend routing config |

## Integration Points

### TurnManager Changes

```
Current:
  - buildToolsFromContext(): registers search_memory tool
  - executeToolCall(): handles search_memory
  - runTurn(): injects core memory into base instructions
  - runTurn(): calls fireMemoryExtraction() at end of turn (fire-and-forget)

New:
  - buildToolsFromContext(): registers save_memory, search_memory, forget_memory tools
  - executeToolCall(): handles all three tools
  - runTurn(): injects core memory into base instructions (unchanged)
  - runTurn(): NO fireMemoryExtraction() — removed entirely
```

### Session Changes

```
Current:
  - Creates OpenAIChatCompletionClient for extraction model
  - Configures embedding provider (direct or backend-routed)
  - Creates platform-specific MemoryStore
  - Wires everything into createMemoryService()

New:
  - Creates OpenAIChatCompletionClient for search filtering model (still gpt-4o-mini)
  - Creates DailyMemoryStore with filesystem
  - Creates MemorySearcher with cheap LLM
  - Wires into simplified createMemoryService()
  - No embedding provider, no store factory, no backend routing for embeddings
```

### Settings UI Changes

- Remove "Use own OpenAI API key" toggle for memory (no embeddings)
- Keep memory enabled/disabled toggle
- Note: OpenAI key still needed for search filtering (cheap LLM)
- Or: search filtering could use whatever model the user has configured

## Migration

### From SQLite (memory.db)

1. On first startup, check for `~/.airepublic-pi/storage/memory.db`
2. If found, read all facts from `memory_facts` table
3. Group by `created_at` date → write to `YYYY-MM-DD.md` files
4. Core category facts → also merge into core-memory.md
5. Write `migration_complete` marker file
6. Leave memory.db as backup

### From old core-memory.md

No migration needed — format is unchanged.

## Cost Analysis

### Current System (per conversation turn with memory)

| Operation | Cost |
|-----------|------|
| Embedding query (search) | ~$0.00002 |
| Embedding facts (write, ~3 facts) | ~$0.00006 |
| Extraction LLM call (gpt-4o-mini) | ~$0.0005 |
| Conflict resolution LLM call | ~$0.0005 |
| Core memory merge LLM call | ~$0.0005 |
| **Total per turn** | **~$0.002** |

### New System (per conversation turn with memory)

| Operation | Cost |
|-----------|------|
| save_memory tool calls (main model, ~2-3 per conversation) | $0 extra (part of normal response) |
| Core memory merge LLM call (only for core facts) | ~$0.0005 |
| search_memory: keyword gen + filtering (only when searched) | ~$0.001 |
| **Total per turn (no search)** | **~$0.0005** |
| **Total per turn (with search)** | **~$0.0015** |

**Cost reduction: ~50-75%** — mainly by eliminating embedding API calls and the background extraction pipeline.

The save_memory tool calls are "free" in the sense that they're part of the main model's response — the model was already generating tokens for the conversation.

## Comparison to ChatGPT and Google

| Aspect | ChatGPT | Google Always-On | Our New Design |
|--------|---------|-------------------|----------------|
| **Who decides what to save** | Main model (bio tool) | Separate ingest agent | Main model (save_memory tool) |
| **Storage** | Plain text list | SQLite (3 tables) | Date-sharded markdown files |
| **Retrieval** | Inject everything always | Read 50 recent rows | grep + cheap LLM filtering |
| **Search capability** | None (brute force inject) | None (recency only) | Yes (keyword search across all files) |
| **User control** | "Remember/forget" supported | No | "Remember/forget" supported |
| **Human-readable storage** | No (internal DB) | No (SQLite) | Yes (markdown files) |
| **Consolidation** | Hidden background profiles | Every 30 min | Not yet (future feature) |
| **Dependencies** | Internal infrastructure | SQLite + Gemini | Zero (just filesystem) |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Main model forgets to save things | Medium | Clear system prompt instructions; can add lightweight background sweep later |
| Main model saves too aggressively | Low | System prompt guides what NOT to save; user can delete files |
| Save_memory adds latency to conversation | Low | Tool call is fast (just file append); no API calls |
| Grep search misses relevant old facts | Medium | Fallback to reading recent files; cheap LLM generates keyword variations |
| Daily files accumulate over months | Low | Files are small; future: add retention/archival policy |
| Concurrent sessions write to same file | Low | Append-only writes; atomic write (temp file + rename) |

## Future Enhancements (Out of Scope)

1. **Episodic memory** — per-session conversation summaries stored as episodes in daily files
2. **Consolidation** — periodic background synthesis of old memories (like Google's approach)
3. **Singleton memory service** — share one instance across concurrent sessions
4. **Memory UI** — browse/edit memories from the settings panel
5. **Retention policy** — auto-archive or compress memories older than N months
