# Track 11: Parallel Tool Calls

> **Status (2026-05-14):** Implementation-ready, single phase. Active PR: none.
>
> Supersedes the 2026-04-07 `multiple_tools_call/` design, which was written
> before Track 02 shipped. Track 02 (PR #197, merged 2026-05-13) already built
> the hard part — the concurrency-metadata model and the partition/execute
> orchestrator. This track is what's actually left: **let the model emit
> multiple tool calls in one response**, so Track 02's orchestrator can
> actually run them in parallel.

---

## TL;DR

Track 02 built `partitionToolCalls` + `executeToolCallBatches` and wired them into `TurnManager.ts:633` for the case where a model returns a `message` item containing a `tool_calls` array. That path runs safe tools concurrently (bounded at 5) and unsafe tools sequentially — it already works.

But every OpenAI-compatible client sends `parallel_tool_calls: false`, which tells the model to emit exactly one tool call per response. So the orchestrator's parallel path is reached only for Gemini (which natively emits the unified format). For OpenAI, xAI, Groq, Fireworks, Together, Moonshot — the model is explicitly told not to batch, so it never does.

**This track flips that flag (configurably) and verifies the orchestrator catches the result.** That's the whole change. ~50 LOC of config plumbing, no new classes, no new orchestrator.

---

## Why the old design is mostly obsolete

The `multiple_tools_call/design.md` (2026-04-07, 751 lines) proposed building:

- `ToolConcurrencyMetadata` → **Track 02 shipped this** as `runtimeMetadata.ts`
- `ToolOrchestrator.partition()` → **Track 02 shipped this** as `toolOrchestration.partitionToolCalls()`
- `ToolOrchestrator.execute()` → **Track 02 shipped this** as `executeToolCallBatches()`
- Per-tool concurrency classification → **Track 02 shipped this** (all 13 tools in `registerExtensionTools.ts` have per-input concurrency profiles)
- `TurnManager` integration for `tool_calls[]` → **Track 02 shipped this** at `TurnManager.ts:633-672`
- `StreamingToolExecutor` (Layer 4) → **see "Streaming execution: not needed" below**

What the old design got wrong (because it predated provider research): it assumed multi-tool responses arrive as **N separate `function_call` items** that the sequential stream loop would serialize. The 2026-05-14 audit found that's false — OpenAI-compatible clients **accumulate tool-call deltas and emit ONE unified `message` item with a `tool_calls` array** at stream end. That's exactly the shape Track 02's orchestrator consumes.

So the sequential-stream-loop problem the old design spent Layers 4-5 solving doesn't exist for these providers. The orchestrator already gets the whole batch in one item.

---

## Problem (restated accurately)

`parallel_tool_calls: false` is hardcoded in:

| File | Line | Shape |
|---|---|---|
| `src/core/models/types/ResponsesAPI.ts` | 20 | Literal type `false` (type-level enforcement) |
| `src/core/models/client/OpenAIResponsesClient.ts` | 436 | Literal `false` in request payload |
| `src/core/models/client/OpenAIChatCompletionClient.ts` | 819 | `requestParams.parallel_tool_calls = false;` |
| `src/core/models/client/FireworksClient.ts` | 53 | Literal `false` in `buildRequestPayload()` override |
| `src/core/models/client/GroqClient.ts` | 51 | Literal `false` in `buildRequestPayload()` override |

`TogetherChatCompletionClient` and `FireworksChatCompletionClient` extend `OpenAIChatCompletionClient` and inherit line 819. `GoogleCompletionClient` doesn't set the flag at all (Gemini natively emits the unified format — already works via Track 02).

Effect: the model is told to serialize. Even when a user asks for 3 independent reads ("compare prices on these 3 tabs"), the model emits one tool call, waits a full round-trip, emits the next, and so on. N independent operations cost N model round-trips instead of 1.

The orchestrator that would parallelize them already exists and is already wired in. It's just never fed more than one call because the flag suppresses multi-call responses.

---

## Design

### The change

Replace the hardcoded `false` with a config-driven value, default safe-off per provider, opt-in via config.

```typescript
// ResponsesAPI.ts:20
parallel_tool_calls: boolean;   // was: false (literal)

// each client
parallel_tool_calls: this.parallelToolCalls,   // resolved from config
```

### Config surface

Add to the tools config block (`src/config/defaults.ts` `DEFAULT_TOOLS_CONFIG`, type in `src/config/types.ts`):

```typescript
interface IToolsConfig {
  // ...existing...
  /**
   * Allow the model to emit multiple tool calls in one response.
   * When true, Track 02's orchestrator runs concurrency-safe calls
   * in parallel (bounded) and unsafe calls sequentially.
   * Default: false (conservative — preserves current behavior).
   */
  parallelToolCalls?: boolean;
}
```

Default `false`. This is a behavior-changing capability; ship it dark, enable deliberately (manual QA, then default-on in a follow-up once validated against the main providers).

### Provider support matrix (from 2026-05-14 audit)

| Provider | API | Supports `parallel_tool_calls` | Action |
|---|---|---|---|
| OpenAI | Responses + Chat Completions | Yes (default true upstream) | config-driven |
| xAI | Responses + Chat Completions | Yes | config-driven |
| Google AI Studio | native SDK | Yes (already works via unified format) | no change — already parallel |
| Groq | Chat Completions | Yes | config-driven |
| Fireworks | Chat Completions | Unclear | keep `false` unless config explicitly overrides |
| Together | Chat Completions (inherits) | Unclear | keep `false` unless config explicitly overrides |
| Moonshot | Chat Completions (inherits) | Unclear | keep `false` unless config explicitly overrides |
| Anthropic | Messages API | N/A (separate content blocks; different client) | out of scope |

For "Unclear" providers: the resolved value defaults to `false` even when the global config flag is `true`, unless a per-provider override is set. Concretely: `parallelToolCalls = globalConfig && providerSupportsParallel`. Keep the provider-support set as a small allowlist (`openai`, `xai`, `groq`, `google`) in the client/factory.

### Config plumbing path

```
AgentConfig.tools.parallelToolCalls (default false)
   → ModelClientFactory resolves per-provider (allowlist gate)
   → passed into model client constructor / IModelConfig
   → client.buildRequestPayload() reads this.parallelToolCalls
   → emitted in request body
```

The exact threading mirrors how other tool-config values already reach clients (audit `IModelConfig` for the existing pattern; reuse it rather than inventing a new path).

### Why no orchestrator / StreamingToolExecutor work

- **Orchestrator:** already exists (`src/core/toolOrchestration.ts`), already wired (`TurnManager.ts:633-672`), already tested (`src/core/__tests__/toolOrchestration.test.ts`). When the model emits a unified `message` item with `tool_calls[]`, `partitionToolCalls` + `executeToolCallBatches` run it correctly — safe calls concurrent (bounded 5), unsafe sequential, results in original order. Verified in code.
- **StreamingToolExecutor (claudy):** claudy starts tools as each `tool_use` block arrives mid-stream, for latency (tools run during the model's 5-30s output phase). For BrowserX this is **not needed in v1** because:
  1. OpenAI-compatible clients buffer tool-call deltas and emit them as one item at stream end anyway — there is no "early arrival" to exploit.
  2. The latency win is meaningful for claudy's long terminal-coding turns; BrowserX browser-tool turns are typically short.
  3. It's ~500-600 LOC of state machine + abort-chain + progress plumbing vs. ~50 LOC for the flag flip.
  Deferred — see "Deferred" section. Not blocking the value this track delivers.

---

## Migration plan — concrete file edits

All line numbers against `agent-improvements` as of the branch this work starts from (re-verify before editing — other PRs move lines).

### Type change

1. **`src/core/models/types/ResponsesAPI.ts:20`** — `parallel_tool_calls: false` → `parallel_tool_calls: boolean`. Audit consumers depending on the `false` literal type (the 2026-05-14 probe flagged `src/extension/__tests__/BrowserAdaptations.test.ts:63,71` asserting `=== false` — update those assertions).

### Config

2. **`src/config/types.ts`** — add `parallelToolCalls?: boolean` to the tools config interface.
3. **`src/config/defaults.ts`** (`DEFAULT_TOOLS_CONFIG`) — add `parallelToolCalls: false`.
4. **`src/core/models/ModelClientFactory.ts`** — resolve effective value: `globalFlag && providerInAllowlist`. Pass into client construction.
5. **`src/core/models/client/ModelClient.ts`** (abstract base) — add a `protected readonly parallelToolCalls: boolean` field set from config, so subclasses read one place.

### Clients

6. **`src/core/models/client/OpenAIResponsesClient.ts:436`** — `false` → `this.parallelToolCalls`.
7. **`src/core/models/client/OpenAIChatCompletionClient.ts:819`** — `requestParams.parallel_tool_calls = this.parallelToolCalls;`
8. **`src/core/models/client/FireworksClient.ts:53`** — `false` → `this.parallelToolCalls` (resolves to `false` unless config + allowlist say otherwise).
9. **`src/core/models/client/GroqClient.ts:51`** — `false` → `this.parallelToolCalls`.
10. `TogetherChatCompletionClient` / `FireworksChatCompletionClient` — no direct edit; inherit from `OpenAIChatCompletionClient`. Verify the inherited value resolves correctly.

### No TurnManager change

`TurnManager.ts:633-672` already handles the unified `message` + `tool_calls[]` path via the orchestrator. **Do not modify it.** Confirm by test (below) that flipping the flag causes multi-tool responses to flow through this existing path.

---

## Tests

### Update

- `src/extension/__tests__/BrowserAdaptations.test.ts:63,71` — change `parallel_tool_calls === false` assertions to assert the configured value (default `false`, so existing assertion may still hold by default — verify and adjust to test both states).

### Add

- `src/core/models/__tests__/parallelToolCalls.config.test.ts`:
  - Default config → request payload has `parallel_tool_calls: false`.
  - `parallelToolCalls: true` + OpenAI provider → payload has `true`.
  - `parallelToolCalls: true` + Fireworks (not in allowlist) → payload still `false`.
  - `parallelToolCalls: true` + Groq (in allowlist) → payload `true`.
- `src/core/__tests__/TurnManager.parallelTools.integration.test.ts`:
  - Mock a model stream that emits ONE `message` item with 3 `tool_calls` (2 safe reads + 1 unsafe write).
  - Assert the orchestrator path (`TurnManager.ts:633`) is taken.
  - Assert safe calls ran concurrently, unsafe ran after, results preserved in original order.
  - This is the proof that the existing Track 02 orchestrator catches the flipped-flag output without TurnManager changes.

### Run

`npm run type-check && npm run lint && npm test`. Existing `toolOrchestration.test.ts` (Track 02) must stay green.

---

## Pre-implementation verification (do these first — they can change the plan)

The 2026-05-14 audit left open questions whose answers determine whether the plan above is complete:

1. **Confirm the unified-item wire format for each provider.** The audit inferred from `convertSDKEventToResponseEvent` (`OpenAIResponsesClient.ts:701-789`) and the Chat Completions accumulator (`OpenAIChatCompletionClient.ts:588-617`) that multi-tool responses arrive as ONE `message` item with `tool_calls[]`. **Verify with a real (or recorded) multi-tool response** — add temporary logging in `convertSDKEventToResponseEvent` and run a prompt that should produce parallel calls. If any provider instead emits N separate `function_call` items, that provider additionally needs the legacy path (`TurnManager.ts:603`) to buffer-and-batch — scope grows by ~40 LOC for that provider only.

2. **When does the legacy `function_call` path (`TurnManager.ts:603`) actually fire today?** Grep + trace. If it's only single-tool legacy responses, flipping the flag never routes through it and it needs no change. If some provider routes multi-tool through it, see #1.

3. **Config threading pattern.** Confirm how existing tool-config values reach model clients (`IModelConfig`? constructor arg? factory?). Reuse that path; don't invent a parallel one.

4. **Gemini already-parallel sanity check.** `GoogleCompletionClient` doesn't set the flag. Confirm Gemini multi-tool responses already flow through `TurnManager.ts:633` today (they should — that path's comment explicitly says "Gemini 3 may send parallel tool calls"). If so, Gemini is the working reference implementation and needs zero changes — use it to validate the others behave the same once the flag flips.

If #1 confirms unified-item for all OpenAI-compatible providers, the migration plan above is complete and the estimate holds.

---

## Risks

- **Model emits dependent tools in parallel.** Low. Models are trained to serialize dependent calls; claudy relies on this at scale. The orchestrator's concurrency profiles are the backstop — a write tool is never classified safe, so it can't run concurrently with anything.
- **A provider streams N separate `function_call` items instead of a unified message.** Medium. This is exactly what pre-implementation verification #1 exists to catch. If found, that provider needs a small buffer-at-stream-end addition to the legacy path. Scoped, not architectural.
- **"Unclear" providers (Fireworks/Together/Moonshot) silently break on `parallel_tool_calls`.** Low — the allowlist gate keeps them at `false` by default even when the global flag is on.
- **Behavior change surprises existing users.** Low — defaults to `false`. Opt-in. Default-on is a separate, later decision once the main providers are validated.
- **Approval UX with parallel tools.** Medium. When N tools run concurrently, each independently fires PreToolUse/PostToolUse hooks and approval (`TurnManager` ~732-795) — N approval prompts, not one batched prompt. Acceptable for v1 (functionally correct, just not pretty). Batched-approval UI is explicitly deferred (matches old design's Phase 3).
- **Cancellation mid-batch.** Medium. `TurnManager` cancel is a flag check, not an `AbortController`; in-flight batch workers finish before the cancelled flag is observed. Pre-existing behavior (Track 02 didn't change it); not made worse here. Out of scope to fix.

---

## Deferred (not in this track)

| Item | Why deferred |
|---|---|
| **Streaming tool execution** (claudy's `StreamingToolExecutor`) | OpenAI-compatible clients buffer tool deltas and emit one item at stream end — there's no early-arrival to exploit. ~500-600 LOC for a latency win that's marginal for short browser-tool turns. Revisit only if (a) a provider streams tool blocks incrementally AND (b) turn latency profiling shows the model-output-phase wait is a real cost. |
| **Batched approval UI** | Functional correctness doesn't require it (N independent prompts work). UX polish; matches old design's Phase 3. Separate track if prioritized. |
| **`AbortController` plumbing for mid-batch cancel** | Pre-existing limitation, not introduced here. Cross-cutting change to `TurnManager`/`Session` cancel path. Its own track if it becomes a real problem. |
| **Default `parallelToolCalls: true`** | Ship dark first. Flip the default in a follow-up PR after manual QA across OpenAI/xAI/Groq + the Gemini reference. |
| **Per-provider config UI** (sidepanel toggle) | Config-file / programmatic control is enough for v1 and dark-launch. UI exposure later if users need it. |

---

## Relationship to other tracks

- **Track 02 (DONE, PR #197):** built and shipped everything this track depends on — `runtimeMetadata.ts`, `toolOrchestration.ts`, `TurnManager.ts:633` integration, per-tool concurrency profiles, orchestrator tests. This track is the small remaining plumbing that makes Track 02's parallel path reachable for non-Gemini providers.
- **Track 08 (DONE, PR #219):** unrelated (engine submission queue). No interaction.

---

## Validation Notes (2026-05-14)

Two parallel deep-audit probes (claudy streaming-tool pipeline; BrowserX model-client + TurnManager) informed this design.

### Claudy findings

- `StreamingToolExecutor` (`/home/rich/dev/study/claudy/src/services/tools/StreamingToolExecutor.ts`) is a ~500-line state machine: tools tracked `queued → executing → completed → yielded`, concurrency gate `canExecuteTool`, order-preserving `getCompletedResults`, async drain `getRemainingResults`, Bash-error sibling cascade via `siblingAbortController`, `discard()` for streaming fallback.
- It's an **optimization, not a separate path** — results are still gathered in the same order-preserving way as the batch-at-end fallback (`toolOrchestration.partitionToolCalls`, single-pass reduce, mirrors BrowserX Track 02 exactly).
- Streaming is **feature-gated** (`tengu_streaming_tool_execution2`); fallback is batch-at-end via `runTools()`. Claudy keeps both.
- Claudy doesn't set `parallel_tool_calls` on the request — Anthropic Messages API emits parallel content blocks natively (analogous to Gemini for BrowserX).

### BrowserX findings

- Flag hardcoded `false` at the 5 sites tabulated above. `ResponsesAPI.ts:20` is a literal type.
- **Multi-tool responses arrive as ONE unified `message` item with `tool_calls[]`** — `OpenAIChatCompletionClient.ts:588-617` accumulates deltas then emits one item; `OpenAIResponsesClient.ts:701-789` returns one unified item. This is the key finding: the orchestrator already consumes this shape.
- `TurnManager.ts:633-672` is the only consumer of `partitionToolCalls`/`executeToolCallBatches`; it handles the unified path; runs safe concurrent (cap 5), unsafe sequential, original order preserved.
- 13 tools registered with per-input concurrency profiles (`registerExtensionTools.ts`); `web_search` special-cased safe in `toolOrchestration.ts:49`.
- `GoogleCompletionClient` doesn't set the flag — Gemini already flows through the working parallel path. It's the de-facto reference implementation.
- No `AbortController` in the turn cancel path; cancel is a flag check (pre-existing; out of scope).

### Decisions resolved

1. **Don't rebuild the orchestrator.** Track 02 shipped it. This track is plumbing only.
2. **Don't build StreamingToolExecutor in v1.** No early-arrival to exploit with buffering clients; cost/benefit doesn't justify it. Deferred with explicit revisit criteria.
3. **Config-driven flag, default `false`, allowlist-gated per provider.** Dark launch; deliberate enablement.
4. **No `TurnManager` change.** The existing Track 02 path catches the flipped-flag output. Prove via integration test, don't modify.
5. **Pre-implementation verification gates the estimate.** If any provider streams N separate `function_call` items, that provider needs a small buffer-at-end addition — scoped, ~40 LOC, one provider.

### Sources

- Claudy: `services/tools/StreamingToolExecutor.ts` (~520 LOC), `services/tools/toolOrchestration.ts:86-116`, `query.ts:561-1023` (stream loop + executor feed), `Tool.ts:402` (`isConcurrencySafe`).
- BrowserX: `src/core/models/types/ResponsesAPI.ts:20`, `src/core/models/client/OpenAIResponsesClient.ts:436,701-789`, `OpenAIChatCompletionClient.ts:819,588-617`, `FireworksClient.ts:53`, `GroqClient.ts:51`, `src/core/TurnManager.ts:230-330,601-720`, `src/core/toolOrchestration.ts`, `src/tools/runtimeMetadata.ts`, `src/extension/tools/registerExtensionTools.ts`, `src/config/defaults.ts`, `src/core/__tests__/toolOrchestration.test.ts`, `src/extension/__tests__/BrowserAdaptations.test.ts:63,71`.
