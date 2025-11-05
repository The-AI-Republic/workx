# Quickstart Guide: Rate Limit Pause Handling

**Feature**: Rate Limit Pause Handling
**Branch**: `006-handle-rate-limit-pause`
**Audience**: Developers implementing this feature

## Overview

This guide provides a step-by-step walkthrough for implementing the rate limit pause handling feature. Follow the phases in order to ensure proper integration with the existing codebase.

---

## Prerequisites

- [ ] Read `spec.md` (functional requirements)
- [ ] Read `research.md` (technical decisions)
- [ ] Read `data-model.md` (data structures)
- [ ] Read `contracts/` (API contracts)
- [ ] Local development environment setup (Node.js, npm, Chrome browser)

---

## Phase 0: Setup & Configuration

### Step 1: Extend Configuration Schema

**File**: `src/config/types.ts`

**Action**: Add `IRateLimitPauseConfig` interface to `IProviderConfig`

```typescript
// Add new interface
export interface IRateLimitPauseConfig {
  enabled: boolean;
  defaultDuration: number;
  maxDuration: number;
  useRetryAfterHeader: boolean;
}

// Extend IProviderConfig
export interface IProviderConfig {
  // ... existing fields
  rateLimitPause?: IRateLimitPauseConfig;
}
```

**Verification**: TypeScript compiles without errors

---

### Step 2: Add Default Configuration

**File**: `src/config/defaults.ts`

**Action**: Export default rate limit pause config

```typescript
export const DEFAULT_RATE_LIMIT_PAUSE_CONFIG: IRateLimitPauseConfig = {
  enabled: true,
  defaultDuration: 60000,    // 60 seconds
  maxDuration: 300000,       // 5 minutes
  useRetryAfterHeader: true,
};

// Update provider defaults to include rateLimitPause
export const DEFAULT_PROVIDER_CONFIG: IProviderConfig = {
  // ... existing defaults
  rateLimitPause: DEFAULT_RATE_LIMIT_PAUSE_CONFIG,
};
```

**Verification**: Check that config service uses new defaults

---

### Step 3: Add Configuration Validation

**File**: `src/config/validators.ts`

**Action**: Create Zod schema for rate limit pause config

```typescript
import { z } from 'zod';

export const RateLimitPauseConfigSchema = z.object({
  enabled: z.boolean().default(true),

  defaultDuration: z.number()
    .int()
    .min(1000, 'defaultDuration must be at least 1 second (1000ms)')
    .default(60000),

  maxDuration: z.number()
    .int()
    .min(1000, 'maxDuration must be at least 1 second (1000ms)')
    .max(600000, 'maxDuration cannot exceed 10 minutes (600000ms)')
    .default(300000),

  useRetryAfterHeader: z.boolean().default(true),
}).refine(
  (data) => data.defaultDuration <= data.maxDuration,
  {
    message: 'defaultDuration cannot exceed maxDuration',
    path: ['defaultDuration'],
  }
);
```

**Test**: `tests/unit/config-validation.test.ts`

```typescript
describe('RateLimitPauseConfigSchema', () => {
  it('accepts valid config', () => {
    const config = { enabled: true, defaultDuration: 30000, maxDuration: 120000, useRetryAfterHeader: true };
    expect(RateLimitPauseConfigSchema.parse(config)).toEqual(config);
  });

  it('rejects defaultDuration exceeding maxDuration', () => {
    const config = { enabled: true, defaultDuration: 150000, maxDuration: 100000, useRetryAfterHeader: true };
    expect(() => RateLimitPauseConfigSchema.parse(config)).toThrow();
  });
});
```

**Verification**: Run `npm test -- config-validation.test.ts`

---

## Phase 1: Timer Utilities

### Step 4: Create Timer Utility

**File**: `src/utils/time.ts` (create new file)

**Action**: Implement pause timer with setTimeout/chrome.alarms hybrid

