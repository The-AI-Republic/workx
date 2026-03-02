/**
 * Unit tests for settingsAllowlist
 *
 * Tests the allowlist data structure, validation functions,
 * and helper functions that form the security boundary for SettingTool.
 */

import { describe, it, expect } from 'vitest';
import {
  SETTINGS_ALLOWLIST,
  getEntry,
  isAllowlisted,
  validateValue,
  getByCategory,
  type AllowlistEntry,
} from '../settingsAllowlist';

describe('settingsAllowlist', () => {
  // ─── SETTINGS_ALLOWLIST constant ─────────────────────────────────

  describe('SETTINGS_ALLOWLIST', () => {
    it('contains entries', () => {
      expect(SETTINGS_ALLOWLIST.length).toBeGreaterThan(0);
    });

    it('has unique keys', () => {
      const keys = SETTINGS_ALLOWLIST.map((e) => e.key);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });

    it('has entries in all expected categories', () => {
      const categories = new Set(SETTINGS_ALLOWLIST.map((e) => e.category));
      expect(categories.has('approval')).toBe(true);
      expect(categories.has('tools')).toBe(true);
      expect(categories.has('general')).toBe(true);
      expect(categories.has('model')).toBe(true);
    });

    it('all entries have required fields', () => {
      for (const entry of SETTINGS_ALLOWLIST) {
        expect(entry.key).toBeTruthy();
        expect(entry.category).toBeTruthy();
        expect(entry.label).toBeTruthy();
        expect(entry.description).toBeTruthy();
        expect(entry.type).toBeTruthy();
        expect(entry.configPath).toBeTruthy();
        expect(['agent_config', 'approval_config']).toContain(entry.storageKey);
      }
    });
  });

  // ─── isAllowlisted ──────────────────────────────────────────────

  describe('isAllowlisted', () => {
    it('returns true for valid keys', () => {
      expect(isAllowlisted('approval.mode')).toBe(true);
      expect(isAllowlisted('tools.dom_tool')).toBe(true);
      expect(isAllowlisted('general.uiTheme')).toBe(true);
      expect(isAllowlisted('model.selection')).toBe(true);
    });

    it('returns false for invalid keys', () => {
      expect(isAllowlisted('providers.openai.apiKey')).toBe(false);
      expect(isAllowlisted('nonexistent')).toBe(false);
      expect(isAllowlisted('')).toBe(false);
    });
  });

  // ─── getEntry ───────────────────────────────────────────────────

  describe('getEntry', () => {
    it('returns entry for existing key', () => {
      const entry = getEntry('approval.mode');
      expect(entry).toBeDefined();
      expect(entry!.key).toBe('approval.mode');
      expect(entry!.category).toBe('approval');
      expect(entry!.type).toBe('string');
    });

    it('returns undefined for missing key', () => {
      expect(getEntry('nonexistent')).toBeUndefined();
    });
  });

  // ─── validateValue ──────────────────────────────────────────────

  describe('validateValue', () => {
    const boolEntry: AllowlistEntry = {
      key: 'tools.dom_tool',
      category: 'tools',
      label: 'DOM Tool',
      description: 'test',
      type: 'boolean',
      allowedValues: [true, false],
      configPath: 'tools.dom_tool',
      storageKey: 'agent_config',
    };

    const stringEntry: AllowlistEntry = {
      key: 'approval.mode',
      category: 'approval',
      label: 'Approval Mode',
      description: 'test',
      type: 'string',
      allowedValues: ['balanced', 'high_speed', 'yolo'],
      configPath: 'mode',
      storageKey: 'approval_config',
    };

    const stringArrayEntry: AllowlistEntry = {
      key: 'approval.trustedDomains',
      category: 'approval',
      label: 'Trusted Domains',
      description: 'test',
      type: 'string[]',
      allowedValues: null,
      configPath: 'trustedDomains',
      storageKey: 'approval_config',
    };

    it('validates correct boolean values', () => {
      expect(validateValue(boolEntry, true)).toEqual({ valid: true });
      expect(validateValue(boolEntry, false)).toEqual({ valid: true });
    });

    it('rejects incorrect types for boolean', () => {
      const result = validateValue(boolEntry, 'true');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Expected boolean');
    });

    it('validates correct string enum values', () => {
      expect(validateValue(stringEntry, 'balanced')).toEqual({ valid: true });
      expect(validateValue(stringEntry, 'yolo')).toEqual({ valid: true });
    });

    it('rejects invalid string enum values', () => {
      const result = validateValue(stringEntry, 'invalid_mode');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('must be one of');
    });

    it('rejects wrong type for string', () => {
      const result = validateValue(stringEntry, 123);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Expected string');
    });

    it('validates string arrays', () => {
      expect(validateValue(stringArrayEntry, ['example.com', 'test.org'])).toEqual({ valid: true });
    });

    it('rejects non-array for string[] type', () => {
      const result = validateValue(stringArrayEntry, 'not-an-array');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('string array');
    });

    it('rejects array with non-string items', () => {
      const result = validateValue(stringArrayEntry, [123, 456]);
      expect(result.valid).toBe(false);
    });
  });

  // ─── getByCategory ─────────────────────────────────────────────

  describe('getByCategory', () => {
    it('returns approval entries', () => {
      const entries = getByCategory('approval');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.category === 'approval')).toBe(true);
    });

    it('returns tools entries', () => {
      const entries = getByCategory('tools');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.category === 'tools')).toBe(true);
    });

    it('returns general entries', () => {
      const entries = getByCategory('general');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.category === 'general')).toBe(true);
    });

    it('returns model entries', () => {
      const entries = getByCategory('model');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e) => e.category === 'model')).toBe(true);
    });
  });
});
