# Quickstart: Chat History Compaction

**Feature**: 011-chat-history-compact
**Date**: 2025-11-22
**Status**: Implemented

## Overview

This guide explains how the chat history compaction feature works in browserx.

## Integration Points

### 1. Automatic Compaction (TaskRunner)

Compaction is automatically triggered when token usage reaches 90% of the model's context window.

**Location**: `src/core/TaskRunner.ts`

```typescript
// Check if compaction is needed after each turn
private async processTurnResult(turnResult: TurnRunResult): Promise<{
  taskComplete: boolean;
  tokenLimitReached: boolean;
  lastAgentMessage?: string;
}> {
  // ... process turn items ...

  // Check token limits
  const contextWindow = this.turnContext.getModelContextWindow();
  const tokenLimitReached = Boolean(
    totalTokenUsage &&
    contextWindow &&
    totalTokenUsage.total_tokens >= contextWindow * TaskRunner.COMPACTION_THRESHOLD
  );

  return { taskComplete, tokenLimitReached, lastAgentMessage };
}

// In runLoop: trigger compaction when threshold reached
if (processResult.tokenLimitReached && this.options.autoCompact && !autoCompactAttempted) {
  compactionPerformed = await this.attemptAutoCompact(turnCount, totalTokenUsage);
  autoCompactAttempted = true;
}

// In attemptAutoCompact: use LLM-based summarization
private async attemptAutoCompact(turnCount: number, tokenUsage: TokenUsage): Promise<boolean> {
  // Get model client for LLM-based summarization
  const modelClient = this.turnContext.getModelClient();
  const result = await this.session.compact('auto', modelClient);
  // ... handle result ...
}
```

### 2. Manual Compaction (UI)

Users can trigger compaction manually via a button in the sidepanel.

**Location**: `src/sidepanel/App.svelte`

```svelte
<script lang="ts">
  async function triggerManualCompaction() {
    if (isProcessing) {
      // Cannot compact while processing
      return;
    }

    await router.sendSubmission({
      id: `compact_${Date.now()}`,
      op: { type: 'ManualCompact' },
    });
  }
</script>

<!-- Manual Compaction Button -->
<button
  on:click={triggerManualCompaction}
  disabled={isProcessing}
  aria-label="Compact History"
>
  <!-- Compress Icon -->
</button>
```

### 3. Session Integration

The Session class orchestrates compaction with the CompactService. Requires modelClient for LLM-based summarization - no fallback truncation.

**Location**: `src/core/Session.ts`

```typescript
import { CompactService } from './compact/CompactService';
import type { CompactionResult, CompactionTrigger } from './compact/types';
import type { ModelClient } from '../models/ModelClient';

async compact(
  trigger: CompactionTrigger = 'auto',
  modelClient?: ModelClient
): Promise<CompactionResult> {
  const items = this.sessionState.historySnapshot();
  const tokensBefore = this.getTokenUsageInfo()?.total_tokens ?? 0;

  // Require modelClient for LLM-based summarization - no fallback
  if (!modelClient) {
    console.warn('[Session] compact() called without modelClient - skipping compaction');
    return {
      success: false,
      tokensBefore,
      tokensAfter: tokensBefore,
      itemsTrimmed: 0,
      error: 'No modelClient provided for LLM-based summarization',
    };
  }

  // Use CompactService for LLM-based compaction
  const result = await this.compactService.compact(items, trigger, modelClient, tokensBefore);

  if (result.success && result.summaryText) {
    // Reconstruct and replace history
    const compacted = this.compactService.buildCompactedHistory(items, result.summaryText);
    const newItems = this.compactService.getHistoryReconstructor().toResponseItems(compacted);
    this.sessionState.replaceHistory(newItems);
    this.sessionState.incrementCompactionCount(result.tokensBefore - result.tokensAfter);
  }

  return result;
}
```

### 4. Session State Tracking

**Location**: `src/core/session/state/SessionState.ts`

```typescript
// Compaction tracking fields
private compactionCount: number = 0;
private lastCompactionTime?: number;
private lastCompactionTokensSaved?: number;

// Methods
incrementCompactionCount(tokensSaved?: number): void {
  this.compactionCount++;
  this.lastCompactionTime = Date.now();
  this.lastCompactionTokensSaved = tokensSaved;
}

getCompactionCount(): number {
  return this.compactionCount;
}

resetCompactionState(): void {
  this.compactionCount = 0;
  this.lastCompactionTime = undefined;
  this.lastCompactionTokensSaved = undefined;
}
```

### 5. Agent Operation Handling

**Location**: `src/core/BrowserxAgent.ts`

