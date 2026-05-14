# Track 05b: Auto-Extraction & Compaction Interlock — Tasks

> Mirrors `design.md` section order. Each task names the file it touches.
> Goal: ship as one PR onto `agent-improvements` after the `main` merge lands.

## 1. Prerequisites

- [ ] Merge `main` into `agent-improvements` (45 commits behind, including PR #167 memory layer). Resolve any conflicts in `src/core/PromptLoader.ts`, `src/core/Session.ts`, `src/core/TurnManager.ts`, `src/core/registry/ToolRegistry.ts`.
- [ ] Verify `PromptLoader.registerPromptExtension` / `unregisterPromptExtension` / `appendExtensions()` are present in `src/core/PromptLoader.ts`.
- [ ] Verify `createMemoryFileSystem()` is exported from `src/core/memory/MemoryFileSystem.ts` and returns `{ fs, memoryDir }`.
- [ ] Verify `FileSystem` interface is exported from `src/core/memory/types.ts`.
- [ ] Confirm `npm test` and `npm run lint` are green on the freshly merged branch before any 05b code lands.

## 2. Module scaffolding

- [ ] Create directory `src/core/sessionSummary/`.
- [ ] Add `src/core/sessionSummary/template.ts` exporting `SESSION_SUMMARY_TEMPLATE` (literal markdown from §9 of design).
- [ ] Add `src/core/sessionSummary/prompts.ts` exporting `SESSION_SUMMARY_EXTRACTION_PROMPT` (port claudy's `services/SessionMemory/prompts.ts`, adapt the IT-coding voice to browser automation).
- [ ] Add `src/core/sessionSummary/sessionSummaryUtils.ts` with `DEFAULT_SESSION_SUMMARY_CONFIG`, `EXTRACTION_WAIT_TIMEOUT_MS`, `EXTRACTION_STALE_THRESHOLD_MS`, `EXTRACTION_POLL_INTERVAL_MS`, `shouldExtractSessionSummary()`, `countToolCalls()`. Reuse `estimateRequestTokens()` from `src/core/compact/utils.ts:139`.
- [ ] Add `src/core/sessionSummary/SessionSummaryFileStore.ts` with `getSessionSummaryPath()`, `SessionSummaryFileStore` class (`ensureScaffold`, `read`, `pathFor`), and `isSessionSummaryEmpty()`.
- [ ] Add `src/core/sessionSummary/extractorType.ts` exporting `SESSION_SUMMARY_EXTRACTOR_TYPE: SubAgentTypeConfig` (`tools.allow = ['file_edit']`, `approvalPolicy: 'never'`, `maxTurns: 4`, suppressed events).
- [ ] Add `src/core/sessionSummary/cacheSafeParams.ts` with `buildExtractorParams(parentEngine, prompt)` — must not override `model`/`tools`/`systemPrompt`.
- [ ] Add `src/core/sessionSummary/summaryFileTools.ts` with `createSummaryFileCanUseTool(summaryPath)` returning `(toolName, input) => CanUseToolDecision`.
- [ ] Add `src/core/sessionSummary/truncate.ts` with `MAX_SECTION_CHARS = 2000`, `MAX_TOTAL_TOKENS = 12_000`, `truncateSessionSummaryForCompact()`, `truncateSection()`.
- [ ] Add `src/core/sessionSummary/telemetry.ts` thin wrapper that pushes typed engine events for the 8 telemetry names listed in design §11.
- [ ] Add `src/core/sessionSummary/extractionLifecycle.ts` with module-scoped `extractionStartedAt: Map<string, number>`, `isExtractionInFlight`, `markExtractionStarted`, `markExtractionCompleted`, `getExtractionAgeMs`, `waitForSessionSummaryExtraction(sessionId)`.

## 3. Trigger surface — post-turn hook in TurnManager

- [ ] In `src/core/TurnManager.ts`: add `PostTurnContext` and `PostTurnHook` exported types; add `postTurnHooks: PostTurnHook[]` private field; add `registerPostTurnHook(fn): () => void` returning the unregister fn.
- [ ] In `src/core/TurnManager.ts:237–244` (`case 'Completed'`): before `return`, compute `lastTurnHadToolCalls` from `processedItems` and run hooks sequentially inside try/catch (errors swallowed + `console.warn`).
- [ ] If `TurnContext` does not currently expose a `getHistorySnapshot()`/`getSessionId()` accessor, add the minimum needed (read-only).

## 4. Extraction sub-agent — quiet background

- [ ] In `src/tools/AgentTool/types.ts`: add `quietBackground?: boolean` to `SubAgentToolParams` (with the documented "internal extractors only" comment).
- [ ] In `src/tools/AgentTool/SubAgentRunner.ts:121–143`: gate both notification calls (success and error branches) behind `!params.quietBackground`.
- [ ] Document in the JSDoc comment of `SubAgentRunner.run()` that `quietBackground` is the silent-extractor escape hatch.

## 5. Flag lifecycle + wait function

- [ ] Implement `extractionLifecycle.ts` (per §7); ensure `markExtractionCompleted` is idempotent on already-cleared sessions.
- [ ] Implement `waitForSessionSummaryExtraction()` per §8 using the constants from §6. Use `setTimeout` polling — do not busy-loop.

## 6. Compaction interlock

- [ ] In `src/core/compact/CompactService.ts:71–84`: add optional `sessionId?: string` to `compact(...)`. At the very top of `compact()`, when `sessionId` is provided, `await waitForSessionSummaryExtraction(sessionId)` and emit `browserx_compact_extraction_wait_timeout` telemetry if the wait hit the deadline.
- [ ] After the wait, when `sessionId` is set, read `summary.md` via the shared `SessionSummaryFileStore`. If `isSessionSummaryEmpty()` true → emit `browserx_compact_skipped_empty_summary` and pass `undefined` hint. Otherwise pass truncated summary as `sessionSummaryHint` into `generateSummaryWithModel(...)`.
- [ ] In `src/core/compact/SummaryGenerator.ts:12–99`: accept optional `sessionSummaryHint?: string` and weave into the `SUMMARIZATION_PROMPT` template (`src/core/compact/constants.ts`). Do not rewrite the generator.
- [ ] In `src/core/Session.ts` wherever `CompactService.compact()` is called: thread `this.sessionId` through. If a `Session.compact(...)` wrapper exists, propagate from there.
- [ ] Verify no other call site of `CompactService.compact()` regresses (search & match new optional arg).

## 7. Owner — `SessionSummaryHook`

- [ ] Implement `src/core/sessionSummary/SessionSummaryHook.ts`:
  - Constructor: `{ sessionId, parentEngine, fs, memoryRoot, config, telemetry }`.
  - Owns its own `SubAgentRegistry({ maxConcurrent: 1 })` and `SubAgentRunner` configured with `customTypes: [SESSION_SUMMARY_EXTRACTOR_TYPE]`.
  - `attach(turnManager)`: ensure scaffold, register post-turn hook, register `'session_summary'` prompt extension via `registerPromptExtension`, subscribe to `internalRegistry`'s `SubAgentComplete` events to refresh the in-memory cache.
  - `detach()`: unregister both, dispose internal runner.
  - `handlePostTurn(ctx)`: read `ExtractionState` from instance fields, call `shouldExtractSessionSummary()`, guard with `isExtractionInFlight()`, `markExtractionStarted` → spawn → `markExtractionCompleted` in `finally`.
  - `manuallyExtractSessionSummary()` per §12.
  - `renderForPrompt()` (sync) returns `truncateSessionSummaryForCompact(this.cachedSummary)` or `''`.
- [ ] In `src/core/Session.ts`: construct `SessionSummaryHook` once during init, `attach(turnManager)`. On `Session.shutdown()` / `dispose()`, call `detach()`. Expose `session.manuallyExtractSessionSummary()` public method.

## 8. Telemetry events

- [ ] Implement the 8 telemetry helpers in `src/core/sessionSummary/telemetry.ts` (see §11 table). Emit via `parentEngine.pushEvent({ msg: { type: 'BackgroundEvent', data: { kind: 'telemetry', event, payload } } })` so the UI ignores but observability can subscribe later.
- [ ] Wire each emission site:
  - `init` — `SessionSummaryHook.attach()` after scaffold.
  - `file_read` — after `cachedSummary` refresh.
  - `extraction` — extractor completion (success and failure branches).
  - `manual_extraction` — `manuallyExtractSessionSummary()`.
  - `loaded` — inside `renderForPrompt()` when returning non-empty.
  - `compact_skipped_empty_summary` — `CompactService.compact()` empty branch.
  - `compact_with_summary` — `CompactService.compact()` non-empty branch (after compaction completes, with `tokensBefore`/`tokensAfter`).
  - `compact_extraction_wait_timeout` — `CompactService.compact()` interlock branch.

## 9. Tests

### Unit

- [ ] `src/core/__tests__/sessionSummary/sessionSummaryUtils.test.ts` — predicate cases (init gate, growth+tools, growth+natural-pause, neither).
- [ ] `src/core/__tests__/sessionSummary/extractionLifecycle.test.ts` — flag lifecycle, finally invariant, wait resolves immediately/mid-wait/on-deadline/on-staleness, per-session isolation.
- [ ] `src/core/__tests__/sessionSummary/summaryFileTools.test.ts` — `canUseTool` allow/deny matrix, truncation respects newline boundary, `isSessionSummaryEmpty` true on template / false on edited content.
- [ ] `src/core/__tests__/sessionSummary/SessionSummaryFileStore.test.ts` — scaffold idempotency, path computation, `read` returns `''` when missing.

### Integration

- [ ] `src/core/__tests__/TurnManager.postTurnHook.test.ts` — hook fires on `'Completed'`, `lastTurnHadToolCalls` correct, throwing hook does not break turn, unregister works.
- [ ] `src/core/__tests__/compact/extractionInterlock.test.ts` — `compact()` blocks until `markCompleted`; proceeds after 15 s timeout (telemetry); folds non-empty summary into prompt; skips empty summary (telemetry).
- [ ] `src/tools/AgentTool/__tests__/SubAgentRunner.quietBackground.test.ts` — no `<task-notification>` enqueued with `quietBackground: true`; still enqueued without flag (regression); error path also respects flag.

### E2E

- [ ] `tests/e2e/sessionSummary.e2e.test.ts` — synthetic 50-turn session crosses 15 k tokens; assert `summary.md` exists, differs from template; trigger compaction; assert post-compaction history references summary content; assert telemetry stream contains `browserx_compact_with_summary`.

## 10. Documentation

- [ ] Add a row to `.ai_design/agent_improvements/README.md` track table for 05b (slot under 05).
- [ ] Add a one-line dependency-graph entry for 05b under the existing 05 entry.
- [ ] Verify `design.md` and `tasks.md` checkboxes match what the PR actually changed; update if scope drifted.
- [ ] On merge, leave `05b_auto_extraction_compaction_interlock/` directory in place (do NOT rename to `_DONE` until subsequent enablement-by-default ships).
