# Data Model: Rate Limit Pause Handling

**Branch**: `006-handle-rate-limit-pause` | **Date**: 2025-11-03

## Overview

This document defines the data structures and state models for the rate limit pause handling feature. The model extends existing configuration and state management systems to support pause/resume semantics.

---

## 1. Configuration Model

### 1.1 Rate Limit Pause Configuration

**Location**: `src/config/types.ts` (extends `IProviderConfig`)

```typescript
/**
 * Configuration for rate limit pause behavior
 */
export interface IRateLimitPauseConfig {
  /**
   * Enable/disable pause-instead-of-retry for rate limits
   * @default true
   */
  enabled: boolean;

  /**
   * Default pause duration in milliseconds when no Retry-After header present
   * @default 60000 (60 seconds)
   * @minimum 1000 (1 second)
   * @maximum maxDuration
   */
  defaultDuration: number;

  /**
   * Maximum allowed pause duration in milliseconds (safety cap)
   * @default 300000 (5 minutes)
   * @minimum 1000 (1 second)
   * @maximum 600000 (10 minutes)
   */
  maxDuration: number;

  /**
   * Use Retry-After header from API response if present
   * @default true
   */
  useRetryAfterHeader: boolean;
}

/**
 * Provider configuration (extended)
 */
export interface IProviderConfig {
  // ... existing fields (id, name, apiKey, baseUrl, etc.)

  /**
   * Rate limit pause configuration for this provider
   * Optional - uses defaults if not specified
   */
  rateLimitPause?: IRateLimitPauseConfig;
}
```

**Validation Rules**:
1. `defaultDuration >= 1000 && defaultDuration <= maxDuration`
2. `maxDuration >= 1000 && maxDuration <= 600000`
3. `enabled` must be boolean
4. `useRetryAfterHeader` must be boolean

**Default Values** (in `src/config/defaults.ts`):
```typescript
export const DEFAULT_RATE_LIMIT_PAUSE_CONFIG: IRateLimitPauseConfig = {
  enabled: true,
  defaultDuration: 60000,    // 60 seconds
  maxDuration: 300000,       // 5 minutes
  useRetryAfterHeader: true,
};
```

---

## 2. Pause State Model

### 2.1 Turn Pause State (Runtime)

**Location**: `src/core/TurnManager.ts` (internal state)

```typescript
/**
 * Runtime pause state for active turn execution
 * Tracked in-memory by TurnManager
 */
interface TurnPauseState {
  /**
   * Whether turn is currently paused
   */
  isPaused: boolean;

  /**
   * Reason for pause (currently only 'rate_limit')
   * Extensible for future pause scenarios (quota, manual, etc.)
   */
  pauseReason: 'rate_limit';

  /**
   * Unix timestamp (ms) when pause started
   */
  pauseStartTime: number;

  /**
   * Total pause duration in milliseconds
   */
  pauseDuration: number;

  /**
   * Timer handle for resume callback
   * Can be setTimeout ID or chrome.alarms name
   */
  resumeTimer: number | string | null;

  /**
   * Provider that triggered the rate limit
   */
  provider: string;

  /**
   * Source of pause duration
   */
  durationSource: 'config_default' | 'retry_after_header';
}
```

**State Transitions**:
```
[Active Turn] --rate_limit_429--> [Paused]
[Paused] --timer_expires--> [Resumed]
[Paused] --user_cancel--> [Cancelled]
[Paused] --service_worker_hibernate--> [Persisted to SessionState]
```

---

### 2.2 Persisted Pause State

**Location**: `src/core/session/state/types.ts` (extends `TurnExecutionState`)

```typescript
/**
 * Persisted pause state for recovery after service worker hibernation
 */
export interface PersistedPauseState {
  /**
   * Whether turn is paused
   */
  isPaused: boolean;

  /**
   * Reason for pause
   */
  pauseReason: 'rate_limit';

  /**
   * Unix timestamp (ms) when pause started
   */
  pauseStartTime: number;

  /**
   * Original pause duration requested (ms)
   */
  pauseDuration: number;

  /**
   * Provider that triggered the pause
   */
  provider: string;

  /**
   * Source of pause duration
   */
  durationSource: 'config_default' | 'retry_after_header';
}

/**
 * Turn execution state (extended)
 */
export interface TurnExecutionState {
  // ... existing fields (turnId, status, etc.)

  /**
   * Active pause state (if turn is paused)
   * null if turn is not paused
   */
  pauseState?: PersistedPauseState | null;
}
```

