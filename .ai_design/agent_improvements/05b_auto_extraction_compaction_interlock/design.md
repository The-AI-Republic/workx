# Track 05b: Auto-Extraction & Compaction Interlock

> **Status:** design — first PR scope. Layers claudy's automatic session-summary extractor on top of the now-merged PR #167 (LLM-controlled memory) and PR #191 (typed task layer / `TaskRunner`). Targets `agent-improvements` once `main` has been merged in.

## 1. Status & prerequisites

This design adds an **automatic, threshold-driven session summarization loop** plus a **compaction interlock** so destructive history rewrites in `CompactService.compact()` cannot race ahead of an in-flight extraction. It is the auto-extraction half of the original Track 05 design that PR #167 explicitly deferred (see `05_session_memory_DONE/design.md:5`).

### Hard prerequisite — merge `main` → `agent-improvements`

`agent-improvements` is currently 45 commits behind `main` (HEAD `d8bb6aec` after PR #191). The merge is non-optional; this work consumes three surfaces that only exist on `main`:

| Path / symbol | First commit on `main` | Used by 05b for |
| --- | --- | --- |
| `src/core/PromptLoader.ts` — `registerPromptExtension(name, fn)` / `unregisterPromptExtension(name)` / `appendExtensions()` | `bb493e7d` | Prompt-side injection of the truncated session summary (§10) |
| `src/core/memory/MemoryFileSystem.ts` — `createMemoryFileSystem()` returning `{ fs, memoryDir }` (desktop = `~/.airepublic-pi/memory/`, server = `~/.airepublic-pi/memory/`) | `4480923c`, `767436a1` | Per-session summary file path under `<memoryRoot>/sessions/<sessionId>/summary.md` (§9) |
| `src/core/memory/types.ts` — `FileSystem` interface (`readFile`/`writeFile`/`ensureDir`/`exists`) | `9ff89ebd` | Reused as-is by `SessionSummaryFileStore` (§9) |

Don't add a parallel filesystem abstraction. Don't add a parallel prompt-attachment pipeline. Reuse the post-#167 surfaces.

### Soft dependency — Track 04 concurrency-seam fix

`Session.spawnTask` still aborts every sibling on entry (`src/core/Session.ts:1316–1357`, esp. `await this.abortAllTasks('UserInterrupt')` at line 1323). PR #191 did **not** land Track 04's concurrency-seam fix. We do not strictly need it, because the extractor is routed through `SubAgentRunner.run({ background: true, quietBackground: true })` — i.e. it lives entirely inside `RepublicAgentEngine` and never touches `Session.spawnTask`. If/when Track 04 lands, no change is required here.

## 2. Goal

- A long-running session writes `<memoryRoot>/sessions/<sessionId>/summary.md` automatically as the conversation grows past tunable thresholds, without blocking the foreground turn.
- The next `CompactService.compact()` invocation (auto or manual) waits for any in-flight extraction, then folds the summary into the compaction prompt so the destructive rewrite preserves the high-signal context.
- The summary is injected on subsequent turns through `PromptLoader.registerPromptExtension('session_summary', ...)`, with the same per-section truncation claudy uses.

## 3. Architecture overview

```
                                                 ┌────────────────────────────────────────┐
 user turn ──► RepublicAgent ──► TurnManager.tryRunTurn()                                  │
                                  │  (src/core/TurnManager.ts:192)                         │
                                  │                                                        │
                                  │  on `Completed` event (line 253)                       │
                                  │  ───────────────────────────────► postTurnHooks[*] ────┤
                                  │                                                        │
                                  ▼                                                        │
                         TurnRunResult returned                                            │
                                                                                           ▼
                                                                          SessionSummaryHook (registered
                                                                          once at session start)
                                                                          src/core/sessionSummary/
                                                                            SessionSummaryHook.ts
                                                                                           │
                                                                                           │ shouldExtract(...)?
                                                                                           │ markExtractionStarted(sid)
                                                                                           ▼
                                              ┌── SubAgentRunner.run({ background: true,
                                              │     quietBackground: true,
                                              │     type: 'session_summary_extractor' })
                                              │     src/tools/AgentTool/SubAgentRunner.ts:63
                                              │
                                              │   • createSubAgentToolRegistry() with allow=['file_edit']
                                              │     src/tools/ToolRegistryCloner.ts:59
                                              │   • createSummaryFileCanUseTool(summaryPath)
                                              │     src/core/sessionSummary/summaryFileTools.ts (NEW)
                                              │   • cache-safe params: parent systemPrompt + tools
                                              │
                                              ▼
                          extractor child engine ──► writes <summary.md>  via FileEditTool only
                                              │     (anything else returns deny + decisionReason)
                                              │
                                              ▼
                          finally { markExtractionCompleted(sid) }    (NO <task-notification>)

  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

 next turn ──► PromptLoader.loadPrompt()
                  │  src/core/PromptLoader.ts (post-merge)
                  ▼
              appendExtensions()  ──► 'session_summary' fn reads summaryPath,
                                       runs truncateSessionSummaryForCompact(),
                                       returns prompt fragment

  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

 auto-compaction ─► TaskRunner.attemptAutoCompact()
                       │  src/core/TaskRunner.ts:759
                       ▼
                    session.compact('auto', modelClient)  ─► CompactService.compact()
                       │                                       src/core/compact/CompactService.ts:71
                       ▼
                    await waitForSessionSummaryExtraction(sessionId)   (NEW, top of compact())
                       │      timeout = 15s, stale escape = 60s
                       ▼
                    optional: read summary.md and pass into SummaryGenerator
                       src/core/compact/CompactService.ts:249 (generateSummaryWithModel)
```

## 4. Extraction sub-agent

A new `SubAgentTypeConfig` registered with `SubAgentRunner` at session start.

```ts
// src/core/sessionSummary/extractorType.ts (NEW)
import type { SubAgentTypeConfig } from '@/tools/AgentTool/types';
import { SESSION_SUMMARY_EXTRACTION_PROMPT } from './prompts';

export const SESSION_SUMMARY_EXTRACTOR_TYPE: SubAgentTypeConfig = {
  id: 'session_summary_extractor',
  name: 'Session Summary Extractor',
  description: 'Internal: extracts a structured summary of the current session into summary.md.',
  systemPrompt: SESSION_SUMMARY_EXTRACTION_PROMPT, // mirrors claudy services/SessionMemory/prompts.ts
  tools: { allow: ['file_edit'] },
  approvalPolicy: 'never',
  maxTurns: 4,
  // Suppress noisy child events; hook never surfaces extractor output to user.
  suppressedEvents: ['AgentMessageDelta', 'AgentReasoningDelta', 'AgentMessage'],
};
```

### Spawn path — quiet background

The extractor must NOT inject `<task-notification>` into the parent's pending input on completion (claudy's session-memory extractor is silent; injecting a notification would re-prompt the user-visible LLM with bookkeeping noise). Add a `quietBackground` flag to `SubAgentToolParams`:

