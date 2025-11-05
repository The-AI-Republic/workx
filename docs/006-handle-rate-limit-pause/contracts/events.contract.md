# Event System Contract: Rate Limit Pause Events

**Feature**: Rate Limit Pause Handling
**Component**: Event Protocol
**Version**: 1.0.0

## Overview

This contract defines the event schemas and behavior guarantees for rate limit pause notifications. Events follow the existing event system architecture in `src/protocol/events.ts`.

---

## Event Schema Standards

All rate limit pause events adhere to these standards:

1. **Type Discriminator**: `type` field for event identification
2. **Unique ID**: `id` field (UUID v4) for event tracking
3. **Timestamp**: `timestamp` field (Unix milliseconds) for sequencing
4. **Immutability**: Events are immutable once emitted
5. **JSON Serializable**: All fields must be JSON-serializable (no functions, symbols, etc.)

---

## Event 1: RateLimitPausedEvent

### Purpose
Notify UI and monitoring systems that turn execution has paused due to a rate limit error.

### Schema

```typescript
interface RateLimitPausedEvent {
  /**
   * Event type discriminator
   * @constant 'rate_limit_paused'
   */
  type: 'rate_limit_paused';

  /**
   * Unique event identifier
   * @format UUID v4
   */
  id: string;

  /**
   * Event creation timestamp
   * @format Unix milliseconds
   */
  timestamp: number;

  /**
   * Total pause duration in milliseconds
   * @minimum 1000
   * @maximum 600000
   */
  pauseDuration: number;

  /**
   * Unix timestamp (ms) when turn will resume
   * @invariant resumeTime === timestamp + pauseDuration
   */
  resumeTime: number;

  /**
   * API provider that triggered the rate limit
   * @example "openai", "anthropic"
   */
  provider: string;

  /**
   * Source of the pause duration value
   * @enum 'config_default' | 'retry_after_header'
   */
  durationSource: 'config_default' | 'retry_after_header';

  /**
   * HTTP status code that triggered the pause
   * @constant 429
   */
  statusCode: 429;

  /**
   * Retry-After header value from API response (if present)
   * @format seconds
   * @optional
   */
  retryAfterHeader?: number;
}
```

### Validation (Zod Schema)

```typescript
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

export const RateLimitPausedEventSchema = z.object({
  type: z.literal('rate_limit_paused'),

  id: z.string().uuid(),

  timestamp: z.number()
    .int()
    .positive()
    .refine((t) => t <= Date.now() + 1000, {
      message: 'Timestamp cannot be in the future',
    }),

  pauseDuration: z.number()
    .int()
    .min(1000, 'Pause duration must be at least 1 second')
    .max(600000, 'Pause duration cannot exceed 10 minutes'),

  resumeTime: z.number()
    .int()
    .positive(),

  provider: z.string()
    .min(1, 'Provider must be non-empty'),

  durationSource: z.enum(['config_default', 'retry_after_header']),

  statusCode: z.literal(429),

  retryAfterHeader: z.number()
    .int()
    .positive()
    .optional(),

}).refine(
  (data) => data.resumeTime === data.timestamp + data.pauseDuration,
  {
    message: 'resumeTime must equal timestamp + pauseDuration',
    path: ['resumeTime'],
  }
);
```

### Emission Guarantees

1. **Timing**: Emitted within 500ms of pause detection
2. **Ordering**: Emitted before pause timer starts
3. **Frequency**: Exactly once per pause
4. **Idempotency**: If pause is retriggered (edge case), new event with new ID is emitted

### Consumer Contract

**UI Consumers** should:
- Display pause notification with countdown timer
- Use `resumeTime - Date.now()` for real-time countdown
- Handle edge case where `resumeTime` is in the past (pause already ended)

**Monitoring Consumers** should:
- Track pause frequency per provider
- Alert on excessive pause rates (potential API key issues)
- Measure actual vs. predicted pause durations

**Example Consumer**:
```typescript
eventBus.on('rate_limit_paused', (event: RateLimitPausedEvent) => {
  const remaining = event.resumeTime - Date.now();

  if (remaining > 0) {
    showNotification({
      message: `Rate limit reached for ${event.provider}. Pausing for ${Math.ceil(remaining / 1000)}s`,
      duration: remaining,
    });
  }
});
```

---

## Event 2: RateLimitResumedEvent

### Purpose
Notify UI and monitoring systems that turn execution has resumed after a pause.

### Schema

