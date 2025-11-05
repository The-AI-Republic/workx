/**
 * Unit tests for rate limit pause configuration validation
 * T034-T037: Test config validation rules
 */

import { describe, it, expect } from 'vitest';
import { validateRateLimitPauseConfig, RateLimitPauseConfigSchema } from '../../src/config/validators';
import type { IRateLimitPauseConfig } from '../../src/config/types';

describe('Rate limit pause configuration validation', () => {
  // T034: Valid configuration should pass
  it('should accept valid pause configuration', () => {
    const validConfig: IRateLimitPauseConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(validConfig);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept minimal valid configuration', () => {
    const minimalConfig: IRateLimitPauseConfig = {
      enabled: false,
      defaultDuration: 1000,
      maxDuration: 1000,
      useRetryAfterHeader: false
    };

    const result = validateRateLimitPauseConfig(minimalConfig);
    expect(result.valid).toBe(true);
  });

  it('should accept configuration with defaults applied by Zod', () => {
    const parsed = RateLimitPauseConfigSchema.parse({});

    expect(parsed.enabled).toBe(true);
    expect(parsed.defaultDuration).toBe(60000);
    expect(parsed.maxDuration).toBe(300000);
    expect(parsed.useRetryAfterHeader).toBe(true);
  });

  // T035: Reject negative defaultDuration
  it('should reject negative defaultDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: -1000,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('1 second');
  });

  it('should reject zero defaultDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 0,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  it('should reject defaultDuration less than 1000ms', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 999,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.field).toContain('defaultDuration');
  });

  // T036: Reject defaultDuration > maxDuration
  it('should reject defaultDuration greater than maxDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 400000, // 400 seconds
      maxDuration: 300000,     // 300 seconds (5 minutes)
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('defaultDuration cannot exceed maxDuration');
  });

  it('should accept defaultDuration equal to maxDuration', () => {
    const validConfig = {
      enabled: true,
      defaultDuration: 300000,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(validConfig);
    expect(result.valid).toBe(true);
  });

  it('should reject when defaultDuration is 1ms over maxDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 300001,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  // T037: Reject maxDuration > 600000 (10 minutes)
  it('should reject maxDuration exceeding 10 minutes (600000ms)', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 600001, // Just over 10 minutes
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('10 minutes');
  });

  it('should accept maxDuration exactly at 10 minutes', () => {
    const validConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 600000, // Exactly 10 minutes
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(validConfig);
    expect(result.valid).toBe(true);
  });

  it('should reject maxDuration of 15 minutes', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 900000, // 15 minutes
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  // Additional edge cases
  it('should reject non-integer defaultDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 60000.5,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  it('should reject non-integer maxDuration', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 300000.7,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  it('should reject non-boolean enabled field', () => {
    const invalidConfig = {
      enabled: 'true' as any, // String instead of boolean
      defaultDuration: 60000,
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  it('should reject non-boolean useRetryAfterHeader field', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 60000,
      maxDuration: 300000,
      useRetryAfterHeader: 1 as any // Number instead of boolean
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
  });

  it('should provide helpful error messages', () => {
    const invalidConfig = {
      enabled: true,
      defaultDuration: 500, // Too short
      maxDuration: 300000,
      useRetryAfterHeader: true
    };

    const result = validateRateLimitPauseConfig(invalidConfig);
    expect(result.valid).toBe(false);
    expect(result.field).toBe('rateLimitPause.defaultDuration');
    expect(result.value).toBe(500);
    expect(result.error).toBeDefined();
  });
});