```ts
// src/tools/AgentTool/types.ts — extend SubAgentToolParams
export interface SubAgentToolParams {
  // ...existing fields...
  /** Whether to run this sub-agent in the background */
  background?: boolean;
  /**
   * When background=true, suppress the synthetic <task-notification> that is
   * normally injected into the parent's pending input on completion.
   * Used by internal extractors (session summary) where the parent LLM should
   * never see the bookkeeping completion event.
   */
  quietBackground?: boolean;
}
```

`SubAgentRunner.run()` (src/tools/AgentTool/SubAgentRunner.ts:121–163) gates the `safeEnqueueNotification` call:

```ts
// src/tools/AgentTool/SubAgentRunner.ts (modify lines 123–143)
const result = await this.execute(context, params);
if (!context.cancelled && !params.quietBackground) {
  this.safeEnqueueNotification(
    context,
    this.formatTaskNotification(context, params, result),
  );
}
// ... mirror in the catch branch ...
```

### Tool restriction — `createSummaryFileCanUseTool(summaryPath)`

Mirror claudy's `createMemoryFileCanUseTool` shape. Final defence-in-depth: even though `createSubAgentToolRegistry` only exposes `file_edit` (`src/tools/ToolRegistryCloner.ts:59`), a per-call `canUseTool` rejects any path that isn't the exact summary file.

```ts
// src/core/sessionSummary/summaryFileTools.ts (NEW)
import path from 'path';

export type CanUseToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; decisionReason: string };

export function createSummaryFileCanUseTool(summaryPath: string) {
  const allowed = path.resolve(summaryPath);
  return (toolName: string, input: unknown): CanUseToolDecision => {
    if (toolName !== 'file_edit') {
      return {
        behavior: 'deny',
        decisionReason: `session_summary_extractor may only call file_edit; got ${toolName}`,
      };
    }
    const target =
      input && typeof input === 'object' && 'path' in input
        ? String((input as { path: unknown }).path)
        : '';
    if (!target || path.resolve(target) !== allowed) {
      return {
        behavior: 'deny',
        decisionReason: `file_edit restricted to ${allowed}; got ${target || '<missing path>'}`,
      };
    }
    return { behavior: 'allow' };
  };
}
```

This `canUseTool` is wired through the child engine's approval gate (the `approvalGate` slot already in `RepublicAgentEngineConfig`; `SubAgentRunner.prepare()` at src/tools/AgentTool/SubAgentRunner.ts:243–248 already accepts an override).

### Cache-safe params

The extractor must hit the parent's prompt cache. `SubAgentRunner.prepare()` already inherits `parentConfig.model` and `browserContext` (lines 254–258). For 05b we add a small `buildCacheSafeParams(parentEngine)` helper used by the hook:

```ts
// src/core/sessionSummary/cacheSafeParams.ts (NEW)
import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { SubAgentToolParams } from '@/tools/AgentTool/types';

export function buildExtractorParams(
  parentEngine: RepublicAgentEngine,
  prompt: string,
): SubAgentToolParams {
  return {
    type: 'session_summary_extractor',
    prompt,                      // identical message prefix as claudy
    description: 'session summary extraction',
    background: true,
    quietBackground: true,
    // model + tools + systemPrompt are inherited from parent engine via
    // SubAgentRunner.prepare() (SubAgentRunner.ts:233–262). Do NOT override
    // any of those — drift kills the prompt cache.
  };
}
```

`_subAgent` metadata (`engineId`, `parentEngineId`, `depth`) is already namespaced by `SubAgentEventRouter` (src/core/events/SubAgentEventRouter.ts) and `RepublicAgentEngine.createChildEngine()` (src/core/engine/RepublicAgentEngine.ts:332–362). No changes needed there.

### Concurrency — bypass the user-facing cap

`SubAgentRegistry`'s default cap is 3 (src/tools/AgentTool/SubAgentRegistry.ts:59). The extractor is internal infrastructure and must not steal a slot from a user-spawned worker.

Construct a *separate* `SubAgentRegistry` instance dedicated to internal extractors with `maxConcurrent: 1`, owned by `SessionSummaryHook`. The hook passes this registry to a dedicated `SubAgentRunner({ parentEngine, registry })` instance. This keeps `SubAgentRegistry` semantics unchanged for user-facing flows.

```ts
// src/core/sessionSummary/SessionSummaryHook.ts (NEW, excerpt)
this.internalRegistry = new SubAgentRegistry({ maxConcurrent: 1 });
this.runner = new SubAgentRunner({
  parentEngine,
  registry: this.internalRegistry,
  customTypes: [SESSION_SUMMARY_EXTRACTOR_TYPE],
});
```

### Failure mode

The hook wraps the spawn in `try { ... } catch (err) { telemetry.failure(err); } finally { markExtractionCompleted(sessionId); }`. The hook never throws back into `TurnManager`. On any failure: emit telemetry, leave the existing `summary.md` in place (or absent), continue.

## 5. Trigger — post-turn hook in TurnManager

There is no post-sampling hook registry today (`src/core/TurnManager.ts:192–311` — the body of `tryRunTurn`). Add one.

```ts
// src/core/TurnManager.ts (additions)

export interface PostTurnContext {
  sessionId: string;
  history: ResponseItem[];           // from this.turnContext or session
  totalTokenUsage?: TokenUsage;
  lastTurnHadToolCalls: boolean;
  abortSignal?: AbortSignal;
}

export type PostTurnHook = (ctx: PostTurnContext) => Promise<void>;

export class TurnManager {
  private postTurnHooks: PostTurnHook[] = [];

  /** Register a hook fired after every turn that reaches `'Completed'`. Returns an unregister fn. */
  registerPostTurnHook(fn: PostTurnHook): () => void {
    this.postTurnHooks.push(fn);
    return () => {
      const i = this.postTurnHooks.indexOf(fn);
      if (i >= 0) this.postTurnHooks.splice(i, 1);
    };
  }
}
```

Call site — immediately before the `return` at `src/core/TurnManager.ts:253–261` (the `case 'Completed':` block):

```ts
case 'Completed': {
  totalTokenUsage = event.tokenUsage;

  // === NEW: fire post-turn hooks (errors swallowed, mirroring claudy
  //         executePostSamplingHooks). Sequential to preserve ordering and
  //         to keep the single-extraction invariant cheap to enforce.
  const lastTurnHadToolCalls = processedItems.some(
    (p) => p.item?.type === 'function_call' || p.item?.type === 'tool_call',
  );
  for (const hook of this.postTurnHooks) {
    try {
      await hook({
        sessionId: this.session.getSessionId(),
        history: this.session.getConversationHistory().items,
        totalTokenUsage,
        lastTurnHadToolCalls,
        abortSignal: this.cancelAbortController?.signal,
      });
    } catch (err) {
      console.warn('[TurnManager] postTurnHook failed:', err);
    }
  }

  return { processedItems, totalTokenUsage };
}
```

`SessionSummaryHook.attach(turnManager)` calls `registerPostTurnHook`; `SessionSummaryHook.detach()` invokes the returned unregister. Attach happens once per session at `Session` construction (where `TurnManager` is wired up); detach on session shutdown.

## 6. Extraction trigger predicate

