# Track 05: Session Memory

## Problem

BrowserX has conversation history compaction (`CompactService` with `SummaryGenerator`) but no automatic session memory extraction. When a session ends or context is compacted, nuanced context (user preferences, task state, learned corrections) is lost. There is no:

- Automatic memory extraction during conversation
- Persistent memory file that survives across sessions
- Threshold-based extraction triggers
- Non-blocking extraction via forked agent
- Memory injection into system prompt on session start

Claudy automatically extracts session memory into a persistent file, injecting it into future sessions for continuity.

## What Claudy Does

### Automatic Extraction Triggers

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

1. **Post-turn hook** fires after each model turn
2. **Forked agent** runs in isolated context (separate tool access, no parent cache pollution)
3. **Restricted tool access**: Only FileEditTool on the memory file
4. **Template-based structure**: Current State, Task Spec, Files/Functions, Workflow, Errors & Corrections, Learnings, Key Results, Worklog
5. **Budget**: ~12,000 tokens total, ~2,000 per section

### Memory File

```markdown
# Session Memory

## Current State
[What the user is currently working on]

## Task Specification
[What the user asked to accomplish]

## Key Files and Functions
[Important files, functions, APIs discovered]

## Workflow
[Steps taken, approach used]

## Errors and Corrections
[Mistakes made and how they were corrected]

## Learnings
[Non-obvious things learned during this session]

## Key Results
[Important outputs, findings, decisions]

## Worklog
[Timeline of major actions]
```

### Injection

On session start, the memory file content is prepended to the system prompt as additional context. This gives the model continuity across sessions without replaying the full conversation history.

### Non-Blocking Design

- Extraction runs as a **forked agent** (separate execution context)
- Main conversation continues immediately (no waiting for extraction)
- If extraction takes >15s, it's abandoned (timeout)
- Failed extraction is silently logged (doesn't affect user experience)

## BrowserX Mapping

### Current State

BrowserX has:
- `CompactService` with `SummaryGenerator` for history compression
- `HistoryReconstructor` for rebuilding compacted history
- `RolloutRecorder` for session persistence (append-only journal)
- No cross-session memory file

### Proposed Architecture

```
src/core/memory/
├── SessionMemory.ts          # Extraction orchestration
├── SessionMemoryConfig.ts    # Threshold configuration
├── SessionMemoryTemplate.ts  # Memory file template and sections
├── SessionMemoryExtractor.ts # LLM-based extraction logic
└── SessionMemoryInjector.ts  # Inject memory into system prompt
```

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
- Add token counting integration (from existing TokenUsageStore)
- Add tool call counting since last extraction
- Implement `shouldExtractMemory()` logic

**Phase 3: Extraction Engine** (Week 3)
- Implement `SessionMemoryExtractor` using LLM summarization
- Use existing `SummaryGenerator` pattern as foundation
- Run extraction non-blocking (async, with timeout)
- Restrict tool access during extraction (read-only on memory file)

**Phase 4: Injection & Continuity** (Week 4)
- Implement `SessionMemoryInjector` to prepend memory to system prompt
- Load previous session memory on new session start
- Merge memories from multiple sessions (deduplicate, update stale sections)
- Add `/memory` command to view/edit current memory

## Risks

- **Privacy**: Memory persists across sessions. Users must be able to view and clear it.
- **Staleness**: Memory from weeks ago may be wrong. Add timestamps and staleness checks.
- **Token budget**: Memory injection consumes system prompt tokens. Cap at 12k tokens.
- **Extraction quality**: LLM summarization may lose important details. Use structured sections with size budgets.
