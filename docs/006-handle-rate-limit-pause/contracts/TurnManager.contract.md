# TurnManager Contract: Pause/Resume API

**Feature**: Rate Limit Pause Handling
**Component**: TurnManager
**Version**: 1.0.0

## Overview

This contract defines the public API extensions to `TurnManager` for pause/resume functionality. These methods are called internally during turn execution when rate limits are detected.

---

## Public API Extensions

### `pauseForRateLimit(error: RateLimitError): Promise<void>`

**Purpose**: Pause the current turn execution due to a rate limit error.

**Preconditions**:
- Turn is currently executing (not already paused or completed)
- `error` is a valid `RateLimitError` instance
- TurnManager is not cancelled

**Parameters**:
```typescript
interface RateLimitError {
  statusCode: 429;
  rateLimitMetadata: {
    retryAfter?: number;  // seconds
    remaining: number;
    limit: number;
    reset: number;        // Unix timestamp
  };
  provider?: string;
}
```

**Behavior**:
1. Calculate pause duration from error metadata or config defaults
2. Cap pause duration at `maxDuration` from config
3. Create `TurnPauseState` with calculated duration
4. Persist pause state to SessionState (IndexedDB)
5. Emit `RateLimitPausedEvent` to event bus
6. Start pause timer (setTimeout or chrome.alarms depending on duration)
7. Return promise that resolves when pause completes or is cancelled

**Postconditions**:
- `TurnPauseState` is set with `isPaused = true`
- Pause state persisted to IndexedDB
- `RateLimitPausedEvent` emitted
- Timer scheduled for resume

**Error Handling**:
- Throws if already paused (prevent double-pause)
- Throws if turn is cancelled
- Logs warning if pause duration exceeds safety cap (maxDuration)

**Example Usage**:
```typescript
try {
  await modelClient.stream(request);
} catch (error) {
  if (ErrorTypeGuards.isRateLimitError(error)) {
    await this.pauseForRateLimit(error);
    // After pause, retry the request
    return this.runTurn(input);
  }
  throw error;
}
```

---

### `resumeFromPause(): Promise<void>`

**Purpose**: Resume turn execution after a pause timer expires.

**Preconditions**:
- Turn is currently paused (`pauseState.isPaused === true`)
- Resume timer has expired or been manually triggered

**Parameters**: None

**Behavior**:
1. Calculate actual pause duration (for telemetry)
2. Clear pause state (set `pauseState = null`)
3. Update SessionState to remove pause state
4. Emit `RateLimitResumedEvent` with `resumeReason: 'timer_expired'`
5. Return control to turn execution flow (caller retries the request)

**Postconditions**:
- `TurnPauseState` is `null`
- Pause state removed from SessionState
- `RateLimitResumedEvent` emitted
- Turn ready to continue execution

**Error Handling**:
- No-op if not currently paused (idempotent)

---

### `resumeFromPersistence(remainingDuration: number): Promise<void>`

**Purpose**: Resume a paused turn after service worker hibernation/wake.

**Preconditions**:
- Service worker just woke up
- SessionState contains active pause state
- `remainingDuration > 0` (if 0, resume immediately)

**Parameters**:
```typescript
remainingDuration: number;  // milliseconds remaining in pause
```

**Behavior**:
1. If `remainingDuration === 0`:
   - Call `resumeFromPause()` immediately
   - Emit event with `resumeReason: 'wake_from_hibernation'`
2. If `remainingDuration > 0`:
   - Recreate pause timer with remaining duration
   - Restore `TurnPauseState` from SessionState
   - Continue pause until timer expires

**Postconditions**:
- Turn either resumed immediately (if pause expired) or pause timer restarted
- State consistent with pre-hibernation state

**Error Handling**:
- Logs error if SessionState is corrupted
- Falls back to immediate resume if cannot restore pause

---

### `cancel(): void` (Extended)

**Purpose**: Cancel turn execution, including any active pause.

**Preconditions**: None (always allowed)

**Parameters**: None

**Behavior** (Extended from existing):
1. **NEW**: If paused, clear pause timer
2. **NEW**: If paused, emit `RateLimitResumedEvent` with `resumeReason: 'user_cancelled'`
3. **NEW**: If paused, remove pause state from SessionState
4. **EXISTING**: Set `cancelled = true`
5. **EXISTING**: Abort any in-flight streaming request

**Postconditions**:
- Pause timer cleared (if paused)
- `cancelled === true`
- All async operations cleaned up

---

## Internal Helper Methods

### `calculatePauseDuration(error: RateLimitError): number`

**Purpose**: Determine pause duration from error metadata and config.

**Logic**:
1. Get provider config for `error.provider`
2. Extract `rateLimitPause` config (or use defaults)
3. If `useRetryAfterHeader === true` and error has `retryAfter`:
   - Convert `retryAfter` from seconds to milliseconds
   - Cap at `maxDuration`
   - Return capped value with source `'retry_after_header'`
4. Else:
   - Return `defaultDuration` with source `'config_default'`

**Return**:
```typescript
{
  duration: number;        // milliseconds
  source: 'config_default' | 'retry_after_header';
}
```

---

### `createPauseTimer(duration: number, onResume: () => void): Promise<void>`

**Purpose**: Create appropriate timer for pause duration (setTimeout vs chrome.alarms).

**Logic**:
1. If `duration < 60000` (1 minute):
   - Use `setTimeout`
   - Store timer ID in `pauseState.resumeTimer`
2. Else:
   - Use `chrome.alarms.create()`
   - Store alarm name in `pauseState.resumeTimer`
   - Register alarm listener to call `onResume`

**Return**: Promise that resolves when timer fires or is cancelled

---

## Event Contracts