```typescript
interface RateLimitResumedEvent {
  /**
   * Event type discriminator
   * @constant 'rate_limit_resumed'
   */
  type: 'rate_limit_resumed';

  /**
   * Unique event identifier
   * @format UUID v4
   */
  id: string;

  /**
   * Event creation timestamp
   * @format Unix milliseconds
   */
  timestamp: number;

  /**
   * Actual duration paused in milliseconds
   * May differ from requested duration if cancelled early
   * @minimum 0
   */
  actualPauseDuration: number;

  /**
   * API provider that was rate limited
   * @example "openai", "anthropic"
   */
  provider: string;

  /**
   * Reason for resume
   * @enum 'timer_expired' | 'user_cancelled' | 'wake_from_hibernation'
   */
  resumeReason: 'timer_expired' | 'user_cancelled' | 'wake_from_hibernation';
}
```

### Validation (Zod Schema)

```typescript
export const RateLimitResumedEventSchema = z.object({
  type: z.literal('rate_limit_resumed'),

  id: z.string().uuid(),

  timestamp: z.number()
    .int()
    .positive()
    .refine((t) => t <= Date.now() + 1000, {
      message: 'Timestamp cannot be in the future',
    }),

  actualPauseDuration: z.number()
    .int()
    .nonnegative(),

  provider: z.string()
    .min(1, 'Provider must be non-empty'),

  resumeReason: z.enum([
    'timer_expired',
    'user_cancelled',
    'wake_from_hibernation',
  ]),
});
```

### Emission Guarantees

1. **Timing**: Emitted immediately after pause state is cleared
2. **Ordering**: Always follows a `RateLimitPausedEvent` (paired events)
3. **Frequency**: Exactly once per pause
4. **Accuracy**: `actualPauseDuration` is measured time (not requested time)

### Consumer Contract

**UI Consumers** should:
- Dismiss pause notification
- Display resume status (especially for `wake_from_hibernation`)
- Log if `resumeReason === 'user_cancelled'` (user feedback)

**Monitoring Consumers** should:
- Compare `actualPauseDuration` with predicted duration from `RateLimitPausedEvent`
- Track resume reason distribution (how often are pauses cancelled vs. naturally expiring?)
- Alert on frequent `wake_from_hibernation` (may indicate service worker instability)

**Example Consumer**:
```typescript
eventBus.on('rate_limit_resumed', (event: RateLimitResumedEvent) => {
  dismissNotification();

  if (event.resumeReason === 'wake_from_hibernation') {
    console.warn('Service worker hibernated during pause');
  }

  logTelemetry({
    event: 'rate_limit_resumed',
    duration: event.actualPauseDuration,
    reason: event.resumeReason,
  });
});
```

---

## Event Sequencing

### Normal Flow
```
1. RateLimitPausedEvent emitted
   ↓ (wait pauseDuration)
2. RateLimitResumedEvent emitted (resumeReason: 'timer_expired')
```

### Cancellation Flow
```
1. RateLimitPausedEvent emitted
   ↓ (user cancels before timer expires)
2. RateLimitResumedEvent emitted (resumeReason: 'user_cancelled')
```

### Hibernation Flow
```
1. RateLimitPausedEvent emitted
   ↓ (service worker hibernates)
   ↓ (service worker wakes)
2. RateLimitResumedEvent emitted (resumeReason: 'wake_from_hibernation')
```

### Invariants
1. Every `RateLimitPausedEvent` has exactly one corresponding `RateLimitResumedEvent`
2. `RateLimitResumedEvent.timestamp >= RateLimitPausedEvent.timestamp`
3. `RateLimitResumedEvent.provider === RateLimitPausedEvent.provider` (same pause)

---

## Event Bus Integration

### Registration

Events are added to the existing event type union in `src/protocol/events.ts`:

```typescript
export type Event =
  | StreamStartEvent
  | StreamChunkEvent
  | StreamEndEvent
  | StreamErrorEvent
  | RateLimitPausedEvent   // NEW
  | RateLimitResumedEvent  // NEW
  | ToolExecutionEvent
  // ... other events
;
```

### Type Guards

```typescript
export function isRateLimitPausedEvent(event: Event): event is RateLimitPausedEvent {
  return event.type === 'rate_limit_paused';
}

export function isRateLimitResumedEvent(event: Event): event is RateLimitResumedEvent {
  return event.type === 'rate_limit_resumed';
}
```

### Emission

Events are emitted via the existing event bus mechanism:

```typescript
// In TurnManager.pauseForRateLimit()
const event: RateLimitPausedEvent = {
  type: 'rate_limit_paused',
  id: uuidv4(),
  timestamp: Date.now(),
  pauseDuration: duration,
  resumeTime: Date.now() + duration,
  provider: error.provider || 'unknown',
  durationSource: source,
  statusCode: 429,
  retryAfterHeader: error.rateLimitMetadata.retryAfter,
};

this.eventBus.emit(event);
```

