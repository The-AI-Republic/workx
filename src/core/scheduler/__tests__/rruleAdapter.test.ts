/**
 * Tests for rruleAdapter
 *
 * Tests RRULE conversion, expansion, and creation utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  recurrenceRuleToRRule,
  rruleToDescription,
  expandInstances,
  getNextInstance,
  createRRule,
} from '../rruleAdapter';
import type { RecurrenceRule } from '../../models/types/Scheduler';

describe('rruleAdapter', () => {
  describe('recurrenceRuleToRRule', () => {
    it('should convert daily recurrence', () => {
      const rule: RecurrenceRule = { mode: 'daily', endCondition: 'never' };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('FREQ=DAILY');
      expect(result).toContain('INTERVAL=1');
    });

    it('should convert weekly recurrence', () => {
      const rule: RecurrenceRule = { mode: 'weekly', endCondition: 'never' };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('FREQ=WEEKLY');
    });

    it('should convert monthly recurrence', () => {
      const rule: RecurrenceRule = { mode: 'monthly', endCondition: 'never' };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('FREQ=MONTHLY');
    });

    it('should convert custom recurrence with minutes', () => {
      const rule: RecurrenceRule = {
        mode: 'custom',
        interval: 30,
        intervalUnit: 'minutes',
        endCondition: 'never',
      };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('FREQ=MINUTELY');
      expect(result).toContain('INTERVAL=30');
    });

    it('should include COUNT for after end condition', () => {
      const rule: RecurrenceRule = {
        mode: 'daily',
        endCondition: 'after',
        endAfterCount: 5,
      };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('COUNT=5');
    });

    it('should include UNTIL for until end condition', () => {
      const rule: RecurrenceRule = {
        mode: 'daily',
        endCondition: 'until',
        endUntilDate: new Date('2026-12-31').getTime(),
      };
      const result = recurrenceRuleToRRule(rule, Date.now());
      expect(result).toContain('UNTIL=');
    });
  });

  describe('rruleToDescription', () => {
    it('should describe a daily rule', () => {
      const desc = rruleToDescription('FREQ=DAILY;INTERVAL=1', Date.now());
      expect(desc.toLowerCase()).toContain('day');
    });

    it('should describe a weekly rule', () => {
      const desc = rruleToDescription('FREQ=WEEKLY;INTERVAL=1', Date.now());
      expect(desc.toLowerCase()).toContain('week');
    });

    it('should return raw string for invalid RRULE', () => {
      const result = rruleToDescription('INVALID_RULE', Date.now());
      expect(result).toBe('INVALID_RULE');
    });
  });

  describe('expandInstances', () => {
    it('should expand daily instances over a week', () => {
      const dtstart = new Date('2026-01-01T09:00:00Z').getTime();
      const rangeStart = dtstart;
      const rangeEnd = new Date('2026-01-08T09:00:00Z').getTime();

      const instances = expandInstances(
        'FREQ=DAILY;INTERVAL=1',
        dtstart,
        rangeStart,
        rangeEnd
      );

      // Should have multiple daily instances
      expect(instances.length).toBeGreaterThanOrEqual(7);
    });

    it('should exclude exdates', () => {
      const dtstart = new Date('2026-01-01T09:00:00Z').getTime();
      const rangeStart = dtstart;
      const rangeEnd = new Date('2026-01-08T09:00:00Z').getTime();

      // Get all instances first
      const allInstances = expandInstances(
        'FREQ=DAILY;INTERVAL=1',
        dtstart,
        rangeStart,
        rangeEnd
      );

      // Exclude the third instance
      const exdate = allInstances[2];
      const filtered = expandInstances(
        'FREQ=DAILY;INTERVAL=1',
        dtstart,
        rangeStart,
        rangeEnd,
        [exdate]
      );

      expect(filtered.length).toBe(allInstances.length - 1);
      expect(filtered).not.toContain(exdate);
    });

    it('should return empty for invalid RRULE', () => {
      const instances = expandInstances('INVALID', Date.now(), 0, Date.now() + 86400000);
      expect(instances).toEqual([]);
    });
  });

  describe('getNextInstance', () => {
    it('should find the next daily instance', () => {
      const dtstart = new Date('2026-01-01T09:00:00Z').getTime();
      const afterTime = new Date('2026-01-03T10:00:00Z').getTime();

      const next = getNextInstance('FREQ=DAILY;INTERVAL=1', dtstart, afterTime);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getUTCDate()).toBe(4);
    });

    it('should skip exdates', () => {
      const dtstart = new Date('2026-01-01T09:00:00Z').getTime();
      const afterTime = new Date('2026-01-02T10:00:00Z').getTime();
      const jan3 = new Date('2026-01-03T09:00:00Z').getTime();

      const next = getNextInstance('FREQ=DAILY;INTERVAL=1', dtstart, afterTime, [jan3]);

      expect(next).not.toBeNull();
      const nextDate = new Date(next!);
      expect(nextDate.getUTCDate()).toBe(4);
    });

    it('should return null for invalid RRULE', () => {
      const result = getNextInstance('INVALID', Date.now(), Date.now());
      expect(result).toBeNull();
    });
  });

  describe('createRRule', () => {
    it('should create a daily RRULE', () => {
      const result = createRRule({ freq: 'daily', interval: 1 });
      expect(result).toContain('FREQ=DAILY');
    });

    it('should create with count', () => {
      const result = createRRule({ freq: 'weekly', count: 10 });
      expect(result).toContain('COUNT=10');
    });

    it('should create with until', () => {
      const until = new Date('2026-12-31').getTime();
      const result = createRRule({ freq: 'monthly', until });
      expect(result).toContain('UNTIL=');
    });

    it('should create with custom interval', () => {
      const result = createRRule({ freq: 'hourly', interval: 4 });
      expect(result).toContain('FREQ=HOURLY');
      expect(result).toContain('INTERVAL=4');
    });
  });
});