```ts
// src/core/sessionSummary/sessionSummaryUtils.ts (NEW)

import { estimateRequestTokens } from '@/core/compact/utils';
import type { ResponseItem } from '@/core/protocol/types';

export const DEFAULT_SESSION_SUMMARY_CONFIG = {
  /** First extraction only fires after this many message tokens. */
  minimumMessageTokensToInit: 15_000,
  /** Subsequent extractions require this much token growth since the last one. */
  minimumTokensBetweenUpdate: 8_000,
  /** And this many tool calls since the last extraction. */
  toolCallsBetweenUpdates: 5,
} as const;

export const EXTRACTION_WAIT_TIMEOUT_MS = 15_000;
export const EXTRACTION_STALE_THRESHOLD_MS = 60_000;
export const EXTRACTION_POLL_INTERVAL_MS = 1_000;

export interface ExtractionState {
  initialized: boolean;
  tokensAtLastExtraction: number;
  toolCallsAtLastExtraction: number;
}

export function shouldExtractSessionSummary(args: {
  history: ResponseItem[];
  state: ExtractionState;
  lastTurnHadToolCalls: boolean;
  config?: typeof DEFAULT_SESSION_SUMMARY_CONFIG;
}): boolean {
  const cfg = args.config ?? DEFAULT_SESSION_SUMMARY_CONFIG;
  const tokens = estimateRequestTokens(args.history); // single source of truth

  // Init gate
  if (!args.state.initialized && tokens < cfg.minimumMessageTokensToInit) {
    return false;
  }

  const tokenGrowth = tokens - args.state.tokensAtLastExtraction;
  const hasTokenThreshold = tokenGrowth >= cfg.minimumTokensBetweenUpdate;

  const toolCalls = countToolCalls(args.history) - args.state.toolCallsAtLastExtraction;
  const hasToolCallThreshold = toolCalls >= cfg.toolCallsBetweenUpdates;

  return (
    (hasTokenThreshold && hasToolCallThreshold) ||
    (hasTokenThreshold && !args.lastTurnHadToolCalls)
  );
}

function countToolCalls(history: ResponseItem[]): number {
  let n = 0;
  for (const item of history) {
    if (item.type === 'function_call' || item.type === 'tool_call') n++;
    if (item.type === 'message' && Array.isArray(item.tool_calls)) n += item.tool_calls.length;
  }
  return n;
}
```

### Why higher thresholds than claudy

Claudy: 10k init / 5k growth / 3 tool calls. BrowserX turns routinely include large DOM snapshots, screenshots, and `page_text` dumps, so per-turn input is materially larger than a coding agent's diffs. We start at **15k / 8k / 5** to avoid spawning the extractor on a single fat tool round. Numbers are exposed via `DEFAULT_SESSION_SUMMARY_CONFIG` for telemetry-driven tuning.

### Single source of truth for token counting

Both this predicate and `CompactService.shouldCompact()` (`src/core/compact/CompactService.ts:40–59`) must agree on window sizing. We reuse `estimateRequestTokens()` from `src/core/compact/utils.ts:139–196` (the existing `1 token ≈ 4 chars` heuristic). Do **not** reimplement.

## 7. Concurrency & flag lifecycle

BrowserX supports multiple parallel agents (each with its own `Session` / UUID). Per-session — not module-global — extraction guard.

```ts
// src/core/sessionSummary/extractionLifecycle.ts (NEW)

const extractionStartedAt = new Map<string, number>();

export function isExtractionInFlight(sessionId: string): boolean {
  return extractionStartedAt.has(sessionId);
}

export function markExtractionStarted(sessionId: string): void {
  extractionStartedAt.set(sessionId, Date.now());
}

export function markExtractionCompleted(sessionId: string): void {
  extractionStartedAt.delete(sessionId);
}

export function getExtractionAgeMs(sessionId: string): number | undefined {
  const started = extractionStartedAt.get(sessionId);
  return started === undefined ? undefined : Date.now() - started;
}
```

Spawn guard in the hook:

```ts
// SessionSummaryHook.handlePostTurn (excerpt)
if (isExtractionInFlight(sessionId)) {
  telemetry.skipped({ reason: 'in_flight', sessionId });
  return;
}
markExtractionStarted(sessionId);
try {
  await this.runner.run(buildExtractorParams(parentEngine, prompt));
} catch (err) {
  telemetry.extractionFailure({ sessionId, error: String(err) });
} finally {
  markExtractionCompleted(sessionId);   // NEVER conditional. Always cleared.
}
```

The `finally` clause is the only place the flag is cleared. An invariant unit test asserts that throwing from `runner.run` still clears the flag.

## 8. Compaction interlock

`CompactService.compact()` (`src/core/compact/CompactService.ts:71–195`) is invoked synchronously from `TaskRunner.attemptAutoCompact()` (`src/core/TaskRunner.ts:759`, with the `await this.session.compact(...)` call inside it at line `766`). The minimal-blast-radius patch is to await an interlock at the very top of `compact()`.

### `waitForSessionSummaryExtraction(sessionId)`

```ts
// src/core/sessionSummary/extractionLifecycle.ts (continued)

import {
  EXTRACTION_WAIT_TIMEOUT_MS,
  EXTRACTION_STALE_THRESHOLD_MS,
  EXTRACTION_POLL_INTERVAL_MS,
} from './sessionSummaryUtils';

/**
 * Block compaction until any in-flight extraction for this session completes,
 * with a 15s hard wait and a 60s staleness escape (matches claudy verbatim).
 */
export async function waitForSessionSummaryExtraction(sessionId: string): Promise<void> {
  const deadline = Date.now() + EXTRACTION_WAIT_TIMEOUT_MS;
  while (isExtractionInFlight(sessionId)) {
    const ageMs = getExtractionAgeMs(sessionId) ?? 0;
    if (ageMs >= EXTRACTION_STALE_THRESHOLD_MS) {
      // Stale flag — extractor crashed without clearing. Force-clear and proceed.
      markExtractionCompleted(sessionId);
      return;
    }
    if (Date.now() >= deadline) {
      // Hard timeout — proceed anyway. Telemetry recorded by caller.
      return;
    }
    await new Promise((r) => setTimeout(r, EXTRACTION_POLL_INTERVAL_MS));
  }
}
```