---

## Testing Contract

### Unit Tests

**Test: Event schema validation**
```typescript
describe('RateLimitPausedEvent schema', () => {
  it('accepts valid event', () => {
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

  it('rejects invalid pauseDuration', () => {
    const event = { /* ... */ pauseDuration: -1000 };
    expect(() => RateLimitPausedEventSchema.parse(event)).toThrow();
  });

  it('enforces resumeTime invariant', () => {
    const event = {
      /* ... */
      timestamp: 1000,
      pauseDuration: 5000,
      resumeTime: 7000,  // Should be 6000
    };
    expect(() => RateLimitPausedEventSchema.parse(event)).toThrow();
  });
});
```

---

### Integration Tests

**Test: Event emission during pause flow**
```typescript
describe('Pause event emission', () => {
  it('emits RateLimitPausedEvent on pause', async () => {
    const events: Event[] = [];
    eventBus.on('rate_limit_paused', (e) => events.push(e));

    await turnManager.pauseForRateLimit(rateLimitError);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('rate_limit_paused');
    expect(events[0].provider).toBe('openai');
  });

  it('emits paired RateLimitResumedEvent on resume', async () => {
    const events: Event[] = [];
    eventBus.on('rate_limit_resumed', (e) => events.push(e));

    await turnManager.pauseForRateLimit(rateLimitError);
    vi.advanceTimersByTime(60000);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('rate_limit_resumed');
    expect(events[0].resumeReason).toBe('timer_expired');
  });
});
```

---

### Contract Tests

**Test: Event type guards**
```typescript
describe('Event type guards', () => {
  it('identifies RateLimitPausedEvent', () => {
    const event = { type: 'rate_limit_paused', /* ... */ };
    expect(isRateLimitPausedEvent(event)).toBe(true);
  });

  it('rejects other event types', () => {
    const event = { type: 'stream_start', /* ... */ };
    expect(isRateLimitPausedEvent(event)).toBe(false);
  });
});
```

---

## Backward Compatibility

### Changes to Existing Events
- **None**: No changes to existing event schemas

### New Event Types
- `RateLimitPausedEvent`: New event, no backward compatibility concerns
- `RateLimitResumedEvent`: New event, no backward compatibility concerns

### Migration Path
- Existing event consumers unaffected (new events are additive)
- UI can choose to handle new events or ignore them
- No breaking changes to event bus API

---

## Performance Guarantees

1. **Event Size**: Each event <1KB serialized JSON
2. **Emission Latency**: Events emitted within 500ms of trigger
3. **Processing Overhead**: Event validation (Zod) <1ms per event
4. **Memory Footprint**: Event storage in event bus bounded by retention policy (not defined in this contract)

---

## Error Handling

### Invalid Event Data
- **Detection**: Zod schema validation catches invalid events before emission
- **Handling**: Log error, do not emit invalid event
- **Fallback**: Continue execution without event (non-critical)

### Event Bus Failure
- **Detection**: Event bus throws on emit
- **Handling**: Log error, continue pause logic (events are notifications, not critical path)
- **Fallback**: Pause/resume still functions, just no UI updates

---

## Monitoring & Observability

### Recommended Metrics

1. **Pause Frequency**: Count of `RateLimitPausedEvent` per provider per hour
2. **Pause Duration Distribution**: Histogram of `pauseDuration` values
3. **Resume Reason Distribution**: Count by `resumeReason` (timer vs. cancel vs. wake)
4. **Pause Accuracy**: Difference between `pauseDuration` and `actualPauseDuration`

### Example Monitoring Query

```typescript
// Count pauses by provider in last hour
eventBus.query({
  type: 'rate_limit_paused',
  timestamp: { $gte: Date.now() - 3600000 },
})
  .groupBy('provider')
  .count();

// Average pause duration by source
eventBus.query({
  type: 'rate_limit_paused',
})
  .groupBy('durationSource')
  .average('pauseDuration');
```

---

## Future Extensions

### Potential New Events (Out of Scope)
1. `RateLimitApproachingEvent`: Warn before hitting rate limit (proactive)
2. `RateLimitQuotaEvent`: Daily/monthly quota tracking
3. `RateLimitConfigChangedEvent`: Notify when pause config is updated

### Potential Schema Extensions
1. Add `turnId` to link events to specific turn
2. Add `sessionId` for cross-turn rate limit tracking
3. Add `estimatedCost` for pause impact metrics