**Persistence Behavior**:
- Saved to IndexedDB when pause begins
- Updated on resume or cancellation
- Loaded on service worker wake to calculate remaining pause time

---

## 3. Event Model

### 3.1 Rate Limit Paused Event

**Location**: `src/protocol/events.ts`

```typescript
/**
 * Event emitted when turn execution pauses due to rate limit
 */
export interface RateLimitPausedEvent {
  /**
   * Event type discriminator
   */
  type: 'rate_limit_paused';

  /**
   * Unique event ID
   */
  id: string;

  /**
   * Timestamp when event was created
   */
  timestamp: number;

  /**
   * Total pause duration in milliseconds
   */
  pauseDuration: number;

  /**
   * Unix timestamp (ms) when turn will resume
   */
  resumeTime: number;

  /**
   * Provider that triggered the rate limit
   */
  provider: string;

  /**
   * Where the pause duration came from
   */
  durationSource: 'config_default' | 'retry_after_header';

  /**
   * HTTP status code that triggered pause (typically 429)
   */
  statusCode: number;

  /**
   * Original Retry-After header value if present (seconds)
   */
  retryAfterHeader?: number;
}
```

---

### 3.2 Rate Limit Resumed Event

**Location**: `src/protocol/events.ts`

```typescript
/**
 * Event emitted when turn execution resumes after rate limit pause
 */
export interface RateLimitResumedEvent {
  /**
   * Event type discriminator
   */
  type: 'rate_limit_resumed';

  /**
   * Unique event ID
   */
  id: string;

  /**
   * Timestamp when event was created
   */
  timestamp: number;

  /**
   * Actual duration paused in milliseconds
   * May differ from requested duration if cancelled early or hibernated
   */
  actualPauseDuration: number;

  /**
   * Provider that was rate limited
   */
  provider: string;

  /**
   * How the resume was triggered
   */
  resumeReason: 'timer_expired' | 'user_cancelled' | 'wake_from_hibernation';
}
```

---

## 4. Error Model Extensions

### 4.1 Rate Limit Error Detection

**Location**: `src/models/ModelClientError.ts` (already exists)

**No changes required** - existing `RateLimitError` class already captures:
- HTTP 429 status code
- Retry-After header value (if present)
- Rate limit metadata

**Usage in TurnManager**:
```typescript
import { ErrorTypeGuards } from '../models/ModelClientError';

if (ErrorTypeGuards.isRateLimitError(error)) {
  // Extract pause duration from error
  const pauseDuration = this.calculatePauseDuration(error);
  await this.pauseForRateLimit(pauseDuration, error);
}
```

---

## 5. Relationships & Dependencies

### Configuration → Pause State
```
IProviderConfig.rateLimitPause
  ↓ (provides defaults)
TurnManager.calculatePauseDuration()
  ↓ (creates)
TurnPauseState
  ↓ (persists to)
PersistedPauseState
```

### Error → Pause → Events
```
API Response (HTTP 429)
  ↓ (throws)
RateLimitError
  ↓ (detected by)
TurnManager.runTurn()
  ↓ (creates)
TurnPauseState
  ↓ (emits)
RateLimitPausedEvent
  ↓ (timer expires)
  ↓ (emits)
RateLimitResumedEvent
```

### State Persistence Flow
```
TurnPauseState (in-memory)
  ↓ (on pause start)
SessionState.save({ pauseState: PersistedPauseState })
  ↓ (persists to)
IndexedDB
  ↓ (on service worker wake)
SessionState.load()
  ↓ (restores to)
TurnManager.resumeFromPersistence()
```

---

## 6. Validation Rules Summary

### Configuration Validation
| Field | Rule | Error Message |
|-------|------|---------------|
| `defaultDuration` | `>= 1000` | "defaultDuration must be at least 1 second (1000ms)" |
| `defaultDuration` | `<= maxDuration` | "defaultDuration cannot exceed maxDuration" |
| `maxDuration` | `>= 1000` | "maxDuration must be at least 1 second (1000ms)" |
| `maxDuration` | `<= 600000` | "maxDuration cannot exceed 10 minutes (600000ms)" |
| `enabled` | `typeof boolean` | "enabled must be a boolean" |
| `useRetryAfterHeader` | `typeof boolean` | "useRetryAfterHeader must be a boolean" |