### RateLimitPausedEvent

Emitted by: `pauseForRateLimit()`

**Schema**:
```typescript
{
  type: 'rate_limit_paused',
  id: string,              // UUID
  timestamp: number,       // Unix ms
  pauseDuration: number,   // ms
  resumeTime: number,      // Unix ms (timestamp + pauseDuration)
  provider: string,        // e.g., 'openai'
  durationSource: 'config_default' | 'retry_after_header',
  statusCode: 429,
  retryAfterHeader?: number  // seconds (if present in error)
}
```

**Guarantees**:
- Emitted exactly once per pause
- Emitted before pause timer starts
- `resumeTime` is accurate prediction (barring cancellation)

---

### RateLimitResumedEvent

Emitted by: `resumeFromPause()`, `resumeFromPersistence()`, `cancel()`

**Schema**:
```typescript
{
  type: 'rate_limit_resumed',
  id: string,                    // UUID
  timestamp: number,             // Unix ms
  actualPauseDuration: number,   // ms (may differ from requested if cancelled)
  provider: string,
  resumeReason: 'timer_expired' | 'user_cancelled' | 'wake_from_hibernation'
}
```

**Guarantees**:
- Emitted exactly once per pause (paired with `RateLimitPausedEvent`)
- Emitted after pause state is cleared
- `actualPauseDuration` is measured time, not requested time

---

## State Persistence Contract

### SessionState.save()

**When**: Called by `pauseForRateLimit()` when pause begins

**Payload**:
```typescript
{
  turnExecutionState: {
    // ... existing fields
    pauseState: {
      isPaused: true,
      pauseReason: 'rate_limit',
      pauseStartTime: number,    // Unix ms
      pauseDuration: number,     // ms
      provider: string,
      durationSource: 'config_default' | 'retry_after_header'
    }
  }
}
```

---

### SessionState.load()

**When**: Called on service worker wake to check for active pauses

**Return**:
```typescript
{
  turnExecutionState?: {
    pauseState?: {
      isPaused: boolean,
      pauseStartTime: number,
      pauseDuration: number,
      // ... other fields
    }
  }
}
```

**Recovery Logic**:
```typescript
if (state.pauseState?.isPaused) {
  const elapsed = Date.now() - state.pauseState.pauseStartTime;
  const remaining = Math.max(0, state.pauseState.pauseDuration - elapsed);

  if (remaining > 0) {
    await turnManager.resumeFromPersistence(remaining);
  } else {
    // Pause expired during hibernation
    await turnManager.resumeFromPause();
  }
}
```

---

## Configuration Contract

### Required Config Fields

**Location**: `IProviderConfig.rateLimitPause`

```typescript
{
  enabled: boolean,           // default: true
  defaultDuration: number,    // ms, default: 60000, min: 1000, max: maxDuration
  maxDuration: number,        // ms, default: 300000, min: 1000, max: 600000
  useRetryAfterHeader: boolean // default: true
}
```

### Validation

**Performed by**: `src/config/validators.ts`

**Rules**:
1. All fields must match type
2. `defaultDuration >= 1000`
3. `maxDuration >= 1000 && maxDuration <= 600000`
4. `defaultDuration <= maxDuration`

**On Validation Failure**:
- Throw `ConfigValidationError` with field path and error message
- Do not apply invalid config (use previous valid config or defaults)

---

## Testing Contract

### Unit Test Coverage

**Required tests**:
1. `pauseForRateLimit()` with config default duration
2. `pauseForRateLimit()` with Retry-After header
3. `pauseForRateLimit()` with duration exceeding maxDuration (should cap)
4. `resumeFromPause()` emits correct event
5. `resumeFromPersistence()` with remaining time
6. `resumeFromPersistence()` with expired pause (remaining = 0)
7. `cancel()` during pause clears timer and emits event
8. `calculatePauseDuration()` logic branches
9. Double-pause prevention (throws error)

---

### Integration Test Coverage

**Required tests**:
1. Full pause/resume flow: rate limit → pause → timer → resume → retry
2. State persistence: pause → save → hibernate → wake → load → resume
3. Cancellation during pause: pause → cancel → verify cleanup
4. Multiple sequential rate limits (verify no infinite loop)
5. Config change during pause (verify uses new config on next pause)

---

### Contract Test Coverage

**Required tests**:
1. `RateLimitPausedEvent` schema validation (Zod)
2. `RateLimitResumedEvent` schema validation (Zod)
3. SessionState pause state schema validation
4. Config schema validation

---

## Backward Compatibility

### Breaking Changes
- **None**: New functionality is additive

### Behavioral Changes
- **Before**: HTTP 429 → retry with exponential backoff (up to 3 retries)
- **After**: HTTP 429 → pause for configured duration → single retry
- **Opt-out**: Set `rateLimitPause.enabled = false` to revert to old behavior

### Migration Path
- Existing configurations continue to work (new fields are optional with defaults)
- Existing sessions without `pauseState` handle gracefully (treat as null)
- No data migration required

---

## Performance Guarantees

1. **Notification Latency**: `RateLimitPausedEvent` emitted within 500ms of pause start
2. **Resume Accuracy**: Resume occurs within 1 second of target `resumeTime`
3. **Memory Overhead**: Pause state adds <1KB to SessionState payload
4. **Timer Overhead**: Single setTimeout or chrome.alarm per pause (not per-second polling)

---

## Error Handling Guarantees

1. **Timer Cleanup**: Timers always cleared on cancellation (no leaks)
2. **State Consistency**: Pause state always cleaned up on resume/cancel
3. **Idempotency**: Resume operations are idempotent (safe to call multiple times)
4. **Recovery**: Graceful degradation if SessionState is corrupted (log + resume immediately)
