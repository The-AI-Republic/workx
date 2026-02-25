# Data Model: Seamless Model Switch

**Date**: 2026-02-17
**Feature**: 024-seamless-model-switch

## Entity Changes

### ResponseItem (modified)

The `message` variant of the ResponseItem union type gains an
optional `modelKey` field. This field is set on assistant-role
messages to track which model generated the response.

**New field**:
- `modelKey?: string` — Composite key in format
  `"providerId:modelIdentifier"` (e.g., `"openai:gpt-5.1"`,
  `"google:gemini-3"`). Only set on items with `role: 'assistant'`.
  Optional for backward compatibility with existing stored history.

**Unchanged fields**: All existing fields on all ResponseItem
variants remain unchanged. The `modelKey` field is additive only.

### PendingModelSwitch (new concept, not persisted)

An in-memory state held by BrowserxAgent when a model switch is
requested while a task is running. Not a stored entity — exists
only as a field on BrowserxAgent.

**Fields**:
- `pendingModelKey: string | null` — The composite model key the
  user selected. Null when no switch is pending.

**Lifecycle**:
1. User switches model → `pendingModelKey` set to new key
2. If no task running → apply immediately, clear pending
3. If task running → hold until task completes
4. On next user submission → apply pending, clear pending
5. Rapid switches (A→B→C) → last write wins, only C is stored

### TurnContext (modified)

Gains a method to replace the ModelClient instance (not just the
model name). Required for cross-provider switching.

**New method**:
- `setModelClient(client: ModelClient): void` — Replaces the
  internal ModelClient instance. Used when switching between
  providers that require different client implementations.

### RolloutItem (unchanged)

The existing `response_item` rollout item type already stores
`ResponseItem` as its payload. Since `modelKey` is added to
ResponseItem, it will automatically be persisted in rollouts
without any rollout type changes.

The existing `turn_context` rollout item already has a `model`
field in `TurnContextItem`. This continues to function as before.

## State Transitions

### Model Switch (no task running)

```
User selects model B in UI
  → AgentConfig.setSelectedModel("provider:modelB")
  → config-changed event emitted
  → BrowserxAgent.handleModelConfigChange()
  → Check: session.getRunningTasks().size === 0
  → Create new ModelClient via factory
  → turnContext.setModelClient(newClient)
  → Done (history preserved, no session reset)
```

### Model Switch (task running — deferred)

```
User selects model B while task running on model A
  → AgentConfig.setSelectedModel("provider:modelB")
  → config-changed event emitted
  → BrowserxAgent.handleModelConfigChange()
  → Check: session.getRunningTasks().size > 0
  → Store pendingModelKey = "provider:modelB"
  → Current task continues on model A
  → Task completes
  → User sends next message
  → BrowserxAgent applies pendingModelKey
  → Create new ModelClient, update TurnContext
  → Clear pendingModelKey
  → Process message with model B
```

## Validation Rules

- `modelKey` on ResponseItem MUST match the format
  `"providerId:modelIdentifier"` when set.
- `pendingModelKey` MUST be validated against AgentConfig's model
  registry before being stored (model must exist, provider must
  have API key).
- When resuming a session from rollout, missing `modelKey` on
  historical items is acceptable (backward compatibility).
