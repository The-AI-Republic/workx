# Research & Technical Decisions: Rate Limit Pause Handling

**Branch**: `006-handle-rate-limit-pause` | **Date**: 2025-11-03

## Research Questions

This document resolves all "NEEDS CLARIFICATION" items from the technical planning phase and establishes architectural decisions for the pause-and-resume mechanism.

---

## 1. Pause State Management Strategy

### Decision: Extend TurnManager with In-Memory Pause State + SessionState Persistence

**Rationale**:
- TurnManager already orchestrates turn execution lifecycle
- Pause state is transient (only during active turn execution)
- SessionState provides persistence layer for recovery from service worker hibernation
- Minimal architectural changes required

**Implementation Approach**:
```typescript
// In TurnManager
private pauseState: {
  isPaused: boolean;
  pauseReason: 'rate_limit' | null;
  pauseStartTime: number;
  pauseDuration: number;
  resumeTimer: ReturnType<typeof setTimeout> | null;
} | null = null;
```

**Alternatives Considered**:
1. **Separate PauseManager service**: Rejected - adds unnecessary indirection, TurnManager already manages turn lifecycle
2. **Store pause state only in SessionState**: Rejected - requires constant I/O for simple in-memory state checks
3. **Event-based pause/resume without state tracking**: Rejected - makes testing and debugging difficult, no clear source of truth

**Trade-offs**:
- ✅ Simple integration with existing TurnManager flow
- ✅ Easy to test (inject mock timers)
- ✅ Clear ownership (pause state lives with turn lifecycle)
- ⚠️ Requires SessionState persistence for service worker resilience
- ⚠️ Need to handle timer cleanup on cancellation

---

## 2. Configuration Schema Design

### Decision: Add `rateLimitPause` to IProviderConfig with Provider-Level Defaults

**Rationale**:
- Different API providers have different rate limit windows (OpenAI: 60s, Anthropic: variable)
- Provider-level configuration allows fine-grained control per API
- Falls back to global defaults if not specified
- Aligns with existing config architecture (provider-specific settings in IProviderConfig)

**Schema Extension**:
```typescript
// Add to IProviderConfig in src/config/types.ts
interface IProviderConfig {
  // ... existing fields
  rateLimitPause?: {
    enabled: boolean;        // Default: true
    defaultDuration: number; // Default: 60000ms (60 seconds)
    maxDuration: number;     // Default: 300000ms (5 minutes) - safety cap
    useRetryAfterHeader: boolean; // Default: true
  };
}

// Validation rules
- defaultDuration: 1000 <= value <= maxDuration
- maxDuration: 1000 <= value <= 600000 (10 minutes max)
- If useRetryAfterHeader=true and Retry-After exceeds maxDuration, cap at maxDuration
```

**Alternatives Considered**:
1. **Global-only configuration**: Rejected - doesn't account for provider-specific rate limit behavior
2. **Per-model configuration**: Rejected - overly granular, models from same provider share rate limits
3. **Hardcoded 60s pause**: Rejected - not flexible for different providers or user needs

**Trade-offs**:
- ✅ Flexible per-provider configuration
- ✅ Safe defaults prevent excessive pause durations
- ✅ Retry-After header support built into config
- ⚠️ Slightly more complex config validation
- ⚠️ Need to document provider-specific recommendations

---

## 3. Timer Implementation in Chrome Extension Service Worker Context

### Decision: Use Promise-Based Delay with chrome.alarms Fallback

**Rationale**:
- Chrome service workers can hibernate during long pauses
- `setTimeout` is unreliable in service worker context (may not fire after hibernation)
- `chrome.alarms` API is designed for service worker persistence but has 1-minute minimum
- Hybrid approach: `setTimeout` for <60s pauses, `chrome.alarms` for >=60s

**Implementation Approach**:
```typescript
// src/utils/time.ts
export class PauseTimer {
  static async delay(durationMs: number, onResume: () => void): Promise<void> {
    if (durationMs < 60000) {
      // Short pause: use setTimeout (works fine for <1 min)
      return new Promise(resolve => {
        setTimeout(() => {
          onResume();
          resolve();
        }, durationMs);
      });
    } else {
      // Long pause: use chrome.alarms for persistence
      const alarmName = `pause-resume-${Date.now()}`;
      await chrome.alarms.create(alarmName, { delayInMinutes: durationMs / 60000 });

      return new Promise(resolve => {
        const listener = (alarm: chrome.alarms.Alarm) => {
          if (alarm.name === alarmName) {
            chrome.alarms.onAlarm.removeListener(listener);
            onResume();
            resolve();
          }
        };
        chrome.alarms.onAlarm.addListener(listener);
      });
    }
  }
}
```

