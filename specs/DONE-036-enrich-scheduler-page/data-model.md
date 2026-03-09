# Data Model: Enrich Scheduler Page

## New Types

### RecurrenceRule

Defines a repeat/recurrence configuration for scheduled jobs.

```typescript
export type RecurrenceMode = 'daily' | 'weekly' | 'monthly' | 'custom';
export type RecurrenceIntervalUnit = 'minutes' | 'hours' | 'days' | 'weeks';
export type RecurrenceEndCondition = 'never' | 'after' | 'until';

export interface RecurrenceRule {
  /** Repeat frequency type */
  mode: RecurrenceMode;

  /** Custom interval value (e.g., every 2). Only used when mode is 'custom'. */
  interval?: number;

  /** Custom interval unit. Only used when mode is 'custom'. */
  intervalUnit?: RecurrenceIntervalUnit;

  /** When the recurrence stops */
  endCondition: RecurrenceEndCondition;

  /** Total number of occurrences allowed. Only used when endCondition is 'after'. */
  endAfterCount?: number;

  /** Unix timestamp (ms) of the end date. Only used when endCondition is 'until'. */
  endUntilDate?: number;

  /** Number of occurrences completed so far. Incremented on each completion/failure. */
  completedCount?: number;

  /** ID of the original job that started this recurrence chain. */
  parentJobId?: string;
}
```

### Extended SchedulerJobRecord

```typescript
export interface SchedulerJobRecord {
  // ... existing fields unchanged ...

  /** Optional recurrence rule for repeat jobs. Null or undefined = one-time job. */
  recurrence?: RecurrenceRule | null;
}
```

### JobHistoryFilter (client-side only, not persisted)

```typescript
export interface JobHistoryFilter {
  /** Search query for fuzzy matching on job input */
  searchQuery: string;

  /** Sort direction for completedAt */
  sortDirection: 'newest' | 'oldest';

  /** Set of statuses to include. Default: all archived statuses */
  selectedStatuses: Set<'completed' | 'failed' | 'cancelled'>;
}
```

## Storage Changes

### IndexedDB

No schema migration needed. The `recurrence` field is optional and simply appended to `SchedulerJobRecord` objects when present. Existing records without it are treated as one-time jobs (`recurrence === undefined`).

### chrome.storage.local

No changes to `SchedulerState`.

## Message Payload Extensions

### GetArchivedJobsRequest (extended)

```typescript
export interface GetArchivedJobsRequest {
  limit?: number;
  offset?: number;
  sortDirection?: 'newest' | 'oldest';   // NEW
  statusFilter?: SchedulerJobStatus[];    // NEW
}
```

### ScheduleJobRequest (extended)

```typescript
export interface ScheduleJobRequest {
  input?: string;
  jobId?: string;
  scheduledTime: number;
  recurrence?: RecurrenceRule;  // NEW
}
```

### ArchivedJobSummary (extended)

```typescript
export interface ArchivedJobSummary {
  // ... existing fields ...
  recurrence?: RecurrenceRule | null;  // NEW: show recurrence info in history
}
```

## Recurrence Calculation

### Next Run Time Algorithm

```
function calculateNextRunTime(lastScheduledTime: number, rule: RecurrenceRule): number | null
```

| Mode | Calculation |
|------|-------------|
| daily | lastScheduledTime + 24h |
| weekly | lastScheduledTime + 7d |
| monthly | Same day next month (using Date arithmetic) |
| custom | lastScheduledTime + (interval * unitToMs(intervalUnit)) |

Returns `null` if:
- `endCondition === 'after'` and `completedCount >= endAfterCount`
- `endCondition === 'until'` and next time > `endUntilDate`

### Recurrence Chain

Each new job in a recurrence chain:
- Copies `input` from the parent
- Gets a new `id` (UUID v4)
- Sets `scheduledTime` to the calculated next run time
- Sets `status` to `'scheduled'`
- Carries forward the `recurrence` rule with `completedCount` incremented
- Sets `parentJobId` to the original job's ID (or inherits from parent)
