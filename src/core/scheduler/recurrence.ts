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
      const originalDay = date.getDate();
      date.setMonth(date.getMonth() + 1);
      // Clamp to last day of target month if day overflowed (e.g., Jan 31 → Mar 3)
      if (date.getDate() !== originalDay) {
        date.setDate(0); // Sets to last day of previous month (the intended target month)
      }
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

  // Skip forward past current time to avoid cascading past-due jobs
  // (e.g., system was offline for days — don't create one job per missed interval)
  const now = Date.now();
  if (nextTime <= now) {
    if (rule.mode === 'monthly') {
      // Monthly needs date arithmetic (can't just add a fixed ms offset)
      while (nextTime <= now) {
        const date = new Date(nextTime);
        const originalDay = date.getDate();
        date.setMonth(date.getMonth() + 1);
        if (date.getDate() !== originalDay) {
          date.setDate(0);
        }
        nextTime = date.getTime();
      }
    } else {
      // For fixed-interval modes, calculate how many intervals to skip
      let intervalMs: number;
      switch (rule.mode) {
        case 'daily': intervalMs = 24 * 60 * 60 * 1000; break;
        case 'weekly': intervalMs = 7 * 24 * 60 * 60 * 1000; break;
        case 'custom': {
          const interval = rule.interval || 1;
          const unit = rule.intervalUnit || 'days';
          intervalMs = interval * (UNIT_TO_MS[unit] || UNIT_TO_MS.days);
          break;
        }
        default: return null;
      }
      const elapsed = now - nextTime;
      const periodsToSkip = Math.ceil(elapsed / intervalMs);
      nextTime += periodsToSkip * intervalMs;
    }
  }

  // Check 'until' end condition against the calculated next time
  if (rule.endCondition === 'until' && rule.endUntilDate && nextTime > rule.endUntilDate) {
    return null;
  }

  return nextTime;
}

/**
 * Check if another occurrence should be created based on the rule's end condition.
 * Note: 'until' end condition is checked in calculateNextRunTime against the
 * computed next time, not against Date.now(), to avoid prematurely rejecting
 * a valid recurrence when a job completes slightly after the end date.
 */
export function shouldContinueRecurrence(rule: RecurrenceRule): boolean {
  if (rule.endCondition === 'never' || rule.endCondition === 'until') {
    return true;
  }

  if (rule.endCondition === 'after') {
    const completed = rule.completedCount || 0;
    const max = rule.endAfterCount || 1;
    return completed < max;
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