### Patch in `CompactService`

Pass `sessionId` into `compact()` (single new optional arg, propagate from `Session.compact` → `CompactService.compact`).

```ts
// src/core/compact/CompactService.ts:71–84 (modified)
async compact(
  history: ResponseItem[],
  trigger: CompactionTrigger,
  modelClient: ModelClient,
  tokensBefore: number = 0,
  baseInstructions?: string,
  sessionId?: string,                 // NEW (optional for back-compat)
): Promise<CompactionResult> {

  // === NEW: interlock — wait for any in-flight session summary extraction.
  if (sessionId) {
    const waitStart = Date.now();
    await waitForSessionSummaryExtraction(sessionId);
    const waitedMs = Date.now() - waitStart;
    if (waitedMs >= EXTRACTION_WAIT_TIMEOUT_MS) {
      telemetry.compactExtractionWaitTimeout({ sessionId, waitedMs });
    }
  }

  // ... existing body unchanged ...
}
```

### Folding the summary into the compaction prompt

After the wait, optionally read `summary.md` and prepend it into the summarization request. Integration point: inside `generateSummaryWithModel()` (called from line 92), pass an additional `sessionSummaryHint?: string` so `SUMMARIZATION_PROMPT` can reference it. Keep the change small — don't rewrite `SummaryGenerator`. If the file is missing or `isSessionSummaryEmpty()` returns true, skip the hint and emit `browserx_compact_skipped_empty_summary` telemetry. Otherwise emit `browserx_compact_with_summary` with `{ tokens_before, tokens_after, summary_token_count }`.

### Failure modes

| Case | Behaviour |
| --- | --- |
| Extraction fails before compaction triggers | `summary.md` is whatever the previous successful extraction wrote (or absent). Compaction proceeds without the hint. Telemetry: `browserx_session_summary_extraction` with `success=false`; `browserx_compact_skipped_empty_summary` if file absent/empty. |
| Extraction succeeds but compaction fails | History rewrite never happens; the existing `CompactService` retry loop (lines 89–108) handles it. Summary file is unaffected. |
| Wait times out (15 s) | `waitForSessionSummaryExtraction` returns. Compaction proceeds. Extraction continues in the background; if it later writes `summary.md`, the *next* compaction picks it up. Telemetry: `browserx_compact_extraction_wait_timeout`. |

## 9. Output target — session summary file

Reuse `MemoryFileSystem` (post-merge) instead of inventing a new fs adapter.

```ts
// src/core/sessionSummary/SessionSummaryFileStore.ts (NEW)

import path from 'path';
import type { FileSystem } from '@/core/memory/types';

const SESSIONS_SUBDIR = 'sessions';
const SUMMARY_FILENAME = 'summary.md';

export function getSessionSummaryPath(memoryRoot: string, sessionId: string): string {
  return path.join(memoryRoot, SESSIONS_SUBDIR, sessionId, SUMMARY_FILENAME);
}

export class SessionSummaryFileStore {
  constructor(private readonly fs: FileSystem, private readonly memoryRoot: string) {}

  pathFor(sessionId: string): string {
    return getSessionSummaryPath(this.memoryRoot, sessionId);
  }

  async ensureScaffold(sessionId: string, template: string): Promise<string> {
    const file = this.pathFor(sessionId);
    await this.fs.ensureDir(path.dirname(file));
    if (!(await this.fs.exists(file))) {
      await this.fs.writeFile(file, template);
      // Best-effort 0o600 on platforms that support it; the FileSystem
      // interface doesn't expose chmod, so tighten via the underlying adapter
      // (Tauri / Node) when extended in a follow-up.
    }
    return file;
  }

  async read(sessionId: string): Promise<string> {
    const file = this.pathFor(sessionId);
    if (!(await this.fs.exists(file))) return '';
    return this.fs.readFile(file);
  }
}
```

### Template

Mirrors claudy's 9 sections plus 2 BrowserX-specific sections at the top.

```markdown
# Session Summary

## Pages Visited
[URLs the agent navigated to during this session]

## Forms Filled / Interactions Performed
[Form submissions, clicks, keyboard inputs of note]

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

The literal template lives in `src/core/sessionSummary/template.ts` as a single exported `SESSION_SUMMARY_TEMPLATE` constant.

### Empty check

```ts
// src/core/sessionSummary/SessionSummaryFileStore.ts (continued)
import { SESSION_SUMMARY_TEMPLATE } from './template';

