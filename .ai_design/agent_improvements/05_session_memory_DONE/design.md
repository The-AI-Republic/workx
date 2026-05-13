# Track 05: Session Memory

> **Status: DONE** — shipped via PR #167 (`integrate-memory` → `main`, merged 2026-05-12, commit `37a092dd`).
>
> The merged shape differs from the original design here: it is an **LLM-controlled** save/search/forget memory over date-sharded markdown + `core-memory.md`, rather than the **automatic threshold-based** extraction with compaction interlock that this doc described. The original design and the validation notes below are kept for historical reference and as a backlog of ideas (auto-extraction, compaction interlock, feature gates, staleness detection, team sync) that could be layered on top later if needed.

## Problem

BrowserX has conversation history compaction (`CompactService` with `SummaryGenerator`) but no automatic session memory extraction. When a session ends or context is compacted, nuanced context (user preferences, task state, learned corrections) is lost. There is no:

- Automatic memory extraction during conversation
- Persistent memory file that survives across sessions
- Threshold-based extraction triggers
- Non-blocking extraction via forked agent
- Memory injection into future turns as a structured attachment

Claudy automatically extracts session memory into a persistent file, injecting it into future sessions for continuity.

## What Claudy Does

### Automatic Extraction Triggers

Confirmed thresholds in `services/SessionMemory/sessionMemoryUtils.ts:32–36`:
- `minimumMessageTokensToInit = 10000` — first extraction only fires once the conversation crosses 10k message tokens.
- `minimumTokensBetweenUpdate = 5000` — subsequent extractions require 5k token growth since the last update.
- `toolCallsBetweenUpdates = 3` — and at least 3 tool calls since the previous extraction.

```typescript
function shouldExtractMemory(): boolean {
  // Threshold 1: Init (first extraction after 10k tokens)
  if (!initialized && tokens < 10000) return false

  // Threshold 2: Growth (5k tokens since last extraction)
  const tokenGrowth = currentTokens - tokensAtLastExtraction
  const hasTokenThreshold = tokenGrowth >= 5000

  // Threshold 3: Activity (3+ tool calls since last extraction)
  const toolCalls = countToolCallsSince(lastMemoryMessageUuid)
  const hasToolCallThreshold = toolCalls >= 3

  // Trigger when:
  // - Both token AND tool call thresholds met, OR
  // - Token threshold met AND natural break (no tools in last turn)
  return (hasTokenThreshold && hasToolCallThreshold) ||
         (hasTokenThreshold && !hasToolCallsInLastTurn)
}
```

### Extraction Architecture

1. **Post-sampling hook** fires after each model turn (`services/SessionMemory/sessionMemory.ts:323`)
2. **Forked agent** runs via `runForkedAgent()` with `forkLabel: 'session_memory'` in an isolated context (separate tool access, no parent cache pollution)
3. **15s timeout**: extractions that exceed the budget are abandoned silently
4. **Restricted tool access**: Only FileEditTool on the memory file
5. **Template-based structure** (~9–10 generic IT-engineering sections per `services/SessionMemory/prompts.ts`): Current State, Task Specification, Files & Functions, Workflow, Errors & Corrections, Documentation, Learnings, Key Results, Worklog
6. **Budget**: ~12,000 tokens total, ~2,000 per section

### Memory File

Claudy stores a **single consolidated `summary.md` per session** at `{projectDir}/{sessionId}/session-memory/summary.md` (see `services/SessionMemory/sessionMemoryUtils.ts` `getSessionMemoryPath()`). It is **not** date-sharded and **not** split across multiple files — every extraction rewrites the same file in place.

```markdown
# Session Memory

## Current State
[What the user is currently working on]

## Task Specification
[What the user asked to accomplish]

## Files & Functions
[Important files, functions, APIs discovered]

## Workflow
[Steps taken, approach used]

## Errors & Corrections
[Mistakes made and how they were corrected]

## Documentation
[Relevant docs, references, links surfaced during the session]

## Learnings
[Non-obvious things learned during this session]

## Key Results
[Important outputs, findings, decisions]

## Worklog
[Timeline of major actions]
```

### Injection

Claudy injects the memory file as an **attachment** of `type: 'current_session_memory'` (see `utils/attachments.ts`) on subsequent turns — *not* prepended to the system prompt. Attachment-based injection avoids unbounded prompt bloat (the system prompt stays cacheable and stable) and lets the renderer place memory inline with other turn context. This gives the model continuity across sessions without replaying the full conversation history.

### Manual Extraction & Editing

- `manuallyExtractSessionMemory()` triggers an extraction on demand, bypassing the threshold checks above.
- The `/memory` slash command opens the `summary.md` in an editor for direct user edits.

### Compaction Interlock