```typescript
/**
 * Create a pause timer that works in service worker context
 * Uses setTimeout for <60s pauses, chrome.alarms for >=60s
 */
export class PauseTimer {
  static async delay(
    durationMs: number,
    onResume: () => void
  ): Promise<{ timerId: number | string; cancel: () => Promise<void> }> {
    if (durationMs < 60000) {
      // Short pause: use setTimeout
      const timerId = setTimeout(onResume, durationMs);

      return {
        timerId: timerId as number,
        cancel: async () => clearTimeout(timerId),
      };
    } else {
      // Long pause: use chrome.alarms for persistence
      const alarmName = `pause-resume-${Date.now()}`;
      await chrome.alarms.create(alarmName, { delayInMinutes: durationMs / 60000 });

      const listener = (alarm: chrome.alarms.Alarm) => {
        if (alarm.name === alarmName) {
          chrome.alarms.onAlarm.removeListener(listener);
          onResume();
        }
      };
      chrome.alarms.onAlarm.addListener(listener);

      return {
        timerId: alarmName,
        cancel: async () => {
          chrome.alarms.onAlarm.removeListener(listener);
          await chrome.alarms.clear(alarmName);
        },
      };
    }
  }
}
```

**Test**: `tests/unit/pause-timer.test.ts`

```typescript
describe('PauseTimer', () => {
  it('uses setTimeout for short pauses (<60s)', async () => {
    vi.useFakeTimers();
    const onResume = vi.fn();

    const { timerId } = await PauseTimer.delay(30000, onResume);

    expect(typeof timerId).toBe('number');
    vi.advanceTimersByTime(30000);
    expect(onResume).toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('uses chrome.alarms for long pauses (>=60s)', async () => {
    const onResume = vi.fn();
    const mockAlarms = {
      create: vi.fn(),
      clear: vi.fn(),
      onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    global.chrome = { alarms: mockAlarms } as any;

    const { timerId } = await PauseTimer.delay(120000, onResume);

    expect(typeof timerId).toBe('string');
    expect(mockAlarms.create).toHaveBeenCalledWith(
      expect.stringContaining('pause-resume-'),
      { delayInMinutes: 2 }
    );
  });
});
```

**Verification**: Run `npm test -- pause-timer.test.ts`

---

## Phase 2: State Management

### Step 5: Extend Session State Types

**File**: `src/core/session/state/types.ts`

**Action**: Add pause state to `TurnExecutionState`

```typescript
export interface PersistedPauseState {
  isPaused: boolean;
  pauseReason: 'rate_limit';
  pauseStartTime: number;
  pauseDuration: number;
  provider: string;
  durationSource: 'config_default' | 'retry_after_header';
}

export interface TurnExecutionState {
  // ... existing fields
  pauseState?: PersistedPauseState | null;
}
```

**Verification**: TypeScript compiles without errors

---

### Step 6: Update SessionState Persistence

**File**: `src/core/session/state/SessionState.ts`

**Action**: Ensure pause state is persisted to IndexedDB

```typescript
// In save() method
async save(state: SessionState): Promise<void> {
  const data = {
    // ... existing fields
    turnExecutionState: {
      // ... existing turn state
      pauseState: this.turnExecutionState?.pauseState || null,
    },
  };

  await this.storage.set(this.sessionId, data);
}

// In load() method
async load(): Promise<SessionState | null> {
  const data = await this.storage.get(this.sessionId);

  if (data) {
    // ... existing restoration logic
    this.turnExecutionState = {
      // ... existing fields
      pauseState: data.turnExecutionState?.pauseState || null,
    };
  }

  return this;
}
```

**Test**: `tests/integration/pause-resume-state.test.ts`

```typescript
describe('SessionState pause persistence', () => {
  it('persists pause state to IndexedDB', async () => {
    const pauseState: PersistedPauseState = {
      isPaused: true,
      pauseReason: 'rate_limit',
      pauseStartTime: Date.now(),
      pauseDuration: 60000,
      provider: 'openai',
      durationSource: 'config_default',
    };

    await sessionState.save({ turnExecutionState: { pauseState } });
    const loaded = await sessionState.load();

    expect(loaded.turnExecutionState.pauseState).toEqual(pauseState);
  });
});
```

**Verification**: Run `npm test -- pause-resume-state.test.ts`

---

## Phase 3: Event System

### Step 7: Add Event Types