/**
 * String-compare to the canonical template. Any diff means the extractor
 * touched the file. Mirrors claudy isSessionMemoryEmpty.
 */
export async function isSessionSummaryEmpty(content: string): Promise<boolean> {
  return content.trim() === SESSION_SUMMARY_TEMPLATE.trim();
}
```

Permissions: 0o600 where supported. The current `FileSystem` interface (`src/core/memory/types.ts:75–80`) does not expose chmod. Acceptable for first PR (files live in user-private `~/.airepublic-pi/`); follow-up to add `chmodFile?` to `FileSystem` if the threat model demands it.

## 10. Injection — system prompt extension

Use the API PR #167 added (`src/core/PromptLoader.ts` post-merge). Do not roll a parallel attachment pipeline.

```ts
// src/core/sessionSummary/SessionSummaryHook.ts (excerpt)
import { registerPromptExtension, unregisterPromptExtension } from '@/core/PromptLoader';
import { truncateSessionSummaryForCompact } from './truncate';

attach(turnManager: TurnManager): void {
  this.unregisterTurn = turnManager.registerPostTurnHook((ctx) => this.handlePostTurn(ctx));
  registerPromptExtension('session_summary', () => this.renderForPrompt());
}

detach(): void {
  this.unregisterTurn?.();
  unregisterPromptExtension('session_summary');
}

private renderForPrompt(): string {
  // Sync-only callback — read from a small in-memory cache populated whenever
  // the extractor reports completion (event from the child engine), or lazily
  // primed at attach() time.
  const content = this.cachedSummary;
  if (!content) return '';
  // We already string-checked emptiness when caching; safe to skip here.
  return truncateSessionSummaryForCompact(content);
}
```

Cache invalidation: the hook subscribes to its own `internalRegistry` `SubAgentComplete` events. On completion it reads `summary.md` once and stores the result in `this.cachedSummary`. This keeps `loadPrompt()` (sync extension callback) cheap.

### Per-section truncation

Mirror claudy's character-boundary truncator. ≤ 2000 chars per section, ≤ ~12000 tokens total. Truncate at the last newline before the boundary; never mid-line.

```ts
// src/core/sessionSummary/truncate.ts (NEW)

const MAX_SECTION_CHARS = 2000;
const MAX_TOTAL_TOKENS = 12_000;

export function truncateSessionSummaryForCompact(content: string): string {
  const sections = content.split(/(?=^## )/m);
  const truncated = sections.map(truncateSection);
  let out = truncated.join('');
  // Soft total cap (4 chars/token heuristic, matching estimateRequestTokens).
  const maxChars = MAX_TOTAL_TOKENS * 4;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars).replace(/\n[^\n]*$/, '\n…');
  }
  return out;
}

