/**
 * RRULE Adapter
 *
 * Wraps the `rrule` npm package (RFC 5545) to provide:
 * - Conversion from old RecurrenceRule to RRULE string
 * - Human-readable descriptions
 * - Instance expansion over date ranges
 * - Creation from UI-friendly params
 */

import { RRule, type Options as RRuleOptions } from 'rrule';
import type { RecurrenceRule } from '../models/types/Scheduler';

// ============================================================================
// Convert old RecurrenceRule → RRULE string
// ============================================================================

/**
 * Convert the legacy RecurrenceRule format to an RFC 5545 RRULE string.
 * @param rule - Legacy recurrence rule
 * @param dtstart - Start date (Unix ms)
 * @returns RRULE string (e.g., "FREQ=DAILY;INTERVAL=1")
 */
export function recurrenceRuleToRRule(rule: RecurrenceRule, dtstart: number): string {
  const options: Partial<RRuleOptions> = {
    dtstart: new Date(dtstart),
  };

  switch (rule.mode) {
    case 'daily':
      options.freq = RRule.DAILY;
      options.interval = 1;
      break;
    case 'weekly':
      options.freq = RRule.WEEKLY;
      options.interval = 1;
      break;
    case 'monthly':
      options.freq = RRule.MONTHLY;
      options.interval = 1;
      break;
    case 'custom': {
      const interval = rule.interval || 1;
      const unit = rule.intervalUnit || 'days';
      switch (unit) {
        case 'minutes':
          options.freq = RRule.MINUTELY;
          break;
        case 'hours':
          options.freq = RRule.HOURLY;
          break;
        case 'days':
          options.freq = RRule.DAILY;
          break;
        case 'weeks':
          options.freq = RRule.WEEKLY;
          break;
      }
      options.interval = interval;
      break;
    }
  }

  // End conditions
  if (rule.endCondition === 'after' && rule.endAfterCount) {
    options.count = rule.endAfterCount;
  } else if (rule.endCondition === 'until' && rule.endUntilDate) {
    options.until = new Date(rule.endUntilDate);
  }

  const rrule = new RRule(options as RRuleOptions);
  return rrule.toString().replace('RRULE:', '');
}

// ============================================================================
// RRULE string → human-readable description
// ============================================================================

/**
 * Convert an RRULE string to a human-readable description.
 * @param rruleString - RFC 5545 RRULE string
 * @param dtstart - Start date (Unix ms) for context
 * @returns Human-readable text (e.g., "Every day", "Every 2 weeks")
 */
export function rruleToDescription(rruleString: string, dtstart: number): string {
  try {
    const options = RRule.parseString(`RRULE:${rruleString}`);
    options.dtstart = new Date(dtstart);
    const rrule = new RRule(options);
    return rrule.toText();
  } catch {
    return rruleString;
  }
}

// ============================================================================
// Expand instances over a date range
// ============================================================================

/**
 * Expand an RRULE to concrete instance dates within a range.
 * @param rruleString - RFC 5545 RRULE string
 * @param dtstart - Series start time (Unix ms)
 * @param rangeStart - Range start (Unix ms, inclusive)
 * @param rangeEnd - Range end (Unix ms, exclusive)
 * @param exdates - Excluded instance times (Unix ms)
 * @returns Array of instance times (Unix ms)
 */
export function expandInstances(
  rruleString: string,
  dtstart: number,
  rangeStart: number,
  rangeEnd: number,
  exdates: number[] = []
): number[] {
  try {
    const options = RRule.parseString(`RRULE:${rruleString}`);
    options.dtstart = new Date(dtstart);
    const rrule = new RRule(options);

    const instances = rrule.between(
      new Date(rangeStart),
      new Date(rangeEnd),
      true // inclusive
    );

    // Normalize exdates to minute-level to handle rrule library timestamp jitter
    const normalizeToMinute = (t: number) => Math.floor(t / 60000) * 60000;
    const exdateSet = new Set(exdates.map(normalizeToMinute));

    return instances
      .map(d => d.getTime())
      .filter(t => !exdateSet.has(normalizeToMinute(t)));
  } catch (error) {
    console.warn('[rruleAdapter] Failed to expand instances:', error);
    return [];
  }
}

/**
 * Get the next occurrence after a given time.
 * @param rruleString - RFC 5545 RRULE string
 * @param dtstart - Series start time (Unix ms)
 * @param afterTime - Find the next instance after this time (Unix ms)
 * @param exdates - Excluded instance times (Unix ms)
 * @returns Next instance time (Unix ms), or null if no more
 */
export function getNextInstance(
  rruleString: string,
  dtstart: number,
  afterTime: number,
  exdates: number[] = []
): number | null {
  try {
    const options = RRule.parseString(`RRULE:${rruleString}`);
    options.dtstart = new Date(dtstart);
    const rrule = new RRule(options);

    // Normalize exdates to minute-level to handle rrule library timestamp jitter
    const normalizeToMinute = (t: number) => Math.floor(t / 60000) * 60000;
    const exdateSet = new Set(exdates.map(normalizeToMinute));

    // Search a reasonable window (up to 1 year ahead, checking in chunks)
    const chunkMs = 90 * 24 * 60 * 60 * 1000; // 90 days
    let searchStart = afterTime;
    const maxSearch = afterTime + 365 * 24 * 60 * 60 * 1000;

    while (searchStart < maxSearch) {
      const searchEnd = Math.min(searchStart + chunkMs, maxSearch);
      const instances = rrule.between(
        new Date(searchStart),
        new Date(searchEnd),
        false // exclusive start to skip afterTime itself
      );

      for (const inst of instances) {
        const t = inst.getTime();
        if (t > afterTime && !exdateSet.has(normalizeToMinute(t))) {
          return t;
        }
      }

      searchStart = searchEnd;
    }

    return null;
  } catch (error) {
    console.warn('[rruleAdapter] Failed to get next instance:', error);
    return null;
  }
}

// ============================================================================
// Create RRULE from UI params
// ============================================================================

export interface CreateRRuleParams {
  freq: 'minutely' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  interval?: number;
  count?: number;
  until?: number; // Unix ms
}

/**
 * Create an RRULE string from UI-friendly parameters.
 * @param params - Frequency, interval, count, until
 * @returns RRULE string (without RRULE: prefix)
 */
export function createRRule(params: CreateRRuleParams): string {
  const freqMap: Record<string, number> = {
    minutely: RRule.MINUTELY,
    hourly: RRule.HOURLY,
    daily: RRule.DAILY,
    weekly: RRule.WEEKLY,
    monthly: RRule.MONTHLY,
  };

  const options: Partial<RRuleOptions> = {
    freq: freqMap[params.freq],
    interval: params.interval || 1,
  };

  if (params.count) {
    options.count = params.count;
  } else if (params.until) {
    options.until = new Date(params.until);
  }

  const rrule = new RRule(options as RRuleOptions);
  return rrule.toString().replace('RRULE:', '');
}
