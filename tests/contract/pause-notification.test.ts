/**
 * Contract tests for rate limit pause notification events
 * T011-T012: Verify RateLimitPausedEvent and RateLimitResumedEvent schemas
 */

import { describe, it, expect } from 'vitest';
import type { RateLimitPausedEvent, RateLimitResumedEvent } from '../../src/protocol/events';

describe('RateLimitPausedEvent contract', () => {
  it('should have all required fields with correct types', () => {
    const event: RateLimitPausedEvent = {
      pauseDuration: 60000,
      resumeTime: Date.now() + 60000,
      provider: 'openai',
      durationSource: 'config_default',
      statusCode: 429
    };

    expect(event.pauseDuration).toBeTypeOf('number');
    expect(event.resumeTime).toBeTypeOf('number');
    expect(event.provider).toBeTypeOf('string');
    expect(event.durationSource).toMatch(/^(config_default|retry_after_header)$/);
    expect(event.statusCode).toBe(429);
    expect(event.retryAfterHeader).toBeUndefined();
  });

  it('should support optional retryAfterHeader field', () => {
    const event: RateLimitPausedEvent = {
      pauseDuration: 30000,
      resumeTime: Date.now() + 30000,
      provider: 'anthropic',
      durationSource: 'retry_after_header',
      statusCode: 429,
      retryAfterHeader: 30
    };

    expect(event.retryAfterHeader).toBe(30);
    expect(event.retryAfterHeader).toBeTypeOf('number');
  });

  it('should validate durationSource is one of allowed values', () => {
    const validSources: Array<'config_default' | 'retry_after_header'> = [
      'config_default',
      'retry_after_header'
    ];

    validSources.forEach(source => {
      const event: RateLimitPausedEvent = {
        pauseDuration: 60000,
        resumeTime: Date.now() + 60000,
        provider: 'openai',
        durationSource: source,
        statusCode: 429
      };
      expect(event.durationSource).toBe(source);
    });
  });

  it('should have pauseDuration in milliseconds', () => {
    const event: RateLimitPausedEvent = {
      pauseDuration: 60000, // 60 seconds in ms
      resumeTime: Date.now() + 60000,
      provider: 'openai',
      durationSource: 'config_default',
      statusCode: 429
    };

    expect(event.pauseDuration).toBeGreaterThan(0);
    expect(event.pauseDuration % 1000).toBe(0); // Should be whole seconds
  });

  it('should have resumeTime as unix timestamp in milliseconds', () => {
    const now = Date.now();
    const event: RateLimitPausedEvent = {
      pauseDuration: 60000,
      resumeTime: now + 60000,
      provider: 'openai',
      durationSource: 'config_default',
      statusCode: 429
    };

    expect(event.resumeTime).toBeGreaterThan(now);
    expect(event.resumeTime).toBe(now + event.pauseDuration);
  });
});

describe('RateLimitResumedEvent contract', () => {
  it('should have all required fields with correct types', () => {
    const event: RateLimitResumedEvent = {
      actualPauseDuration: 60000,
      provider: 'openai',
      resumeReason: 'timer_expired'
    };

    expect(event.actualPauseDuration).toBeTypeOf('number');
    expect(event.provider).toBeTypeOf('string');
    expect(event.resumeReason).toMatch(/^(timer_expired|user_cancelled|wake_from_hibernation)$/);
  });

  it('should validate resumeReason is one of allowed values', () => {
    const validReasons: Array<'timer_expired' | 'user_cancelled' | 'wake_from_hibernation'> = [
      'timer_expired',
      'user_cancelled',
      'wake_from_hibernation'
    ];

    validReasons.forEach(reason => {
      const event: RateLimitResumedEvent = {
        actualPauseDuration: 60000,
        provider: 'openai',
        resumeReason: reason
      };
      expect(event.resumeReason).toBe(reason);
    });
  });

  it('should have actualPauseDuration in milliseconds', () => {
    const event: RateLimitResumedEvent = {
      actualPauseDuration: 59800, // May differ slightly from requested
      provider: 'openai',
      resumeReason: 'timer_expired'
    };

    expect(event.actualPauseDuration).toBeGreaterThan(0);
  });

  it('should support all resume reasons', () => {
    // Test timer_expired
    const timerEvent: RateLimitResumedEvent = {
      actualPauseDuration: 60000,
      provider: 'openai',
      resumeReason: 'timer_expired'
    };
    expect(timerEvent.resumeReason).toBe('timer_expired');

    // Test user_cancelled
    const cancelEvent: RateLimitResumedEvent = {
      actualPauseDuration: 30000, // Only half the duration
      provider: 'openai',
      resumeReason: 'user_cancelled'
    };
    expect(cancelEvent.resumeReason).toBe('user_cancelled');

    // Test wake_from_hibernation
    const wakeEvent: RateLimitResumedEvent = {
      actualPauseDuration: 65000, // May be longer due to hibernation
      provider: 'openai',
      resumeReason: 'wake_from_hibernation'
    };
    expect(wakeEvent.resumeReason).toBe('wake_from_hibernation');
  });
});
