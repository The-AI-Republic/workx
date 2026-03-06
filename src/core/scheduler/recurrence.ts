/**
 * Recurrence Calculation Utilities
 *
 * Functions for calculating next run times, checking end conditions,
 * and formatting recurrence rules for display.
 */

import type { RecurrenceRule } from '../models/types/Scheduler';

const UNIT_TO_MS: Record<string, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Calculate the next scheduled time based on recurrence rule.
 * Returns null if the recurrence should stop (end condition met).
 */
export function calculateNextRunTime(
  lastScheduledTime: number,
  rule: RecurrenceRule
): number | null {
  // Check end condition first
  if (!shouldContinueRecurrence(rule)) {
    return null;
  }

  let nextTime: number;

  switch (rule.mode) {
    case 'daily':
      nextTime = lastScheduledTime + 24 * 60 * 60 * 1000;
      break;

    case 'weekly':
      nextTime = lastScheduledTime + 7 * 24 * 60 * 60 * 1000;
      break;

    case 'monthly': {
      const date = new Date(lastScheduledTime);
      date.setMonth(date.getMonth() + 1);
      nextTime = date.getTime();
      break;
    }

    case 'custom': {
      const interval = rule.interval || 1;
      const unit = rule.intervalUnit || 'days';
      const ms = UNIT_TO_MS[unit] || UNIT_TO_MS.days;
      nextTime = lastScheduledTime + interval * ms;
      break;
    }

    default:
      return null;
  }

  // Check 'until' end condition against the calculated next time
  if (rule.endCondition === 'until' && rule.endUntilDate && nextTime > rule.endUntilDate) {
    return null;
  }

  return nextTime;
}

/**
 * Check if another occurrence should be created based on the rule's end condition.
 */
export function shouldContinueRecurrence(rule: RecurrenceRule): boolean {
  if (rule.endCondition === 'never') {
    return true;
  }

  if (rule.endCondition === 'after') {
    const completed = rule.completedCount || 0;
    const max = rule.endAfterCount || 1;
    return completed < max;
  }

  if (rule.endCondition === 'until') {
    return Date.now() < (rule.endUntilDate || 0);
  }

  return true;
}

/**
 * Create a new recurrence rule with completedCount incremented by 1.
 */
export function createNextRecurrenceRule(rule: RecurrenceRule): RecurrenceRule {
  return {
    ...rule,
    completedCount: (rule.completedCount || 0) + 1,
  };
}

/**
 * Format a recurrence rule for human-readable display.
 */
export function formatRecurrenceRule(rule: RecurrenceRule): string {
  let base: string;

  switch (rule.mode) {
    case 'daily':
      base = 'Every day';
      break;
    case 'weekly':
      base = 'Every week';
      break;
    case 'monthly':
      base = 'Every month';
      break;
    case 'custom': {
      const interval = rule.interval || 1;
      const unit = rule.intervalUnit || 'days';
      base = interval === 1
        ? `Every ${unit.slice(0, -1)}`
        : `Every ${interval} ${unit}`;
      break;
    }
    default:
      return 'Does not repeat';
  }

  if (rule.endCondition === 'after' && rule.endAfterCount) {
    const completed = rule.completedCount || 0;
    base += `, ${completed} of ${rule.endAfterCount} completed`;
  } else if (rule.endCondition === 'until' && rule.endUntilDate) {
    const date = new Date(rule.endUntilDate);
    base += `, until ${date.toLocaleDateString()}`;
  }

  return base;
}
