# Track 11 Tasks

> **Status (2026-05-14):** Single phase, single PR. ~50 LOC config plumbing.
> Most of the original `multiple_tools_call/` scope shipped with Track 02
> (PR #197). This track only makes that orchestrator reachable for
> non-Gemini providers.

See [`design.md`](./design.md) for rationale and the 2026-05-14 audit notes.

---

## Phase 0: Pre-implementation verification (DO FIRST — gates the estimate)

These answers can change the migration plan. Resolve before editing code.

- [ ] **Verify multi-tool wire format per provider.** Add temporary logging in `OpenAIResponsesClient.convertSDKEventToResponseEvent` (~line 701) and `OpenAIChatCompletionClient` accumulator (~line 588). Run a prompt that should yield parallel calls (e.g. "read the title of tab A and tab B"). Confirm the response arrives as ONE `message` item with `tool_calls[]`, not N separate `function_call` items.
  - If unified: migration plan in design.md is complete.
  - If N separate items for some provider: that provider also needs buffer-at-stream-end on the legacy `function_call` path (`TurnManager.ts:603`). Add ~40 LOC scoped to that provider; note it here.
- [ ] **Trace when `TurnManager.ts:603` (`item.type === 'function_call'`) actually fires today.** `grep` callers + add a one-line log. Determine if any multi-tool path routes through it.
- [ ] **Identify the existing config→client threading pattern.** Read `IModelConfig` / `ModelClientFactory` / a model client constructor. Document the pattern this track will reuse (don't invent a new one).
- [ ] **Gemini reference check.** Confirm Gemini multi-tool responses already flow through `TurnManager.ts:633` today (the orchestrator path). This is the working reference the other providers should match post-flip.

Record findings inline in this file before starting Phase 1.

---

## Phase 1: Config-driven `parallel_tool_calls`

**Goal:** Replace hardcoded `false` with a config value, allowlist-gated per provider, default `false`.
**Estimated size:** ~50 LOC (plus ~40 LOC if Phase 0 finds a non-unified provider).
**Single PR.**

### 1.1 Type change

- [ ] `src/core/models/types/ResponsesAPI.ts:20` — change `parallel_tool_calls: false` → `parallel_tool_calls: boolean`.
- [ ] Grep for consumers depending on the `false` literal type: `grep -rn "parallel_tool_calls" src/ --include="*.ts"`. Fix any that break (known: `src/extension/__tests__/BrowserAdaptations.test.ts:63,71`).

### 1.2 Config

- [ ] `src/config/types.ts` — add `parallelToolCalls?: boolean` to the tools config interface, with the JSDoc from design.md.
- [ ] `src/config/defaults.ts` (`DEFAULT_TOOLS_CONFIG`) — add `parallelToolCalls: false`.
- [ ] `src/core/models/ModelClientFactory.ts` — resolve effective value: `parallelToolCalls = globalFlag && PROVIDERS_SUPPORTING_PARALLEL.has(providerId)`. Define `PROVIDERS_SUPPORTING_PARALLEL = new Set(['openai', 'xai', 'groq', 'google'])` (google already works, included for completeness).
- [ ] `src/core/models/client/ModelClient.ts` (abstract base) — add `protected readonly parallelToolCalls: boolean` set from the resolved config in the constructor, so subclasses read one place.

### 1.3 Clients

- [ ] `src/core/models/client/OpenAIResponsesClient.ts:436` — `false` → `this.parallelToolCalls`.
- [ ] `src/core/models/client/OpenAIChatCompletionClient.ts:819` — `requestParams.parallel_tool_calls = this.parallelToolCalls;`
- [ ] `src/core/models/client/FireworksClient.ts:53` — `false` → `this.parallelToolCalls`.
- [ ] `src/core/models/client/GroqClient.ts:51` — `false` → `this.parallelToolCalls`.
- [ ] Verify `TogetherChatCompletionClient` + `FireworksChatCompletionClient` inherit the resolved value correctly (no direct edit; confirm via test).

### 1.4 Do NOT modify

- [ ] `src/core/TurnManager.ts:633-672` — orchestrator path already handles unified `message` + `tool_calls[]`. No edit. Prove via integration test in 1.6.
- [ ] `src/core/toolOrchestration.ts` — Track 02 code. No edit.
- [ ] `src/tools/runtimeMetadata.ts` — Track 02 code. No edit.

### 1.5 Conditional (only if Phase 0 found a non-unified provider)

- [ ] For the provider that streams N separate `function_call` items: buffer them in the `TurnManager` stream loop until `Completed`, then feed the buffered array through `partitionToolCalls` + `executeToolCallBatches` (reuse Track 02 — do not duplicate). ~40 LOC. Add a focused test.

### 1.6 Tests

- [ ] Update `src/extension/__tests__/BrowserAdaptations.test.ts:63,71` — assert configured value, not hardcoded `false`. Cover both default (`false`) and enabled (`true`) states.
- [ ] Add `src/core/models/__tests__/parallelToolCalls.config.test.ts`:
  - [ ] Default config → payload `parallel_tool_calls: false`.
  - [ ] `parallelToolCalls: true` + OpenAI → payload `true`.
  - [ ] `parallelToolCalls: true` + xAI → payload `true`.
  - [ ] `parallelToolCalls: true` + Groq → payload `true`.
  - [ ] `parallelToolCalls: true` + Fireworks (not in allowlist) → payload `false`.
  - [ ] `parallelToolCalls: true` + Together (inherits, not in allowlist) → payload `false`.
- [ ] Add `src/core/__tests__/TurnManager.parallelTools.integration.test.ts`:
  - [ ] Mock model stream emitting ONE `message` item with 3 `tool_calls` (2 safe reads + 1 unsafe write).
  - [ ] Assert orchestrator path (`TurnManager.ts:633`) is taken.
  - [ ] Assert safe calls ran concurrently, unsafe ran after, results in original order.
  - [ ] This is the proof the existing Track 02 orchestrator catches flipped-flag output with no TurnManager change.
- [ ] `npm run type-check && npm run lint && npm test` — all green; Track 02's `toolOrchestration.test.ts` must stay green.

### 1.7 Documentation

- [ ] Brief note in `src/config/README.md` (if present) on the new `parallelToolCalls` flag and its allowlist gating.
- [ ] One-line note where model clients are documented (if any) that the flag is config-driven and dark by default.

---

## Cross-cutting

- [ ] Update `.ai_design/agent_improvements/README.md`:
  - [ ] Add Track 11 row to the improvement-tracks table.
  - [ ] Add Track 11 to the dependency graph (depends on Track 02 DONE).
  - [ ] Remove the stale `multiple_tools_call/ - existing work` bullet (superseded by Track 11).

---

## Deferred (NOT in this track — see design.md)

| Item | Why |
|------|-----|
| Streaming tool execution (`StreamingToolExecutor`) | No early-arrival to exploit with buffering clients; ~500 LOC for marginal latency on short browser turns. Revisit criteria in design.md. |
| Batched approval UI | Functional correctness fine with N independent prompts; UX polish only. |
| `AbortController` mid-batch cancel | Pre-existing limitation, not worsened here. |
| Default `parallelToolCalls: true` | Follow-up PR after manual QA across OpenAI/xAI/Groq + Gemini reference. |
| Sidepanel UI toggle | Config/programmatic control sufficient for dark launch. |
