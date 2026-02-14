/**
 * Unit tests for helper functions
 * Tests: T005
 * Target: src/storage/rollout/helpers.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  calculateExpiresAt,
  isExpired,
  getDefaultTTL,
  serializeCursor,
  deserializeCursor,
  formatTimestamp,
  getCurrentTimestamp,
  isValidUUID,
  isValidConversationId,
  createInvalidIdError,
  createRolloutNotFoundError,
  createDatabaseError,
} from '@/storage/rollout/helpers';
import type { IAgentConfigWithStorage, Cursor } from '@/storage/rollout/types';

describe('TTL Calculations', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-01T12:00:00.000Z'));
  });

  describe('getDefaultTTL', () => {
    it('should return 60 days in milliseconds', () => {
      const expected = 60 * 24 * 60 * 60 * 1000; // 60 days
      expect(getDefaultTTL()).toBe(expected);
      expect(getDefaultTTL()).toBe(5184000000); // 60 days = 5,184,000,000 ms
    });
  });

  describe('calculateExpiresAt', () => {
    it('should return undefined for permanent storage', () => {
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 'permanent' },
      };
      expect(calculateExpiresAt(config)).toBeUndefined();
    });

    it('should return undefined when no config provided', () => {
      expect(calculateExpiresAt(undefined)).toBeUndefined();
    });

    it('should return undefined when storage config is missing', () => {
      const config: IAgentConfigWithStorage = {};
      expect(calculateExpiresAt(config)).toBeUndefined();
    });

    it('should calculate expiration for 60 days (default)', () => {
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 60 },
      };
      const now = Date.now();
      const expected = now + 60 * 24 * 60 * 60 * 1000;
      expect(calculateExpiresAt(config)).toBe(expected);
    });

    it('should calculate expiration for 30 days', () => {
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 30 },
      };
      const now = Date.now();
      const expected = now + 30 * 24 * 60 * 60 * 1000;
      expect(calculateExpiresAt(config)).toBe(expected);
    });

    it('should calculate expiration for 7 days', () => {
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 7 },
      };
      const now = Date.now();
      const expected = now + 7 * 24 * 60 * 60 * 1000;
      expect(calculateExpiresAt(config)).toBe(expected);
    });

    it('should calculate expiration for 90 days', () => {
      const config: IAgentConfigWithStorage = {
        storage: { rolloutTTL: 90 },
      };
      const now = Date.now();
      const expected = now + 90 * 24 * 60 * 60 * 1000;
      expect(calculateExpiresAt(config)).toBe(expected);
    });
  });

  describe('isExpired', () => {
    it('should return false for permanent rollouts (undefined)', () => {
      expect(isExpired(undefined)).toBe(false);
    });

    it('should return false for future timestamps', () => {
      const future = Date.now() + 1000000;
      expect(isExpired(future)).toBe(false);
    });

    it('should return true for past timestamps', () => {
      const past = Date.now() - 1000000;
      expect(isExpired(past)).toBe(true);
    });

    it('should return true for current timestamp (edge case)', () => {
      const now = Date.now();
      vi.advanceTimersByTime(1); // Move time forward by 1ms
      expect(isExpired(now)).toBe(true);
    });

    it('should return false for exact current timestamp', () => {
      const now = Date.now();
      expect(isExpired(now)).toBe(false);
    });
  });
});

describe('Cursor Serialization', () => {
  describe('serializeCursor', () => {
    it('should serialize cursor to "timestamp|uuid" format', () => {
      const cursor: Cursor = {
        timestamp: 1696176000000,
        id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
      };
      expect(serializeCursor(cursor)).toBe('1696176000000|5973b6c0-94b8-487b-a530-2aeb6098ae0e');
    });

    it('should handle different timestamps', () => {
      const cursor: Cursor = {
        timestamp: 1234567890,
        id: '12345678-1234-1234-1234-123456789012',
      };
      expect(serializeCursor(cursor)).toBe('1234567890|12345678-1234-1234-1234-123456789012');
    });
  });

  describe('deserializeCursor', () => {
    it('should deserialize valid cursor string', () => {
      const token = '1696176000000|5973b6c0-94b8-487b-a530-2aeb6098ae0e';
      const cursor = deserializeCursor(token);
      expect(cursor).toEqual({
        timestamp: 1696176000000,
        id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
      });
    });

    it('should return null for invalid format (no pipe)', () => {
      expect(deserializeCursor('invalid')).toBeNull();
    });

    it('should return null for invalid format (too many parts)', () => {
      expect(deserializeCursor('123|abc|def')).toBeNull();
    });

    it('should return null for non-numeric timestamp', () => {
      expect(deserializeCursor('abc|5973b6c0-94b8-487b-a530-2aeb6098ae0e')).toBeNull();
    });

    it('should return null for invalid UUID format', () => {
      expect(deserializeCursor('1696176000000|not-a-uuid')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(deserializeCursor('')).toBeNull();
    });

    it('should validate UUID format (8-4-4-4-12)', () => {
      // Valid UUID
      expect(deserializeCursor('123|12345678-1234-1234-1234-123456789012')).not.toBeNull();
      // Invalid UUID (wrong segment lengths)
      expect(deserializeCursor('123|123-1234-1234-1234-123456789012')).toBeNull();
    });
  });

  describe('round-trip serialization', () => {
    it('should serialize and deserialize correctly', () => {
      const original: Cursor = {
        timestamp: 1696176000000,
        id: '5973b6c0-94b8-487b-a530-2aeb6098ae0e',
      };
      const serialized = serializeCursor(original);
      const deserialized = deserializeCursor(serialized);
      expect(deserialized).toEqual(original);
    });
  });
});

describe('Timestamp Formatting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-01T12:00:00.123Z'));
  });

  describe('formatTimestamp', () => {
    it('should format date to ISO 8601 with milliseconds', () => {
      const date = new Date('2025-10-01T12:00:00.123Z');
      expect(formatTimestamp(date)).toBe('2025-10-01T12:00:00.123Z');
    });

    it('should use current time if no date provided', () => {
      expect(formatTimestamp()).toBe('2025-10-01T12:00:00.123Z');
    });

    it('should preserve milliseconds', () => {
      const date = new Date('2025-10-01T12:00:00.999Z');
      expect(formatTimestamp(date)).toBe('2025-10-01T12:00:00.999Z');
    });
  });

  describe('getCurrentTimestamp', () => {
    it('should return current timestamp in ISO 8601 format', () => {
      expect(getCurrentTimestamp()).toBe('2025-10-01T12:00:00.123Z');
    });

    it('should return different values as time advances', () => {
      const first = getCurrentTimestamp();
      vi.advanceTimersByTime(1000);
      const second = getCurrentTimestamp();
      expect(first).not.toBe(second);
    });
  });
});

describe('UUID Validation', () => {
  describe('isValidUUID', () => {
    it('should validate correct UUID v4', () => {
      expect(isValidUUID('5973b6c0-94b8-4f7b-a530-2aeb6098ae0e')).toBe(true);
    });

    it('should reject invalid format', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('12345678-1234-1234-1234-1234567890')).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });

    it('should require version 4 UUID', () => {
      // Valid v4 (4 in 3rd segment)
      expect(isValidUUID('12345678-1234-4234-8234-123456789012')).toBe(true);
      // Invalid v4 (wrong version digit)
      expect(isValidUUID('12345678-1234-1234-8234-123456789012')).toBe(false);
    });

    it('should validate variant field (8, 9, a, or b in 4th segment)', () => {
      expect(isValidUUID('12345678-1234-4234-8234-123456789012')).toBe(true);
      expect(isValidUUID('12345678-1234-4234-9234-123456789012')).toBe(true);
      expect(isValidUUID('12345678-1234-4234-a234-123456789012')).toBe(true);
      expect(isValidUUID('12345678-1234-4234-b234-123456789012')).toBe(true);
      // Invalid variant
      expect(isValidUUID('12345678-1234-4234-c234-123456789012')).toBe(false);
    });
  });

  describe('isValidConversationId', () => {
    it('should validate conversation ID as UUID', () => {
      expect(isValidConversationId('5973b6c0-94b8-4f7b-a530-2aeb6098ae0e')).toBe(true);
      expect(isValidConversationId('not-a-uuid')).toBe(false);
    });
  });
});

describe('Error Helpers', () => {
  describe('createInvalidIdError', () => {
    it('should create error with conversation ID', () => {
      const error = createInvalidIdError('bad-id');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain('Invalid conversation ID: bad-id');
      expect(error.message).toContain('Must be a valid UUID');
    });
  });

  describe('createRolloutNotFoundError', () => {
    it('should create error with rollout ID', () => {
      const error = createRolloutNotFoundError('missing-id');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Rollout not found: missing-id');
    });
  });

  describe('createDatabaseError', () => {
    it('should create error with operation and reason', () => {
      const error = createDatabaseError('write', 'quota exceeded');
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe('Database operation failed [write]: quota exceeded');
    });

    it('should format operation name', () => {
      const error = createDatabaseError('listConversations', 'connection failed');
      expect(error.message).toContain('[listConversations]');
      expect(error.message).toContain('connection failed');
    });
  });
});
