/**
 * Formatter Contract Tests (T018)
 *
 * These tests verify that all formatter utilities conform to their contracts
 * as defined in the specification.
 */

import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatNumber,
  formatTokens,
  formatTime,
  formatCommand,
  formatExitCode,
  truncateOutput,
  formatBytes,
  formatPercent,
  formatDiffSummary,
} from '@/utils/formatters';

describe('Formatter Contract Tests', () => {
  describe('formatDuration', () => {
    it('should format milliseconds correctly', () => {
      expect(formatDuration(45)).toBe('45ms');
      expect(formatDuration(2300)).toBe('2.3s');
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(3600000)).toBe('1h');
      expect(formatDuration(3660000)).toBe('1h 1m');
    });

    it('should handle edge cases', () => {
      expect(formatDuration(0)).toBe('0ms');
      expect(formatDuration(999)).toBe('999ms');
      expect(formatDuration(1000)).toBe('1.0s');
      expect(formatDuration(60000)).toBe('1m');
    });
  });

  describe('formatNumber', () => {
    it('should add thousands separators', () => {
      expect(formatNumber(1234)).toBe('1,234');
      expect(formatNumber(1234567)).toBe('1,234,567');
      expect(formatNumber(42)).toBe('42');
    });

    it('should handle negative numbers', () => {
      expect(formatNumber(-1234)).toBe('-1,234');
      expect(formatNumber(-42)).toBe('-42');
    });

    it('should handle zero', () => {
      expect(formatNumber(0)).toBe('0');
    });
  });

  describe('formatTokens', () => {
    it('should format token counts', () => {
      expect(formatTokens(1234)).toBe('1,234');
      expect(formatTokens(0)).toBe('0');
    });

    it('should handle singular label', () => {
      expect(formatTokens(1, 'token')).toBe('1 token');
    });

    it('should handle plural label', () => {
      expect(formatTokens(2, 'token')).toBe('2 token');
      expect(formatTokens(1234, 'tokens')).toBe('1,234 tokens');
    });
  });

  describe('formatTime', () => {
    it('should show relative time for recent timestamps', () => {
      const now = new Date();
      expect(formatTime(now, 'relative')).toBe('just now');

      const fiveSecondsAgo = new Date(now.getTime() - 5000);
      expect(formatTime(fiveSecondsAgo, 'relative')).toBe('just now');

      const thirtySecondsAgo = new Date(now.getTime() - 30000);
      expect(formatTime(thirtySecondsAgo, 'relative')).toBe('30s ago');

      const fiveMinutesAgo = new Date(now.getTime() - 5 * 60000);
      expect(formatTime(fiveMinutesAgo, 'relative')).toBe('5m ago');

      const twoHoursAgo = new Date(now.getTime() - 2 * 3600000);
      expect(formatTime(twoHoursAgo, 'relative')).toBe('2h ago');
    });

    it('should format absolute time', () => {
      const date = new Date('2025-09-30T14:23:45');
      const result = formatTime(date, 'absolute');
      expect(result).toMatch(/14:23:45/);
    });

    it('should format timestamp', () => {
      const date = new Date('2025-09-30T14:23:45');
      const result = formatTime(date, 'timestamp');
      expect(result).toMatch(/\[2025-09-30T14:23:45\]/);
    });
  });

  describe('formatCommand', () => {
    it('should handle string commands', () => {
      expect(formatCommand('ls -la')).toBe('ls -la');
    });

    it('should handle array commands with escaping', () => {
      const result = formatCommand(['echo', 'hello world']);
      expect(result).toContain('echo');
      expect(result).toContain('hello world');
    });

    it('should escape special characters', () => {
      const result = formatCommand(['echo', '$VAR']);
      expect(result).toContain("'$VAR'");
    });

    it('should truncate long commands', () => {
      const longCommand = 'very long command that exceeds the maximum length';
      const result = formatCommand(longCommand, 20);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result).toContain('...');
    });
  });

  describe('formatExitCode', () => {
    it('should return semantic status', () => {
      expect(formatExitCode(0)).toBe('success');
      expect(formatExitCode(1)).toContain('exited 1');
      expect(formatExitCode(127)).toContain('command not found');
      expect(formatExitCode(130)).toContain('interrupted');
      expect(formatExitCode(137)).toContain('killed');
    });

    it('should handle unknown exit codes', () => {
      expect(formatExitCode(42)).toBe('exited 42');
      expect(formatExitCode(255)).toBe('exited 255');
    });
  });

  describe('truncateOutput', () => {
    it('should limit lines', () => {
      const text = 'line1\nline2\nline3';
      const result = truncateOutput(text, 2);
      expect(result).toContain('line1');
      expect(result).toContain('line2');
      expect(result).toContain('more line');
    });

    it('should not truncate if within limit', () => {
      const text = 'line1\nline2';
      const result = truncateOutput(text, 10);
      expect(result).toBe(text);
    });

    it('should handle single line', () => {
      const text = 'single line';
      const result = truncateOutput(text, 1);
      expect(result).toBe(text);
    });

    it('should show correct count of remaining lines', () => {
      const text = 'line1\nline2\nline3\nline4\nline5';
      const result = truncateOutput(text, 2);
      expect(result).toContain('3 more lines');
    });

    it('should handle singular remaining line', () => {
      const text = 'line1\nline2\nline3';
      const result = truncateOutput(text, 2);
      expect(result).toContain('1 more line');
    });
  });

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(42)).toBe('42 B');
      expect(formatBytes(1234)).toBe('1.2 KB');
      expect(formatBytes(1234567)).toBe('1.2 MB');
      expect(formatBytes(1234567890)).toBe('1.1 GB');
    });

    it('should handle edge cases', () => {
      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(1023)).toBe('1023 B');
      expect(formatBytes(1024)).toBe('1.0 KB');
    });
  });

  describe('formatPercent', () => {
    it('should format percentages', () => {
      expect(formatPercent(0.5)).toBe('50%');
      expect(formatPercent(0.333, 1)).toBe('33.3%');
      expect(formatPercent(1)).toBe('100%');
      expect(formatPercent(0)).toBe('0%');
    });

    it('should clamp to 0-100 range', () => {
      expect(formatPercent(1.5)).toBe('100%');
      expect(formatPercent(-0.5)).toBe('0%');
    });

    it('should handle decimal precision', () => {
      expect(formatPercent(0.12345, 0)).toBe('12%');
      expect(formatPercent(0.12345, 1)).toBe('12.3%');
      expect(formatPercent(0.12345, 2)).toBe('12.35%');
    });
  });

  describe('formatDiffSummary', () => {
    it('should format additions and deletions', () => {
      expect(formatDiffSummary(12, 5)).toBe('+12 -5');
      expect(formatDiffSummary(5, 0)).toBe('+5');
      expect(formatDiffSummary(0, 3)).toBe('-3');
      expect(formatDiffSummary(0, 0)).toBe('no changes');
    });

    it('should handle large numbers', () => {
      expect(formatDiffSummary(1000, 500)).toBe('+1000 -500');
    });
  });

  // Performance tests
  describe('Performance Contract', () => {
    it('formatters should execute in <1ms', () => {
      const start = performance.now();

      // Run each formatter multiple times
      for (let i = 0; i < 100; i++) {
        formatDuration(1234567);
        formatNumber(1234567);
        formatTokens(1234);
        formatCommand('test command');
        formatExitCode(0);
        truncateOutput('line1\nline2\nline3', 2);
        formatBytes(1234567);
        formatPercent(0.5);
        formatDiffSummary(10, 5);
      }

      const duration = performance.now() - start;
      const avgDuration = duration / 100;

      // Each formatter call should average < 1ms
      expect(avgDuration).toBeLessThan(1);
    });
  });
});
