# Research: Seamless Model Switch

**Date**: 2026-02-17
**Feature**: 024-seamless-model-switch

## Decision 1: History Preservation Strategy

**Decision**: Remove `session.clearHistory()` from
`BrowserxAgent.handleModelConfigChange()` and stop creating a new
TurnContext. Instead, create a new ModelClient and update the
existing TurnContext via `turnContext.update()`.

**Rationale**: The current `handleModelConfigChange()` method
(BrowserxAgent.ts:278-312) calls `session.shutdown()`,
`session.clearHistory()`, creates a brand-new TurnContext, and
reinitializes the session. This destroys all conversation state.
However, `TurnContext.update()` (TurnContext.ts:86-122) already
supports updating the model client in-place via
`this.modelClient.setModel(config.model)`. The SessionState,
RolloutRecorder, and conversation history can all survive a model
change without any structural modification.

**Alternatives considered**:
- Fork session with `initialHistory: { mode: 'forked' }` — adds
  unnecessary complexity since we can just keep the existing session.
- Create new Session with history copied — risks losing rollout
  continuity and active turn state.

## Decision 2: Mid-Task Protection Approach

**Decision**: Defer the model switch to the next user submission
rather than applying it immediately. Store the pending model
selection in BrowserxAgent and apply it when the next user message
is processed.

**Rationale**: Tasks use the TurnContext's ModelClient, which is
session-wide (Session.ts:53, TurnContext.ts:50-81). If we update
TurnContext immediately, a running TaskRunner would pick up the new
model on its next turn iteration. By deferring until the next
submission, we guarantee the running task completes with its
original model. The `isActiveTurn()` method (Session.ts:775-777)
and `getRunningTasks()` (Session.ts:1751-1757) provide the check
for whether a task is currently running.

**Alternatives considered**:
- Clone TurnContext per-task — would require deep cloning
  ModelClient and all its state, significantly more complex.
- AbortController-based approach — too aggressive, would kill the
  running task rather than letting it complete.

## Decision 3: Model Metadata on ResponseItems

**Decision**: Add optional `modelKey` field to the ResponseItem
union type for `message` type items with `role: 'assistant'`. Set
this field when recording assistant responses. Use it for UI
display (US3) and for rollout persistence (FR-011).

**Rationale**: ResponseItem (protocol/types.ts:196-261) currently
has no model tracking. The RolloutRecorder does track model via
`TurnContextItem` (rollout/types.ts:112-125), but this is per-turn
context, not per-item. For multi-model conversations, we need
per-item model identity. An optional field on the existing union
type is backward-compatible and doesn't break existing
serialization.

**Alternatives considered**:
- Wrapper type around ResponseItem — adds indirection, breaks
  existing type signatures everywhere.
- Separate metadata store alongside history — splits data that
  should be co-located, complicates export/import.

## Decision 4: ModelClient Replacement vs Update

**Decision**: Replace the ModelClient entirely on the TurnContext
rather than calling `setModel()`. Different providers require
different ModelClient implementations (OpenAIResponsesClient vs
GoogleCompletionClient), so `setModel()` only works for
same-provider switches.

**Rationale**: `TurnContext.update({model})` calls
`this.modelClient.setModel(model)` which only changes the model
name on the existing client instance. When switching providers
(e.g., OpenAI → Google), we need a completely different
ModelClient class. The `ModelClientFactory.createClientForCurrentModel()`
(ModelClientFactory.ts:52-108) already handles creating the correct
client type based on the provider. We need a new method on
TurnContext to replace the ModelClient instance directly.

**Alternatives considered**:
- Use `setModel()` for all cases — fails for cross-provider
  switches since the client class is wrong.
- Always create a new TurnContext — loses accumulated state
  (instructions, policies, etc.) unnecessarily.

## Decision 5: Settings UI Changes

**Decision**: Remove the confirmation dialog from model switch in
ModelSettings.svelte. The `saveModel()` function currently shows no
confirmation dialog (the earlier research mentioned one, but the
actual code at ModelSettings.svelte just calls
`settingsConfig.setSelectedModel()` directly). The success message
should be updated to reflect that conversation is preserved.

**Rationale**: With history preservation, there is nothing to warn
about. The UI should reflect the model change immediately via the
existing `notifyConfigUpdate()` mechanism.

**Alternatives considered**: None — straightforward removal.

## Key Files Requiring Changes

| File | Change Type | Scope |
|------|-------------|-------|
| `src/core/BrowserxAgent.ts` | Major rewrite of `handleModelConfigChange()` | US1, US2 |
| `src/core/TurnContext.ts` | Add `setModelClient()` method | US1 |
| `src/core/protocol/types.ts` | Add `modelKey?` to ResponseItem message type | US3, FR-006 |
| `src/core/Session.ts` | Remove `clearHistory()` call path, add model annotation | US1 |
| `src/core/TurnManager.ts` | Annotate assistant responses with model key | FR-006 |
| `src/extension/sidepanel/settings/ModelSettings.svelte` | Remove confirmation, update success message | FR-003 |
| `src/extension/sidepanel/pages/chat/Main.svelte` | Add model indicator to assistant messages | US3 |
| `src/storage/rollout/types.ts` | Ensure `modelKey` persisted in response_item | FR-011 |