**File**: `src/protocol/events.ts`

**Action**: Add rate limit pause event types

```typescript
export interface RateLimitPausedEvent {
  type: 'rate_limit_paused';
  id: string;
  timestamp: number;
  pauseDuration: number;
  resumeTime: number;
  provider: string;
  durationSource: 'config_default' | 'retry_after_header';
  statusCode: 429;
  retryAfterHeader?: number;
}

export interface RateLimitResumedEvent {
  type: 'rate_limit_resumed';
  id: string;
  timestamp: number;
  actualPauseDuration: number;
  provider: string;
  resumeReason: 'timer_expired' | 'user_cancelled' | 'wake_from_hibernation';
}

// Add to Event union type
export type Event =
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | StreamErrorEvent
  | RateLimitPausedEvent
  | RateLimitResumedEvent
  // ... other events
;
```

**Test**: `tests/contract/pause-notification.test.ts`

```typescript
import { RateLimitPausedEventSchema, RateLimitResumedEventSchema } from '../data-model';

describe('Rate limit event schemas', () => {
  it('validates RateLimitPausedEvent', () => {
    const event = {
      type: 'rate_limit_paused',
      id: uuidv4(),
      timestamp: Date.now(),
      pauseDuration: 60000,
      resumeTime: Date.now() + 60000,
      provider: 'openai',
      durationSource: 'config_default',
      statusCode: 429,
    };

    expect(RateLimitPausedEventSchema.parse(event)).toEqual(event);
  });
});
```

**Verification**: Run `npm test -- pause-notification.test.ts`

---

## Phase 4: TurnManager Integration

### Step 8: Add Pause State to TurnManager

**File**: `src/core/TurnManager.ts`

**Action**: Add internal pause state tracking

```typescript
interface TurnPauseState {
  isPaused: boolean;
  pauseReason: 'rate_limit';
  pauseStartTime: number;
  pauseDuration: number;
  resumeTimer: number | string | null;
  provider: string;
  durationSource: 'config_default' | 'retry_after_header';
}

export class TurnManager {
  // ... existing fields
  private pauseState: TurnPauseState | null = null;

  // ... existing methods
}
```

---

### Step 9: Implement Pause Logic

**File**: `src/core/TurnManager.ts`

**Action**: Add `pauseForRateLimit()` method

```typescript
import { v4 as uuidv4 } from 'uuid';
import { PauseTimer } from '../utils/time';
import { ErrorTypeGuards } from '../models/ModelClientError';

async pauseForRateLimit(error: RateLimitError): Promise<void> {
  // Prevent double-pause
  if (this.pauseState?.isPaused) {
    throw new Error('Turn is already paused');
  }

  // Calculate pause duration
  const { duration, source } = this.calculatePauseDuration(error);

  // Create pause state
  const pauseStartTime = Date.now();
  this.pauseState = {
    isPaused: true,
    pauseReason: 'rate_limit',
    pauseStartTime,
    pauseDuration: duration,
    resumeTimer: null,
    provider: error.provider || 'unknown',
    durationSource: source,
  };

  // Persist to SessionState
  await this.session.sessionState.save({
    turnExecutionState: {
      pauseState: {
        isPaused: true,
        pauseReason: 'rate_limit',
        pauseStartTime,
        pauseDuration: duration,
        provider: this.pauseState.provider,
        durationSource: source,
      },
    },
  });

  // Emit pause event
  const pauseEvent: RateLimitPausedEvent = {
    type: 'rate_limit_paused',
    id: uuidv4(),
    timestamp: pauseStartTime,
    pauseDuration: duration,
    resumeTime: pauseStartTime + duration,
    provider: this.pauseState.provider,
    durationSource: source,
    statusCode: 429,
    retryAfterHeader: error.rateLimitMetadata.retryAfter,
  };
  this.session.eventBus.emit(pauseEvent);

  // Start pause timer
  const { timerId, cancel } = await PauseTimer.delay(duration, async () => {
    await this.resumeFromPause();
  });

  this.pauseState.resumeTimer = timerId;
}

private calculatePauseDuration(error: RateLimitError): { duration: number; source: 'config_default' | 'retry_after_header' } {
  const config = this.session.config.getProvider(error.provider || 'default')?.rateLimitPause
    || DEFAULT_RATE_LIMIT_PAUSE_CONFIG;

  // Use Retry-After header if available and configured
  if (config.useRetryAfterHeader && error.rateLimitMetadata.retryAfter) {
    const headerDuration = error.rateLimitMetadata.retryAfter * 1000; // Convert seconds to ms
    const cappedDuration = Math.min(headerDuration, config.maxDuration);

    return { duration: cappedDuration, source: 'retry_after_header' };
  }

  // Fall back to default duration
  return { duration: config.defaultDuration, source: 'config_default' };
}
```

