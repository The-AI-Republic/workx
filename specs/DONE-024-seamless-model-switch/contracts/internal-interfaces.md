# Internal Interface Contracts: Seamless Model Switch

**Date**: 2026-02-17
**Feature**: 024-seamless-model-switch

This feature has no external API endpoints. All changes are internal
to the Chrome extension. These contracts define the internal
TypeScript interface changes.

## Contract 1: ResponseItem Extension

**File**: `src/core/protocol/types.ts`

```typescript
// Modified: message variant of ResponseItem union
{
  type: 'message';
  id?: string;
  role: string;
  content: ContentItem[];
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
    thoughtSignature?: string;
  }>;
  modelKey?: string;  // NEW: "providerId:modelId" for assistant msgs
}
```

**Backward compatibility**: Field is optional. Existing stored
items without `modelKey` are valid. UI treats missing `modelKey`
as "unknown model".

## Contract 2: TurnContext.setModelClient()

**File**: `src/core/TurnContext.ts`

```typescript
// NEW method
setModelClient(client: ModelClient): void
```

**Preconditions**: `client` must be a valid, initialized
ModelClient instance.

**Postconditions**: Internal `modelClient` reference is replaced.
Subsequent calls to `getModelClient()` and `getModel()` return
values from the new client.

**Side effects**: None. Does not affect running tasks that already
hold a reference to the previous ModelClient.

## Contract 3: BrowserxAgent Model Switch Event

**File**: `src/core/BrowserxAgent.ts`

The `handleModelConfigChange()` method contract changes:

**Old behavior**:
- Calls `session.shutdown()`
- Calls `session.clearHistory()`
- Creates new TurnContext
- Reinitializes session

**New behavior**:
- If no task running: create new ModelClient, call
  `turnContext.setModelClient(newClient)`, done
- If task running: store `pendingModelKey`, apply on next
  user submission

**Event**: `config-changed` with `section: 'model'` (unchanged)

## Contract 4: Chrome Runtime Message (unchanged)

The `CONFIG_UPDATE` message from Settings UI to service worker
remains unchanged. No new message types are introduced.

```typescript
// Existing message — no changes
chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' });
```
