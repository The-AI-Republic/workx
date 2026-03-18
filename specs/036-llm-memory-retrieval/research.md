# Research: File-Based LLM-Powered Memory

## Decision 1: Storage Backend — Files vs SQLite

**Decision**: Date-sharded markdown files (`YYYY-MM-DD.md`), no database.

**Rationale**:
- Zero dependencies — no native extensions, no WASM, no compilation
- Human-readable and editable — transparency for users
- Aligns with Claude Code's proven file-based memory pattern
- Google's "Always On Memory Agent" validates the no-DB approach for bounded memory workloads
- The realistic memory volume (hundreds to low thousands of facts) doesn't require database indexing

**Alternatives considered**:
- SQLite + FTS5 (pure JS/WASM): Still a dependency, not human-readable, overkill for volume
- SQLite + sqlite-vec (current): Native dependency issues, embedding API costs, complex
- Single monolithic markdown file: Grows unbounded, harder to manage temporally

## Decision 2: Search Mechanism — Grep + LLM vs FTS5 vs Embeddings

**Decision**: Node.js string search across files + cheap LLM for keyword generation and relevance filtering.

**Rationale**:
- grep/string search is free (no API cost, no latency)
- Cheap LLM understands intent better than cosine similarity — "what did I say about my stack" → generates keywords ["stack", "tech", "framework", "React", "TypeScript"]
- Two-stage: fast keyword scan narrows candidates, LLM filters for relevance
- Fallback: read recent N daily files when keywords return nothing

**Alternatives considered**:
- Vector embeddings (current): API cost per query, native deps, dimension management
- FTS5 in SQLite: Requires SQLite dependency, marginal benefit over string search for this volume
- Pure LLM scan of all files: Too expensive, too slow for large memory stores

## Decision 3: Conflict Resolution Strategy

**Decision**: Merge dedup into the extraction step — cheap LLM reads recent daily files during fact extraction and decides inline whether each fact is new, an update, or a duplicate.

**Rationale**:
- Eliminates separate ConflictResolver component
- Without embeddings, can't do semantic similarity for dedup anyway
- Single LLM call handles extraction + dedup together — fewer API calls
- Reading recent files (last 7 days) provides sufficient context for dedup without scanning everything

**Alternatives considered**:
- Keep ConflictResolver as separate step (reads all files, LLM compares): Slower, more expensive
- No dedup at all (append everything): Accumulates noise, degrades retrieval quality

## Decision 4: Filesystem Operations — Node.js fs vs child_process grep

**Decision**: Use Node.js `fs.promises.readFile` + string matching (no child_process).

**Rationale**:
- Works in all environments (desktop via Tauri IPC, server via Node.js)
- The existing `FileSystem` interface already provides `readFile`/`writeFile`/`exists`/`ensureDir`
- Daily files are small (few KB each) — reading them into memory for string search is fast
- Avoids platform-specific grep binary issues
- Can reuse the existing `MemoryFileSystem` abstraction for platform portability

**Alternatives considered**:
- child_process grep: Platform-specific, not available in Tauri/desktop context
- ripgrep binary: External dependency, overkill

## Decision 5: What to Remove

**Decision**: Remove these components entirely:
- `EmbeddingClient.ts` (OpenAI embedding provider, backend embedding provider)
- `EmbeddingCache.ts` (LRU cache for embeddings)
- `NodeMemoryStore.ts` (better-sqlite3 + sqlite-vec store)
- `TauriMemoryStore.ts` (Tauri IPC to Rust sqlite-vec backend)
- `createMemoryStore.ts` (platform store factory)
- `ConflictResolver.ts` (separate conflict resolution — merged into extraction)
- `prompts/conflict.md` (conflict resolution prompt — merged into extraction prompt)
- Embedding-related config fields from `MemoryConfig` type
- `setMemoryTokenGetter`/`getMemoryTokenGetter` from `createMemoryService.ts`

**Retain**:
- `MemoryService.ts` (refactored — new internals, same public API)
- `FactExtractor.ts` (enhanced — now also handles dedup by reading recent files)
- `CoreMemoryManager.ts` (unchanged — core-memory.md management)
- `MemoryFileSystem.ts` (unchanged — platform filesystem abstraction, now also used for daily files)
- `prompts/extraction.md` (enhanced — now includes dedup instructions)
- `prompts/core_merge.md` (unchanged)
- `types.ts` (simplified — remove embedding-related types)

## Decision 6: Daily File Format

**Decision**: Markdown with `## HH:MM | category` section headers per fact.

```markdown
# 2026-03-17

## 14:32 | personal
User's name is Isaac, software engineer at AI Republic

## 14:35 | project
Working on browserx memory system, replacing sqlite-vec with LLM retrieval
```

**Rationale**:
- Human-readable and grep-friendly
- Category in heading enables filtered search (grep for `| project` to find project facts)
- Timestamp enables temporal queries
- Simple to parse programmatically (split on `## ` headers)
- Date in filename + time in heading = full temporal context

**Alternatives considered**:
- YAML frontmatter per fact: More structured but harder to read/edit
- JSON lines: Machine-friendly but not human-readable
- Flat text with no structure: Loses category/time metadata

## Decision 7: Migration from SQLite

**Decision**: One-time migration script reads existing `memory.db`, groups facts by `created_at` date, writes them to daily markdown files.

**Rationale**:
- Preserves existing user memories
- Groups by creation date maintains temporal accuracy
- Can run automatically on first startup or triggered manually
- Old `memory.db` left in place (not deleted) as backup

**Alternatives considered**:
- No migration (start fresh): Loses existing memories — bad UX
- Keep both systems running in parallel: Too complex, defeats simplification goal