```typescript
// Handle compact operations in processSubmissionQueue
case 'Compact':
  await this.handleCompact('auto');
  break;

case 'ManualCompact':
  await this.handleCompact('manual');
  break;

// Implementation with LLM-based summarization
private async handleCompact(trigger: 'auto' | 'manual'): Promise<void> {
  // Get model client for LLM-based summarization
  const modelClient = await this.modelClientFactory.createClientForCurrentModel();

  // Perform compaction with LLM-based summarization
  const result = await this.session.compact(trigger, modelClient);

  // Emit CompactionCompleted event for UI
  this.emitEvent({
    type: 'CompactionCompleted',
    data: {
      success: result.success,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      itemsTrimmed: result.itemsTrimmed,
      compactionCount: this.session.getCompactionCount(),
      triggerReason: trigger,
    },
  });
}
```

## Configuration

### Default Configuration

**Location**: `src/core/compact/constants.ts`

```typescript
const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerThreshold: 0.9,      // 90% of context window
  userMessageBudget: 20000,   // tokens for user messages
  maxRetries: 3,              // retry attempts on error
  baseBackoffMs: 100,         // exponential backoff base
};
```

### Runtime Configuration

```typescript
import { CompactService } from './core/compact';

const compactService = new CompactService({
  triggerThreshold: 0.85,  // Trigger earlier at 85%
  maxRetries: 5,           // More retries
});

// Or update at runtime
compactService.updateConfig({
  userMessageBudget: 30000,
});

// Get current config
const config = compactService.getConfig();
```

## User Notifications

### Compaction Notification Event

**Location**: `src/protocol/events.ts`

```typescript
interface CompactionCompletedEvent {
  success: boolean;
  tokensBefore: number;
  tokensAfter: number;
  itemsTrimmed: number;
  compactionCount: number;
  triggerReason: 'auto' | 'manual';
  error?: string;
}
```

### UI Notification Display

**Location**: `src/sidepanel/App.svelte`

```svelte
{#if compactionNotification.show}
  <div class="compaction-notification {compactionNotification.isWarning ? 'warning' : 'success'}">
    <span class="notification-icon">
      {#if compactionNotification.isWarning}⚠️{:else}✓{/if}
    </span>
    <span class="notification-text">
      Context compacted: saved ~{Math.round(compactionNotification.tokensSaved / 1000)}k tokens
      {#if compactionNotification.isWarning}
        <span class="warning-text">
          (#{compactionNotification.compactionCount} - accuracy may be reduced)
        </span>
      {/if}
    </span>
  </div>
{/if}
```

## Logging

Debug-level console logging for all compaction events:

```typescript
// In CompactService.compact()
console.debug('[Compaction] Starting', {
  trigger,
  tokensBefore,
  historyLength: history.length,
});

console.debug('[Compaction] Complete', {
  success: true,
  tokensBefore,
  tokensAfter,
  itemsTrimmed,
  retriesUsed,
  trigger,
});

// In TaskRunner
console.debug('[TaskRunner] Token state invalidated after compaction', {
  before: result.tokensBefore,
  after: result.tokensAfter,
});
```

## Error Handling

### Transient Errors

Network and rate limit errors are retried with exponential backoff:

```typescript
const delay = calculateBackoff(retryCount, config.baseBackoffMs);
// delay = 2^retryCount * baseBackoffMs
await sleep(delay);
```

### Context Overflow During Compaction

If compaction itself exceeds context, trim oldest history items:

```typescript
private trimOldestItem(history: ResponseItem[]): ResponseItem[] {
  const initialContext = this.historyReconstructor.extractInitialContext(history);
  const rest = history.slice(initialContext.length);

  if (rest.length > 0) {
    return [...initialContext, ...rest.slice(1)];
  }

  if (initialContext.length > 1) {
    return initialContext.slice(1);
  }

  return history;
}
```

### Fatal Errors

Unrecoverable errors preserve original history:

```typescript
if (!result.success) {
  console.error('[Compaction] Failed:', result.error);
  // Original history is preserved - no replacement occurred
}
```

## File Locations

| Purpose | Path |
|---------|------|
| Main service | `src/core/compact/CompactService.ts` |
| Summary generator | `src/core/compact/SummaryGenerator.ts` |
| History reconstructor | `src/core/compact/HistoryReconstructor.ts` |
| Types | `src/core/compact/types.ts` |
| Constants (prompts) | `src/core/compact/constants.ts` |
| Utilities | `src/core/compact/utils.ts` |
| Barrel export | `src/core/compact/index.ts` |
| Session state | `src/core/session/state/SessionState.ts` |
| Session integration | `src/core/Session.ts` |
| TaskRunner trigger | `src/core/TaskRunner.ts` |
| Agent handler | `src/core/BrowserxAgent.ts` |
| UI notification | `src/sidepanel/App.svelte` |
| Event types | `src/protocol/events.ts` |
| Operation types | `src/protocol/types.ts` |