---

### Step 10: Implement Resume Logic

**File**: `src/core/TurnManager.ts`

**Action**: Add `resumeFromPause()` method

```typescript
async resumeFromPause(): Promise<void> {
  if (!this.pauseState?.isPaused) {
    return; // Idempotent - safe to call if not paused
  }

  // Calculate actual pause duration
  const actualPauseDuration = Date.now() - this.pauseState.pauseStartTime;

  // Clear pause state
  const provider = this.pauseState.provider;
  this.pauseState = null;

  // Update SessionState
  await this.session.sessionState.save({
    turnExecutionState: {
      pauseState: null,
    },
  });

  // Emit resume event
  const resumeEvent: RateLimitResumedEvent = {
    type: 'rate_limit_resumed',
    id: uuidv4(),
    timestamp: Date.now(),
    actualPauseDuration,
    provider,
    resumeReason: 'timer_expired',
  };
  this.session.eventBus.emit(resumeEvent);
}
```

---

### Step 11: Integrate with runTurn()

**File**: `src/core/TurnManager.ts`

**Action**: Modify `runTurn()` to handle rate limits with pause

```typescript
async runTurn(input: any[]): Promise<TurnRunResult> {
  try {
    // ... existing turn execution logic

    const response = await this.modelClient.stream(request);

    // ... process response

  } catch (error) {
    // NEW: Check for rate limit error before retry logic
    if (ErrorTypeGuards.isRateLimitError(error)) {
      const config = this.session.config.getProvider(error.provider || 'default')?.rateLimitPause;

      if (config?.enabled !== false) {
        // Pause instead of retry
        await this.pauseForRateLimit(error);

        // After pause, retry the request once
        return this.runTurn(input);
      }
    }

    // EXISTING: Fall through to existing retry logic for other errors
    // ...
  }
}
```

---

### Step 12: Extend cancel() Method

**File**: `src/core/TurnManager.ts`

**Action**: Clear pause timer on cancellation

```typescript
cancel(): void {
  this.cancelled = true;

  // NEW: Clear pause timer if paused
  if (this.pauseState?.isPaused) {
    const pauseTimer = this.pauseState.resumeTimer;

    if (typeof pauseTimer === 'number') {
      clearTimeout(pauseTimer);
    } else if (typeof pauseTimer === 'string') {
      chrome.alarms.clear(pauseTimer);
    }

    // Emit cancelled resume event
    const resumeEvent: RateLimitResumedEvent = {
      type: 'rate_limit_resumed',
      id: uuidv4(),
      timestamp: Date.now(),
      actualPauseDuration: Date.now() - this.pauseState.pauseStartTime,
      provider: this.pauseState.provider,
      resumeReason: 'user_cancelled',
    };
    this.session.eventBus.emit(resumeEvent);

    this.pauseState = null;
  }

  // EXISTING: Cancel in-flight stream
  // ...
}
```

---

## Phase 5: Testing

### Step 13: Unit Tests for TurnManager Pause

**File**: `tests/unit/TurnManager-pause.test.ts`

