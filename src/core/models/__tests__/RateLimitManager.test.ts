import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitManager } from '../RateLimitManager.js';

describe('RateLimitManager', () => {
  let rateLimitManager: RateLimitManager;

  beforeEach(() => {
    rateLimitManager = new RateLimitManager({
      approachingThreshold: 80,
      minRetryDelay: 1000,
      maxRetryDelay: 10000,
    });
  });

  describe('Header Parsing', () => {
    it('should parse complete rate limit headers correctly', () => {
      const headers = {
        'x-browserx-primary-used-percent': '75.5',
        'x-browserx-primary-window-minutes': '60',
        'x-browserx-primary-resets-in-seconds': '1800',
        'x-browserx-secondary-used-percent': '45.2',
        'x-browserx-secondary-window-minutes': '1440',
        'x-browserx-secondary-resets-in-seconds': '43200',
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toEqual({
        used_percent: 75.5,
        window_minutes: 60,
        resets_in_seconds: 1800,
      });

      expect(snapshot.secondary).toEqual({
        used_percent: 45.2,
        window_minutes: 1440,
        resets_in_seconds: 43200,
      });
    });

    it('should handle partial headers gracefully', () => {
      const headers = {
        'x-browserx-primary-used-percent': '90.0',
        'x-browserx-secondary-used-percent': '30.0',
        'x-browserx-secondary-window-minutes': '1440',
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toEqual({
        used_percent: 90.0,
        window_minutes: undefined,
        resets_in_seconds: undefined,
      });

      expect(snapshot.secondary).toEqual({
        used_percent: 30.0,
        window_minutes: 1440,
        resets_in_seconds: undefined,
      });
    });

    it('should ignore invalid header values', () => {
      const headers = {
        'x-browserx-primary-used-percent': 'invalid',
        'x-browserx-secondary-used-percent': '50.0',
        'x-browserx-secondary-window-minutes': 'also-invalid',
      };

      const snapshot = rateLimitManager.updateFromHeaders(headers);

      expect(snapshot.primary).toBeUndefined();
      expect(snapshot.secondary).toEqual({
        used_percent: 50.0,
        window_minutes: undefined,
        resets_in_seconds: undefined,
      });
    });
  });

  describe('Retry Logic', () => {
    it('should recommend retry when usage is below threshold', () => {
      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '60.0',
        'x-browserx-primary-resets-in-seconds': '300',
      });

      expect(rateLimitManager.shouldRetry(80)).toBe(true);
    });

    it('should discourage retry when approaching limits', () => {
      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '95.0',
        'x-browserx-primary-resets-in-seconds': '1800',
      });

      expect(rateLimitManager.shouldRetry(80)).toBe(false);
    });

    it('should calculate retry delay from reset time when available', () => {
      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '70.0',
        'x-browserx-primary-resets-in-seconds': '5',
      });

      const delay = rateLimitManager.calculateRetryDelay(1);
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(6000);
    });

    it('should use exponential backoff when no reset time available', () => {
      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '50.0',
      });

      const delay1 = rateLimitManager.calculateRetryDelay(1);
      const delay2 = rateLimitManager.calculateRetryDelay(2);
      const delay3 = rateLimitManager.calculateRetryDelay(3);

      expect(delay2).toBeGreaterThan(delay1);
      expect(delay3).toBeGreaterThan(delay2);
      expect(delay3).toBeLessThanOrEqual(10000);
    });
  });

  describe('History Tracking', () => {
    it('should maintain rate limit history with timestamps', () => {
      const startTime = Date.now();

      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '30.0',
      });

      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '60.0',
      });

      const history = rateLimitManager.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].snapshot.primary?.used_percent).toBe(30.0);
      expect(history[1].snapshot.primary?.used_percent).toBe(60.0);
      expect(history[0].timestamp).toBeGreaterThanOrEqual(startTime);
      expect(history[1].timestamp).toBeGreaterThan(history[0].timestamp);
    });
  });

  describe('Summary Information', () => {
    it('should provide accurate summary of current status', () => {
      rateLimitManager.updateFromHeaders({
        'x-browserx-primary-used-percent': '85.0',
        'x-browserx-primary-resets-in-seconds': '600',
      });

      const summary = rateLimitManager.getSummary();

      expect(summary.hasLimits).toBe(true);
      expect(summary.isApproaching).toBe(true);
      expect(summary.mostRestrictive?.used_percent).toBe(85.0);
      expect(summary.nextResetSeconds).toBe(600);
    });

    it('should handle empty state correctly', () => {
      const summary = rateLimitManager.getSummary();

      expect(summary.hasLimits).toBe(false);
      expect(summary.isApproaching).toBe(false);
      expect(summary.mostRestrictive).toBeNull();
      expect(summary.nextResetSeconds).toBeNull();
    });
  });
});