**Alternatives Considered**:
1. **setTimeout only**: Rejected - unreliable in service worker context after hibernation
2. **chrome.alarms only**: Rejected - has 1-minute minimum, wasteful for short pauses
3. **External job queue (e.g., Redis)**: Rejected - overkill for Chrome extension, requires infrastructure
4. **Polling with chrome.storage**: Rejected - inefficient, battery drain

**Trade-offs**:
- ✅ Reliable pause/resume across service worker lifecycle
- ✅ Efficient for both short and long pauses
- ✅ Testable (can mock both setTimeout and chrome.alarms)
- ⚠️ Slightly more complex implementation (two code paths)
- ⚠️ Need to handle alarm cleanup on cancellation

---

## 4. Event Notification Strategy

### Decision: Extend Existing Event System with New `rate_limit_paused` and `rate_limit_resumed` Events

**Rationale**:
- Project already has event-driven architecture (protocol/events.ts)
- Consistent with existing error notification patterns
- Allows UI (side panel) to display pause status without polling
- Easy to extend with additional metadata (pause duration, resume time)

**Event Schema**:
```typescript
// Add to src/protocol/events.ts
export interface RateLimitPausedEvent extends Event {
  type: 'rate_limit_paused';
  pauseDuration: number;      // milliseconds
  resumeTime: number;         // Unix timestamp
  provider: string;           // e.g., "openai"
  retryAfterSource: 'config' | 'header'; // where duration came from
}

export interface RateLimitResumedEvent extends Event {
  type: 'rate_limit_resumed';
  pausedDuration: number;     // actual pause time in ms
  provider: string;
}
```

**Alternatives Considered**:
1. **Reuse existing error events**: Rejected - pause is not an error, needs distinct semantics
2. **Single `rate_limit_status` event with state field**: Rejected - less clear than separate pause/resume events
3. **No events, UI polls TurnManager**: Rejected - inefficient, tight coupling