```typescript
describe('TurnManager pause handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses turn on rate limit error', async () => {
    const error = new RateLimitError('Rate limited', {
      limit: 100,
      remaining: 0,
      reset: Date.now() / 1000 + 60,
      window: 60,
    }, 429, 'openai');

    await turnManager.pauseForRateLimit(error);

    expect(turnManager['pauseState']?.isPaused).toBe(true);
    expect(turnManager['pauseState']?.pauseDuration).toBe(60000);
  });

  it('resumes after timer expires', async () => {
    const error = new RateLimitError(/* ... */);

    await turnManager.pauseForRateLimit(error);
    vi.advanceTimersByTime(60000);

    expect(turnManager['pauseState']).toBeNull();
  });

  it('cancels pause on user cancellation', async () => {
    const error = new RateLimitError(/* ... */);

    await turnManager.pauseForRateLimit(error);
    turnManager.cancel();

    expect(turnManager['pauseState']).toBeNull();
  });
});
```

**Verification**: Run `npm test -- TurnManager-pause.test.ts`

---

### Step 14: Integration Tests

**File**: `tests/integration/rate-limit-pause.test.ts`

```typescript
describe('Rate limit pause integration', () => {
  it('full pause/resume flow', async () => {
    const events: Event[] = [];
    eventBus.on('rate_limit_paused', (e) => events.push(e));
    eventBus.on('rate_limit_resumed', (e) => events.push(e));

    // Trigger rate limit
    mockModelClient.stream.mockRejectedValueOnce(rateLimitError);

    const turnPromise = turnManager.runTurn(input);

    // Wait for pause event
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].type).toBe('rate_limit_paused');

    // Advance timer
    vi.advanceTimersByTime(60000);

    // Wait for resume event
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1].type).toBe('rate_limit_resumed');

    // Turn should complete after resume
    await turnPromise;
  });
});
```

**Verification**: Run `npm test -- rate-limit-pause.test.ts`

---

## Phase 6: UI Integration (Optional)

### Step 15: Display Pause Notification

**File**: `src/sidepanel/YourComponent.svelte`

**Action**: Listen for pause events and display notification

```typescript
<script lang="ts">
import { onMount } from 'svelte';

let pauseNotification: { message: string; remaining: number } | null = null;

onMount(() => {
  eventBus.on('rate_limit_paused', (event) => {
    pauseNotification = {
      message: `Rate limit reached for ${event.provider}`,
      remaining: event.pauseDuration,
    };

    // Countdown timer
    const interval = setInterval(() => {
      if (pauseNotification) {
        pauseNotification.remaining -= 1000;
        if (pauseNotification.remaining <= 0) {
          clearInterval(interval);
        }
      }
    }, 1000);
  });

  eventBus.on('rate_limit_resumed', () => {
    pauseNotification = null;
  });
});
</script>

{#if pauseNotification}
  <div class="notification">
    {pauseNotification.message}: Resuming in {Math.ceil(pauseNotification.remaining / 1000)}s
  </div>
{/if}
```

---

## Verification Checklist

- [ ] All TypeScript code compiles without errors
- [ ] All unit tests pass (`npm test -- unit/`)
- [ ] All integration tests pass (`npm test -- integration/`)
- [ ] All contract tests pass (`npm test -- contract/`)
- [ ] Configuration validation works correctly
- [ ] Pause events are emitted with correct schema
- [ ] Resume events are emitted after pause expires
- [ ] Cancellation during pause works correctly
- [ ] State persists across service worker hibernation (manual test in Chrome)
- [ ] UI displays pause notification (if implemented)

---

## Troubleshooting

### Issue: Timer doesn't fire after service worker hibernation

**Solution**: Ensure using `chrome.alarms` for pauses >=60s, not `setTimeout`

---

### Issue: Double-pause error

**Solution**: Check that `pauseState` is cleared in `resumeFromPause()` and `cancel()`

---

### Issue: Config validation fails

**Solution**: Verify `defaultDuration <= maxDuration` in config schema

---

## Next Steps

After completing this quickstart:

1. Run `/speckit.tasks` to generate implementation tasks
2. Review tasks.md for detailed task breakdown
3. Start implementation following task order
4. Submit PR with comprehensive tests and documentation

---

## Reference Links

- [Spec](./spec.md)
- [Research Decisions](./research.md)
- [Data Model](./data-model.md)
- [TurnManager Contract](./contracts/TurnManager.contract.md)
- [Events Contract](./contracts/events.contract.md)