`services/compact/sessionMemoryCompact.ts` calls `waitForSessionMemoryExtraction()` before rewriting the conversation history. This guarantees an in-flight extraction finishes before compaction discards the source context — important because compaction is destructive.

### Feature Gates & Telemetry

- **GrowthBook gate `tengu_session_memory`** controls whether the feature is on for a given user.
- **Remote-config `tengu_sm_config`** allows server-side override of the token/tool-call thresholds without a client release.
- **Staleness detection**: `memoryAge.ts` warns when memory is stale (e.g., resumed after a long gap).
- **Telemetry**: extraction emits `logEvent()` records with token counts, config snapshot, and duration, enabling quality and frequency monitoring.
- **Team memory**: `services/teamMemorySync/` provides multi-user memory sync (out of scope for BrowserX v1 but worth noting for future cross-device parity).

### Non-Blocking Design

- Extraction runs as a **forked agent** (separate execution context)
- Main conversation continues immediately (no waiting for extraction)
- If extraction takes >15s, it's abandoned (timeout)
- Failed extraction is silently logged (doesn't affect user experience)

## BrowserX Mapping

### Current State (Existing Infrastructure)

BrowserX has several systems that session memory must integrate with:

- **`CompactService`** with `SummaryGenerator` for history compression — compaction triggers at `COMPACTION_THRESHOLD = 0.85` in `TaskRunner.ts` (lines 708-734), with LLM-based summarization in `attemptAutoCompact()` (lines 739-765). **Memory extraction must coordinate with this path** to avoid losing context that should be persisted to memory.
- **`HistoryReconstructor`** for rebuilding compacted history
- **`RolloutRecorder`** for session persistence (append-only journal) — should capture memory snapshots as part of session recording
- **`PromptLoader.registerPromptExtension()`** (`src/core/PromptLoader.ts:25-58`) — a module-level registry of callback functions that are appended to the system prompt on every `loadPrompt()` call. **Memory injection should use this existing mechanism** rather than building a custom `SessionMemoryInjector`.
- **`TokenUsageStore`** — already tracks token usage per-session, can be used for extraction threshold checks
- No cross-session memory file

### Integration Protocol

**Extraction-before-compaction ordering:** Memory extraction must run *before* compaction discards context. When `TaskRunner.shouldCompactBeforeRequest()` returns true:
1. Trigger memory extraction first (extract important context from current history)
2. Then proceed with compaction (which may discard the detailed history)
3. This prevents the scenario where compaction summarizes context away before memory has a chance to capture it

**Memory injection via `registerPromptExtension()`:** Instead of a custom `SessionMemoryInjector`, register a prompt extension callback:
```typescript
// On session start:
registerPromptExtension(() => {
  const memory = loadMemoryFile(sessionMemoryPath);
  return memory ? `\n\n<session-memory>\n${memory}\n</session-memory>` : '';
});
```
This integrates naturally with existing prompt loading and other extensions (e.g., skill prompts from `SkillRegistry.buildSkillsSystemPrompt()`).

**Rollout persistence:** `RolloutRecorder` should capture memory snapshots as part of session recording, allowing session replay to include memory state at each point.

### Proposed Architecture

```
src/core/memory/
├── SessionMemory.ts          # Extraction orchestration
├── SessionMemoryConfig.ts    # Threshold configuration
├── SessionMemoryTemplate.ts  # Memory file template and sections
└── SessionMemoryExtractor.ts # LLM-based extraction logic
```

> **Note:** No `SessionMemoryInjector` is needed — memory injection uses the existing `PromptLoader.registerPromptExtension()` mechanism (see Integration Protocol above).

### Memory Sections for BrowserX

BrowserX operates in a browser context, so the memory template should reflect this:

```markdown
# Session Memory

## Current Task
[What the user is trying to accomplish in the browser]

## Active Websites
[Key websites, domains, and pages being worked with]

## User Preferences
[Learned preferences: approval mode, preferred actions, domain trust]

## Navigation History
[Important page sequences and discovered paths]

## Form Data Patterns
[Recurring form fields, credentials (references only), saved inputs]

## Errors and Workarounds
[Failed actions and how they were resolved - selector changes, timing, etc.]

## Extracted Data
[Key data points, findings, or comparisons from browsing sessions]

## Workflow State
[Where we are in a multi-step workflow, what's left]
```

### Comparison to BrowserX integrate-memory PR #167

- **PR #167** ships LLM-controlled `save` / `search` / `forget` tools over date-sharded markdown plus a long-lived `core-memory.md`. The model decides when to write.
- **Claudy** ships *automatic* threshold-based extraction (10k init / 5k growth / 3 tool calls) into a single `summary.md`, with a forked-agent extractor and a compaction interlock.
- The two are **complementary**, not duplicative: PR #167 does not deliver auto-extraction, post-sampling forked extraction, or the compaction interlock. Track 05 as scoped here remains open even after PR #167 merges — the auto-extraction path, attachment-based injection, and `waitForSessionMemoryExtraction()` interlock would need to be added on top of PR #167's manual storage layer.

### Key Differences from Claudy

1. **Domain context**: BrowserX memory is website-aware (tracks domains, pages, selectors)
2. **Visual context**: Can reference screenshots and DOM snapshots
3. **Approval memory**: Track which domains/actions were approved (avoid re-asking)
4. **Selector stability**: Remember working selectors for frequently visited sites

### Phase Plan

**Phase 1: Memory File & Template** (Week 1)
- Define memory file template with BrowserX-specific sections
- Implement `SessionMemoryTemplate` with section parsing and size budgets
- Add memory file storage path (per-session, persistent)
- Implement memory file read/write utilities

**Phase 2: Extraction Triggers** (Week 2)
- Implement `SessionMemoryConfig` with configurable thresholds
- Add token counting integration (from existing `TokenUsageStore`)
- Add tool call counting since last extraction
- Implement `shouldExtractMemory()` logic
- **Coordinate thresholds with `TaskRunner.COMPACTION_THRESHOLD` (0.85)**: extraction should trigger before compaction to avoid data loss. E.g., extract at 0.70 context usage, compact at 0.85.

**Phase 3: Extraction Engine** (Week 3)
- Implement `SessionMemoryExtractor` using LLM summarization
- Use existing `SummaryGenerator` pattern as foundation
- Run extraction non-blocking (async, with timeout)
- Restrict tool access during extraction (read-only on memory file)
- **Hook into `TaskRunner.runLoop()`**: add extraction check before the compaction check at line 298, ensuring memory is captured before context is summarized

**Phase 4: Injection & Continuity** (Week 4)
- Register memory injection via `PromptLoader.registerPromptExtension()` (no custom injector needed)
- Load previous session memory on new session start
- Merge memories from multiple sessions (deduplicate, update stale sections)
- Capture memory snapshots in `RolloutRecorder` for session replay
- Add `/memory` command to view/edit current memory

## Risks

- **Privacy**: Memory persists across sessions. Users must be able to view and clear it.
- **Staleness**: Memory from weeks ago may be wrong. Add timestamps and staleness checks.
- **Token budget**: Memory injection consumes system prompt tokens. Cap at 12k tokens.
- **Extraction quality**: LLM summarization may lose important details. Use structured sections with size budgets.

## Validation Notes (re-checked vs claudy 2026-05-11)

Re-validation against claudy source produced these corrections to the original draft:

1. **Injection path fixed.** Claudy injects memory as an attachment of `type: 'current_session_memory'` (`utils/attachments.ts`), *not* prepended to the system prompt. Avoids prompt bloat and preserves system-prompt cacheability.
2. **File shape clarified.** A single consolidated `summary.md` per session at `{projectDir}/{sessionId}/session-memory/summary.md` (`services/SessionMemory/sessionMemoryUtils.ts` `getSessionMemoryPath()`). Not date-sharded, not multi-file. Template is ~9–10 generic IT-engineering sections in `services/SessionMemory/prompts.ts`.
3. **Thresholds confirmed.** `minimumMessageTokensToInit = 10000`, `minimumTokensBetweenUpdate = 5000`, `toolCallsBetweenUpdates = 3` (`services/SessionMemory/sessionMemoryUtils.ts:32–36`).
4. **Forked extractor confirmed.** Extraction runs via `runForkedAgent()` with `forkLabel: 'session_memory'`, post-sampling hook, 15s timeout (`services/SessionMemory/sessionMemory.ts:323`).
5. **Compaction interlock added.** `services/compact/sessionMemoryCompact.ts` calls `waitForSessionMemoryExtraction()` before rewriting history.
6. **Manual `/memory` path added.** `manuallyExtractSessionMemory()` bypasses thresholds; `/memory` opens the file in an editor.
7. **Feature gates added.** GrowthBook gate `tengu_session_memory` and remote-config `tengu_sm_config` for threshold overrides.
8. **Staleness detection noted** via `memoryAge.ts`.
9. **Team memory noted.** `services/teamMemorySync/` exists; out of scope for BrowserX v1.
10. **Telemetry noted.** `logEvent()` captures token counts, config, and duration per extraction.
11. **PR #167 comparison added.** PR #167 (LLM-controlled save/search/forget over date-sharded markdown + `core-memory.md`) is complementary to claudy's automatic threshold-based extraction with a single `summary.md`. Track 05 remains open after PR #167 merges because auto-extraction and the compaction interlock are not delivered there.

Cited paths: `services/SessionMemory/sessionMemory.ts`, `services/SessionMemory/sessionMemoryUtils.ts`, `services/SessionMemory/prompts.ts`, `services/compact/sessionMemoryCompact.ts`, `utils/attachments.ts`.