function truncateSection(section: string): string {
  if (section.length <= MAX_SECTION_CHARS) return section;
  const cut = section.lastIndexOf('\n', MAX_SECTION_CHARS);
  return section.slice(0, cut > 0 ? cut : MAX_SECTION_CHARS) + '\n…\n';
}
```

Skip injection entirely when `isSessionSummaryEmpty(cachedContent)` returns true.

## 11. Telemetry

Mirror claudy event names with `browserx_` prefix. Emit through the same channel TaskRunner uses for `BackgroundEvent` (`src/core/TaskRunner.ts:520–528`, `emitBackgroundEvent`) — i.e. push a typed event onto the engine event queue, with `data.kind = 'telemetry'` and `data.event` / `data.payload`. UI ignores; observability layer (TBD outside this PR) consumes.

| Event | Payload | When |
| --- | --- | --- |
| `browserx_session_summary_init` | `{ sessionId, config, memoryRoot }` | Hook attached, scaffold ensured. |
| `browserx_session_summary_file_read` | `{ sessionId, content_length }` | After extractor completion + cache prime. |
| `browserx_session_summary_extraction` | `{ sessionId, success, input_tokens, output_tokens, cache_read_tokens, duration_ms, config }` | Every extraction attempt. |
| `browserx_session_summary_manual_extraction` | `{ sessionId, trigger: 'manual' }` | `manuallyExtractSessionSummary()` called. |
| `browserx_session_summary_loaded` | `{ sessionId, content_length, token_count }` | Each `renderForPrompt()` that returns non-empty. |
| `browserx_compact_skipped_empty_summary` | `{ sessionId }` | Compaction ran without summary hint because file was empty/missing. |
| `browserx_compact_with_summary` | `{ sessionId, tokens_before, tokens_after, summary_token_count }` | Compaction folded the summary in. |
| `browserx_compact_extraction_wait_timeout` | `{ sessionId, waited_ms }` | Interlock hit the 15 s deadline. |

A small `src/core/sessionSummary/telemetry.ts` wraps emission so call sites stay readable.

## 12. Manual extraction parity

```ts
// src/core/sessionSummary/SessionSummaryHook.ts (excerpt)
async manuallyExtractSessionSummary(): Promise<void> {
  if (isExtractionInFlight(this.sessionId)) return;
  markExtractionStarted(this.sessionId);
  try {
    await this.runner.run(buildExtractorParams(this.parentEngine, this.buildPrompt()));
    telemetry.manualExtraction({ sessionId: this.sessionId });
  } finally {
    markExtractionCompleted(this.sessionId);
  }
}
```

Exposed on `Session` as `session.manuallyExtractSessionSummary()`. A future `/summary` slash command (out of scope) wires up to it.

## 13. Files to add / modify

| File | Action | Purpose |
| --- | --- | --- |
| `src/core/sessionSummary/sessionSummaryUtils.ts` | NEW | Trigger predicate, config constants, timeout/poll constants. |
| `src/core/sessionSummary/extractionLifecycle.ts` | NEW | Per-session flag map, `markStarted`/`markCompleted`/`waitForExtraction`. |
| `src/core/sessionSummary/SessionSummaryFileStore.ts` | NEW | `getSessionSummaryPath`, `SessionSummaryFileStore`, `isSessionSummaryEmpty`. |
| `src/core/sessionSummary/template.ts` | NEW | Canonical `SESSION_SUMMARY_TEMPLATE` string. |
| `src/core/sessionSummary/prompts.ts` | NEW | `SESSION_SUMMARY_EXTRACTION_PROMPT` (system prompt for extractor). |
| `src/core/sessionSummary/extractorType.ts` | NEW | `SESSION_SUMMARY_EXTRACTOR_TYPE` `SubAgentTypeConfig`. |
| `src/core/sessionSummary/cacheSafeParams.ts` | NEW | `buildExtractorParams(parentEngine, prompt)`. |
| `src/core/sessionSummary/summaryFileTools.ts` | NEW | `createSummaryFileCanUseTool(summaryPath)`. |
| `src/core/sessionSummary/truncate.ts` | NEW | `truncateSessionSummaryForCompact()`. |
| `src/core/sessionSummary/telemetry.ts` | NEW | Thin wrapper over engine event emit. |
| `src/core/sessionSummary/SessionSummaryHook.ts` | NEW | Owns lifecycle: registry, runner, post-turn hook, prompt-extension, cache, manual API. |
| `src/core/TurnManager.ts` | MODIFY | Add `postTurnHooks`, `registerPostTurnHook()`, hook fan-out in the `case 'Completed':` block at lines 253–261. |
| `src/tools/AgentTool/types.ts` | MODIFY | Add `quietBackground?: boolean` to `SubAgentToolParams`. |
| `src/tools/AgentTool/SubAgentRunner.ts` | MODIFY | Honour `quietBackground` at lines 123–143 (skip notification injection). |
| `src/core/Session.ts` | MODIFY | Construct `SessionSummaryHook`, attach on init, detach on shutdown; expose `manuallyExtractSessionSummary()`; thread `sessionId` into `compact()` call site. |
| `src/core/compact/CompactService.ts` | MODIFY | Add optional `sessionId` arg to `compact()`; call `waitForSessionSummaryExtraction()` at top; thread summary hint into `generateSummaryWithModel()`. |
| `src/core/compact/constants.ts` | MODIFY (optional) | If the hint is woven via the prompt-template string rather than at the message-build site, extend `SUMMARIZATION_PROMPT` / `compactSummarization` here. |
| `src/core/__tests__/sessionSummary/sessionSummaryUtils.test.ts` | NEW | Unit: predicate, config bounds. |
| `src/core/__tests__/sessionSummary/extractionLifecycle.test.ts` | NEW | Unit: flag lifecycle, `finally` clear invariant, wait function. |
| `src/core/__tests__/sessionSummary/summaryFileTools.test.ts` | NEW | Unit: `canUseTool` accept/deny, template emptiness, truncation. |
| `src/core/__tests__/sessionSummary/SessionSummaryFileStore.test.ts` | NEW | Unit: scaffold idempotency, path computation. |
| `src/core/__tests__/TurnManager.postTurnHook.test.ts` | NEW | Integration: hook fires on `Completed`, errors swallowed, ordering. |
| `src/core/__tests__/compact/extractionInterlock.test.ts` | NEW | Integration: compaction waits, proceeds after timeout, uses summary if present. |
| `src/tools/AgentTool/__tests__/SubAgentRunner.quietBackground.test.ts` | NEW | Integration: no `<task-notification>` enqueued when `quietBackground: true`. |
| `tests/e2e/sessionSummary.e2e.test.ts` | NEW | E2E: synthetic 50-turn session writes `summary.md` and next compaction folds it in. |

## 14. Test plan

### Unit

- `sessionSummaryUtils.test.ts`
  - predicate returns false below `minimumMessageTokensToInit`
  - returns true once token + tool-call thresholds pass
  - returns true with token threshold + no tool calls in last turn (natural pause)
  - reuses `estimateRequestTokens` (fixture parity vs `compact/utils.ts`)
- `extractionLifecycle.test.ts`
  - `markStarted` then `markCompleted` clears flag
  - throwing inside the wrapped fn still clears the flag (use try/finally fixture)
  - `waitForSessionSummaryExtraction` resolves immediately when no flight
  - resolves when flag clears mid-wait
  - resolves on 15 s deadline (fake timers)
  - force-clears + resolves on 60 s staleness
  - per-session isolation (two sessionIds independent)
- `summaryFileTools.test.ts`
  - `canUseTool` allows `file_edit` on exact path
  - denies different tool name (with `decisionReason`)
  - denies `file_edit` on different path
  - denies missing path
  - `truncateSessionSummaryForCompact` respects per-section cap at newline
  - skips injection when `isSessionSummaryEmpty()` true
- `SessionSummaryFileStore.test.ts`
  - `ensureScaffold` writes template once, idempotent on second call
  - `read` returns `''` when file missing

### Integration

- `TurnManager.postTurnHook.test.ts`
  - hook receives `{ sessionId, history, totalTokenUsage, lastTurnHadToolCalls }` from a faked stream that yields `OutputItemDone` + `Completed`
  - `lastTurnHadToolCalls` true when stream yields a tool call item
  - throwing hook does not break the turn (next hook still runs, `tryRunTurn` still returns)
  - unregister fn removes the hook
- `compact/extractionInterlock.test.ts`
  - `compact()` blocks until `markExtractionCompleted` is called (fake timers)
  - `compact()` proceeds after 15 s timeout (telemetry emitted)
  - `compact()` proceeds with `sessionSummaryHint` when `summary.md` non-empty
  - `compact()` skips hint when `isSessionSummaryEmpty()` true (telemetry emitted)
- `SubAgentRunner.quietBackground.test.ts`
  - background run with `quietBackground: true` does NOT call `enqueueSyntheticUserTurn`
  - background run without flag still injects `<task-notification>` (regression)
  - error path also respects flag

### E2E

- `sessionSummary.e2e.test.ts`
  - script a 50-turn synthetic session that crosses 15k tokens
  - assert `<memoryRoot>/sessions/<sid>/summary.md` exists, non-empty, differs from template
  - trigger compaction; assert post-compaction history references summary content; assert telemetry stream contains `browserx_compact_with_summary`

## 15. Risks

1. **Cost blowup from extra LLM calls.** Each extraction is one extractor turn (~1 model call) every ~8 k token growth. Long sessions can add up. **Mitigation:** feature gate (default off via a `SESSION_SUMMARY_ENABLED` env / config flag in `MemoryConfig`); start with conservative thresholds (15k/8k/5); telemetry payload includes `input_tokens`/`output_tokens` so we can tune from real data before defaulting on.

2. **Deadlock / hang if the flag is never cleared.** A crashing extractor could leave `extractionStartedAt[sid]` set forever, blocking every future compaction. **Mitigation:** the flag is *only* cleared inside a `finally{}` (enforced by an invariant unit test that asserts a throwing wrapped fn still clears it); `waitForSessionSummaryExtraction` has a 60 s staleness escape that force-clears; the hard 15 s deadline returns even without staleness.

3. **Cache misses if extractor params drift from parent.** Any difference in system prompt, tools list, model, or message prefix breaks the prompt cache and 3 – 5x's the extraction cost. **Mitigation:** `buildExtractorParams()` is the single helper used by both auto and manual paths, and it deliberately omits any field that would override `SubAgentRunner.prepare()`'s inheritance (model, tools, system prompt). A code-review checklist item: any new override added to `buildExtractorParams` requires a cache-hit-rate telemetry follow-up.

## 16. Out of scope (this PR)

- `/summary` slash-command UI (the API exists; the front-end wiring lands separately).
- Team memory sync (claudy `services/teamMemorySync/`).
- Cross-session aggregation (a "global" summary across many sessions).
- `chmod` on the FileSystem interface (0o600 enforcement is a follow-up).
- Anything that requires Track 04's concurrency-seam fix.
- Switching `MemoryConfig.enabled` default to `true`.

## 17. Implementation sequence

1. Merge `main` → `agent-improvements`; verify `PromptLoader.registerPromptExtension` and `MemoryFileSystem` are present.
2. Land `quietBackground` flag on `SubAgentToolParams` + `SubAgentRunner`; ship unit test in same patch.
3. Land `postTurnHooks` registry on `TurnManager` + integration test.
4. Add `src/core/sessionSummary/` scaffold (utils, lifecycle, file store, template, prompts, extractor type, canUseTool, truncate, telemetry); unit tests.
5. Wire `SessionSummaryHook` and attach/detach inside `Session`; expose `manuallyExtractSessionSummary()`.
6. Patch `CompactService.compact()` for the interlock + `sessionSummaryHint`; integration test.
7. Register `'session_summary'` prompt extension; verify next turn includes truncated summary.
8. Add E2E test; run full suite; tune thresholds based on telemetry.
9. Update docs (`README.md`, this design with any deltas surfaced during review).
10. Open PR, address review, merge.