**Trade-offs**:
- ✅ Clean separation of concerns (pause logic doesn't know about UI)
- ✅ Consistent with existing event patterns
- ✅ Extensible for future pause scenarios (quota limits, etc.)
- ⚠️ Need to test event emission in pause/resume flow

---

## 5. Retry Logic Modification Strategy

### Decision: Detect Rate Limit in TurnManager, Bypass StreamAttemptError Retry for HTTP 429

**Rationale**:
- `StreamAttemptError.fromHttpStatus(429)` currently marks 429 as retryable
- Need to intercept 429 before retry logic kicks in
- TurnManager already handles streaming errors, natural place for pause injection
- Preserves existing retry logic for other retryable errors (500-599, network failures)

**Implementation Flow**:
```typescript
// In TurnManager.runTurn()
try {
  // ... existing streaming logic
} catch (error) {
  // NEW: Check if it's a rate limit error before retry logic
  if (isRateLimitError(error) && this.shouldPauseForRateLimit()) {
    await this.pauseForRateLimit(error);
    // After pause, retry the request (single retry after pause)
    return this.runTurn(input); // Recursive call
  }

  // EXISTING: Fall through to existing retry logic for other errors
  if (attempt < this.config.maxRetries && isRetryable(error)) {
    // ... existing exponential backoff retry
  }
}
```

**Alternatives Considered**:
1. **Modify StreamAttemptError to not retry 429**: Rejected - breaks existing behavior for consumers who want retries
2. **Add pause logic in ModelClient**: Rejected - too low-level, ModelClient shouldn't know about turn lifecycle
3. **Add pause as retry strategy**: Rejected - conflates two different error handling approaches

**Trade-offs**:
- ✅ Clear separation: pause for rate limits, retry for transient failures
- ✅ Minimal changes to existing retry logic
- ✅ Easy to disable pause via config while preserving retries
- ⚠️ Need to prevent infinite pause loops (limit max pauses per turn)
- ⚠️ Need to handle cancellation during pause

---

## 6. State Persistence for Service Worker Hibernation

### Decision: Persist Pause State to SessionState with Resume-on-Wake Logic

**Rationale**:
- Chrome service workers can hibernate unpredictably
- SessionState already persists turn execution state to IndexedDB
- On service worker wake, can check for active pauses and resume
- Requires minimal changes to existing persistence layer

**Persistence Schema**:
```typescript
// Add to src/core/session/state/types.ts
interface TurnExecutionState {
  // ... existing fields
  pauseState?: {
    isPaused: boolean;
    pauseReason: 'rate_limit';
    pauseStartTime: number;     // Unix timestamp
    pauseDuration: number;      // milliseconds
    remainingDuration: number;  // calculated on save
  };
}
```

**Resume-on-Wake Logic**:
```typescript
// In Session initialization or service worker activation
async resumeFromPersistence() {
  const state = await this.sessionState.load();

  if (state.turnExecutionState?.pauseState?.isPaused) {
    const elapsed = Date.now() - state.turnExecutionState.pauseState.pauseStartTime;
    const remaining = Math.max(0, state.turnExecutionState.pauseState.pauseDuration - elapsed);

    if (remaining > 0) {
      // Resume pause with remaining duration
      await this.turnManager.resumePause(remaining);
    } else {
      // Pause expired during hibernation, resume immediately
      await this.turnManager.resumeTurn();
    }
  }
}
```

**Alternatives Considered**:
1. **No persistence, restart turn on wake**: Rejected - loses user context, poor UX
2. **Persist to chrome.storage.local**: Rejected - SessionState already uses IndexedDB, more flexible
3. **Use chrome.alarms.getAll() to check pending alarms**: Considered but insufficient - doesn't tell us which turn was paused

**Trade-offs**:
- ✅ Resilient to service worker hibernation
- ✅ Preserves user experience across browser restarts
- ✅ Leverages existing persistence infrastructure
- ⚠️ Need to handle edge cases (expired pause during hibernation)
- ⚠️ Need to test hibernation scenarios

---

## 7. Cancellation Handling During Pause

### Decision: Support Immediate Cancellation with Timer Cleanup

**Rationale**:
- Users should be able to stop execution during pause (don't force them to wait)
- TurnManager already has `cancel()` method for in-flight requests
- Need to extend cancellation to clear pause timers and reset state

**Implementation**:
```typescript
// In TurnManager
cancel(): void {
  this.cancelled = true;

  // NEW: Clear pause timer if paused
  if (this.pauseState?.resumeTimer) {
    clearTimeout(this.pauseState.resumeTimer);
    // Or chrome.alarms.clear() if using alarms
    this.pauseState = null;
  }

  // EXISTING: Cancel in-flight stream
  // ... existing cancellation logic
}
```

**Alternatives Considered**:
1. **No cancellation during pause**: Rejected - poor UX, user stuck waiting
2. **Cancel only clears timer, turn stays paused**: Rejected - confusing state
3. **Cancel triggers immediate retry**: Rejected - user expects full stop, not retry

**Trade-offs**:
- ✅ Consistent with existing cancellation behavior
- ✅ Simple to implement and test
- ✅ Clear user experience
- ⚠️ Need to update pause state in SessionState on cancellation

---

## Technology Stack Summary

### Confirmed Technologies
- **TypeScript 5.9.2**: Core implementation language
- **Chrome Extension APIs**: Manifest V3, chrome.storage.local, chrome.alarms
- **Vitest 3.2.4**: Unit and integration testing
- **Zod 3.23.8**: Runtime config validation
- **IndexedDB (via SessionState)**: Pause state persistence

### Development Tools
- **fake-indexeddb**: Test persistence without real browser DB
- **chrome-mock**: Mock Chrome APIs in tests
- **vi.useFakeTimers()**: Test timer logic without real delays

### Testing Strategy
- **Unit Tests**: Pause/resume logic, timer utilities, config validation
- **Integration Tests**: End-to-end pause flows, state persistence across hibernation
- **Contract Tests**: Event schema validation, SessionState persistence format

---

## Open Questions & Future Considerations

### Deferred to Implementation
1. **UI Design for Pause Notification**: How to display pause status in side panel (toast, status bar, modal?)
2. **Telemetry**: Should we track pause frequency/duration for analytics?
3. **Multiple Sequential Rate Limits**: Should we have a max pause count per turn to prevent infinite loops?

### Future Enhancements (Out of Scope)
1. **Adaptive Pause Duration**: Use historical rate limit data to predict optimal pause time
2. **Cross-Tab Pause Coordination**: If multiple tabs use same API key, coordinate pauses
3. **Pause Preview**: Show estimated wait time before committing to pause

---

## References

- [Chrome Extension Service Worker Lifecycle](https://developer.chrome.com/docs/extensions/mv3/service_workers/)
- [chrome.alarms API Documentation](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [OpenAI Rate Limits](https://platform.openai.com/docs/guides/rate-limits)
- Existing Codebase:
  - `src/core/TurnManager.ts` - Turn execution orchestration
  - `src/models/ModelClientError.ts` - RateLimitError definition
  - `src/core/session/state/SessionState.ts` - State persistence layer
  - `src/protocol/events.ts` - Event system