### Runtime Validation
| Field | Rule | Error Message |
|-------|------|---------------|
| `pauseDuration` | `> 0` | "Pause duration must be positive" |
| `pauseStartTime` | `<= Date.now()` | "Pause start time cannot be in the future" |
| `resumeTime` | `> pauseStartTime` | "Resume time must be after pause start" |

---

## 7. State Invariants

### Turn Pause State Invariants
1. `isPaused === true` ⇒ `resumeTimer !== null`
2. `isPaused === false` ⇒ `resumeTimer === null`
3. `pauseDuration > 0` when `isPaused === true`
4. `pauseStartTime <= Date.now()` (no future timestamps)

### Persistence Invariants
1. If `TurnExecutionState.pauseState` exists, then `pauseState.isPaused === true`
2. `pauseState === null` when turn is not paused
3. On service worker wake: `remainingDuration = max(0, pauseDuration - (now - pauseStartTime))`

### Event Invariants
1. `RateLimitPausedEvent.resumeTime === pauseStartTime + pauseDuration`
2. `RateLimitResumedEvent.actualPauseDuration >= 0`
3. `RateLimitResumedEvent` always follows a `RateLimitPausedEvent` (paired events)

---

## 8. Schema Definitions (Zod)

### Configuration Schema

**Location**: `src/config/validators.ts`

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

export type IRateLimitPauseConfig = z.infer<typeof RateLimitPauseConfigSchema>;
```

### Event Schemas

```typescript
export const RateLimitPausedEventSchema = z.object({
  type: z.literal('rate_limit_paused'),
  id: z.string().uuid(),
  timestamp: z.number().int().positive(),
  pauseDuration: z.number().int().positive(),
  resumeTime: z.number().int().positive(),
  provider: z.string().min(1),
  durationSource: z.enum(['config_default', 'retry_after_header']),
  statusCode: z.number().int().min(400).max(599),
  retryAfterHeader: z.number().int().positive().optional(),
});

export const RateLimitResumedEventSchema = z.object({
  type: z.literal('rate_limit_resumed'),
  id: z.string().uuid(),
  timestamp: z.number().int().positive(),
  actualPauseDuration: z.number().int().nonnegative(),
  provider: z.string().min(1),
  resumeReason: z.enum(['timer_expired', 'user_cancelled', 'wake_from_hibernation']),
});
```

---

## 9. Migration Notes

### Existing Data Compatibility
- **No breaking changes** to existing configuration schema (new fields are optional)
- **Backward compatible**: If `rateLimitPause` is undefined, system uses defaults
- **Existing sessions**: Will not have `pauseState` initially - safe to assume `null`

### Default Behavior
- **Before feature**: HTTP 429 → retry with exponential backoff (up to 3 retries)
- **After feature**: HTTP 429 → pause for 60s (configurable) → single retry after pause
- **Opt-out**: Set `rateLimitPause.enabled = false` to revert to old retry behavior

---

## 10. Test Data Fixtures

### Valid Configuration
```typescript
export const VALID_RATE_LIMIT_CONFIG: IRateLimitPauseConfig = {
  enabled: true,
  defaultDuration: 30000,  // 30 seconds
  maxDuration: 120000,     // 2 minutes
  useRetryAfterHeader: true,
};
```

### Invalid Configuration (for validation tests)
```typescript
export const INVALID_CONFIGS = {
  negativeDuration: { ...VALID_RATE_LIMIT_CONFIG, defaultDuration: -1000 },
  excessiveMax: { ...VALID_RATE_LIMIT_CONFIG, maxDuration: 700000 },
  defaultExceedsMax: { ...VALID_RATE_LIMIT_CONFIG, defaultDuration: 150000, maxDuration: 100000 },
};
```

### Sample Pause State
```typescript
export const SAMPLE_PAUSE_STATE: TurnPauseState = {
  isPaused: true,
  pauseReason: 'rate_limit',
  pauseStartTime: Date.now(),
  pauseDuration: 60000,
  resumeTimer: 'timer-123',
  provider: 'openai',
  durationSource: 'config_default',
};
```

### Sample Events
```typescript
export const SAMPLE_PAUSED_EVENT: RateLimitPausedEvent = {
  type: 'rate_limit_paused',
  id: '550e8400-e29b-41d4-a716-446655440000',
  timestamp: Date.now(),
  pauseDuration: 60000,
  resumeTime: Date.now() + 60000,
  provider: 'openai',
  durationSource: 'retry_after_header',
  statusCode: 429,
  retryAfterHeader: 60,
};
```
