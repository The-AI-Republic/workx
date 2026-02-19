/**
 * Comprehensive unit tests for ApprovalConfigStorage and defaultRules.
 *
 * Covers storage CRUD operations, debounced history writes, error handling,
 * default config merging, and default policy rule data for both platforms.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalConfigStorage } from '../ApprovalConfigStorage';
import { getDefaultRules } from '../defaultRules';
import { DEFAULT_APPROVAL_CONFIG, RiskLevel } from '../types';
import type { ApprovalHistoryEntry, IApprovalConfig, PolicyRule } from '../types';
import { STORAGE_KEYS } from '../../../config/defaults';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockStorage(initialData: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initialData };
  return {
    get: vi.fn(async (keys: string[]) => {
      const result: Record<string, any> = {};
      for (const key of keys) {
        if (store[key] !== undefined) result[key] = store[key];
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, any>) => {
      Object.assign(store, items);
    }),
    _store: store,
  };
}

function makeHistoryEntry(overrides: Partial<ApprovalHistoryEntry> = {}): ApprovalHistoryEntry {
  return {
    timestamp: Date.now(),
    toolName: 'test_tool',
    riskScore: 25,
    riskLevel: RiskLevel.Low,
    decision: 'auto_approve',
    source: 'auto',
    factors: ['test factor'],
    ...overrides,
  };
}

// ===========================================================================
// ApprovalConfigStorage
// ===========================================================================

describe('ApprovalConfigStorage', () => {
  let mockStorage: ReturnType<typeof createMockStorage>;
  let storage: ApprovalConfigStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
    storage = new ApprovalConfigStorage(() => mockStorage);
  });

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('should accept a storage getter function', () => {
      const getter = vi.fn(() => mockStorage);
      const instance = new ApprovalConfigStorage(getter);
      expect(instance).toBeInstanceOf(ApprovalConfigStorage);
    });

    it('should not call the storage getter during construction', () => {
      const getter = vi.fn(() => mockStorage);
      new ApprovalConfigStorage(getter);
      expect(getter).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // loadConfig
  // -----------------------------------------------------------------------

  describe('loadConfig', () => {
    it('should return a copy of DEFAULT_APPROVAL_CONFIG when storage is empty', async () => {
      const config = await storage.loadConfig();
      expect(config).toEqual(DEFAULT_APPROVAL_CONFIG);
      // Must be a copy, not the same reference
      expect(config).not.toBe(DEFAULT_APPROVAL_CONFIG);
    });

    it('should call the storage getter to obtain the storage adapter', async () => {
      const getter = vi.fn(() => mockStorage);
      const instance = new ApprovalConfigStorage(getter);
      await instance.loadConfig();
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it('should read the correct storage key', async () => {
      await storage.loadConfig();
      expect(mockStorage.get).toHaveBeenCalledWith([STORAGE_KEYS.APPROVAL_CONFIG]);
    });

    it('should merge stored mode with defaults', async () => {
      mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG] = { mode: 'yolo' };
      const config = await storage.loadConfig();
      expect(config.mode).toBe('yolo');
      expect(config.version).toBe(DEFAULT_APPROVAL_CONFIG.version);
      expect(config.userRules).toEqual(DEFAULT_APPROVAL_CONFIG.userRules);
      expect(config.trustedDomains).toEqual(DEFAULT_APPROVAL_CONFIG.trustedDomains);
      expect(config.blockedDomains).toEqual(DEFAULT_APPROVAL_CONFIG.blockedDomains);
    });

    it('should deep-merge timeouts: stored overrides + default fallbacks', async () => {
      mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG] = {
        timeouts: { low: 999, high: 888 },
      };
      const config = await storage.loadConfig();
      expect(config.timeouts.low).toBe(999);
      expect(config.timeouts.high).toBe(888);
      expect(config.timeouts.medium).toBe(DEFAULT_APPROVAL_CONFIG.timeouts.medium);
      expect(config.timeouts.critical).toBe(DEFAULT_APPROVAL_CONFIG.timeouts.critical);
    });

    it('should use default timeouts when stored config has no timeouts key', async () => {
      mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG] = { mode: 'balanced' };
      const config = await storage.loadConfig();
      expect(config.timeouts).toEqual(DEFAULT_APPROVAL_CONFIG.timeouts);
    });

    it('should preserve stored userRules array', async () => {
      const customRule: PolicyRule = {
        type: 'deny',
        match: { tool: 'dangerous_tool' },
        description: 'block it',
      };
      mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG] = { userRules: [customRule] };
      const config = await storage.loadConfig();
      expect(config.userRules).toHaveLength(1);
      expect(config.userRules[0].match.tool).toBe('dangerous_tool');
    });

    it('should preserve stored trustedDomains and blockedDomains', async () => {
      mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG] = {
        trustedDomains: ['safe.com'],
        blockedDomains: ['evil.com'],
      };
      const config = await storage.loadConfig();
      expect(config.trustedDomains).toEqual(['safe.com']);
      expect(config.blockedDomains).toEqual(['evil.com']);
    });

    it('should return defaults when storage.get throws an error', async () => {
      const errStorage = {
        get: vi.fn(async () => { throw new Error('storage failure'); }),
        set: vi.fn(),
      };
      const errInstance = new ApprovalConfigStorage(() => errStorage);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const config = await errInstance.loadConfig();
      expect(config).toEqual(DEFAULT_APPROVAL_CONFIG);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // saveConfig
  // -----------------------------------------------------------------------

  describe('saveConfig', () => {
    it('should save the provided config to the correct storage key', async () => {
      const config: IApprovalConfig = {
        ...DEFAULT_APPROVAL_CONFIG,
        mode: 'high_speed',
      };
      await storage.saveConfig(config);
      expect(mockStorage.set).toHaveBeenCalledWith({
        [STORAGE_KEYS.APPROVAL_CONFIG]: config,
      });
    });

    it('should propagate errors from storage.set', async () => {
      const errStorage = {
        get: vi.fn(),
        set: vi.fn(async () => { throw new Error('write failure'); }),
      };
      const errInstance = new ApprovalConfigStorage(() => errStorage);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(errInstance.saveConfig(DEFAULT_APPROVAL_CONFIG)).rejects.toThrow('write failure');
      consoleSpy.mockRestore();
    });

    it('should save full config including all fields', async () => {
      const fullConfig: IApprovalConfig = {
        version: '1.0.0',
        mode: 'yolo',
        userRules: [{ type: 'allow', match: { tool: 'x' }, description: 'y' }],
        trustedDomains: ['a.com'],
        blockedDomains: ['b.com'],
        timeouts: { low: 1, medium: 2, high: 3, critical: 4 },
      };
      await storage.saveConfig(fullConfig);
      expect(mockStorage._store[STORAGE_KEYS.APPROVAL_CONFIG]).toEqual(fullConfig);
    });
  });

  // -----------------------------------------------------------------------
  // loadHistory
  // -----------------------------------------------------------------------

  describe('loadHistory', () => {
    it('should return an empty array when no history in storage', async () => {
      const history = await storage.loadHistory();
      expect(history).toEqual([]);
    });

    it('should read from the correct storage key', async () => {
      await storage.loadHistory();
      expect(mockStorage.get).toHaveBeenCalledWith([STORAGE_KEYS.APPROVAL_HISTORY]);
    });

    it('should return all entries when no limit is provided', async () => {
      const entries = Array.from({ length: 5 }, (_, i) =>
        makeHistoryEntry({ timestamp: i })
      );
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = entries;
      const result = await storage.loadHistory();
      expect(result).toHaveLength(5);
    });

    it('should return the last N entries when limit is provided', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        makeHistoryEntry({ timestamp: i, toolName: `tool_${i}` })
      );
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = entries;
      const result = await storage.loadHistory(3);
      expect(result).toHaveLength(3);
      expect(result[0].toolName).toBe('tool_7');
      expect(result[2].toolName).toBe('tool_9');
    });

    it('should return all entries when limit exceeds total count', async () => {
      const entries = [makeHistoryEntry(), makeHistoryEntry()];
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = entries;
      const result = await storage.loadHistory(100);
      expect(result).toHaveLength(2);
    });

    it('should return all entries when limit is zero (falsy)', async () => {
      const entries = Array.from({ length: 4 }, () => makeHistoryEntry());
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = entries;
      const result = await storage.loadHistory(0);
      expect(result).toHaveLength(4);
    });

    it('should return empty array when storage.get throws', async () => {
      const errStorage = {
        get: vi.fn(async () => { throw new Error('read error'); }),
        set: vi.fn(),
      };
      const errInstance = new ApprovalConfigStorage(() => errStorage);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await errInstance.loadHistory();
      expect(result).toEqual([]);
      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // appendHistory (debounced)
  // -----------------------------------------------------------------------

  describe('appendHistory', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should not write immediately to storage', async () => {
      await storage.appendHistory(makeHistoryEntry());
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should flush after the debounce interval (2000 ms)', async () => {
      await storage.appendHistory(makeHistoryEntry({ toolName: 'flushed_tool' }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockStorage.set).toHaveBeenCalled();
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(1);
      expect(saved[0].toolName).toBe('flushed_tool');
    });

    it('should batch multiple entries added within the debounce window', async () => {
      await storage.appendHistory(makeHistoryEntry({ toolName: 'first' }));
      await storage.appendHistory(makeHistoryEntry({ toolName: 'second' }));
      await storage.appendHistory(makeHistoryEntry({ toolName: 'third' }));
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockStorage.set).toHaveBeenCalledTimes(1);
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(3);
      expect(saved.map((e: ApprovalHistoryEntry) => e.toolName)).toEqual([
        'first', 'second', 'third',
      ]);
    });

    it('should merge new entries with existing history in storage', async () => {
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = [
        makeHistoryEntry({ toolName: 'existing' }),
      ];
      await storage.appendHistory(makeHistoryEntry({ toolName: 'new_one' }));
      await vi.advanceTimersByTimeAsync(2000);
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(2);
      expect(saved[0].toolName).toBe('existing');
      expect(saved[1].toolName).toBe('new_one');
    });

    it('should cap total history at 100 entries', async () => {
      // Pre-fill with 99 entries
      mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY] = Array.from(
        { length: 99 },
        (_, i) => makeHistoryEntry({ timestamp: i, toolName: `old_${i}` })
      );
      // Add 3 new entries => 102 total, should trim to 100
      await storage.appendHistory(makeHistoryEntry({ toolName: 'new_100' }));
      await storage.appendHistory(makeHistoryEntry({ toolName: 'new_101' }));
      await storage.appendHistory(makeHistoryEntry({ toolName: 'new_102' }));
      await vi.advanceTimersByTimeAsync(2000);
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(100);
      // Oldest entries trimmed, newest at the end
      expect(saved[saved.length - 1].toolName).toBe('new_102');
      expect(saved[saved.length - 2].toolName).toBe('new_101');
      expect(saved[saved.length - 3].toolName).toBe('new_100');
      // The first two of the original 99 should be gone (99+3=102, trim to last 100)
      expect(saved[0].toolName).toBe('old_2');
    });

    it('should handle flush when storage.get returns no history key', async () => {
      // Storage returns empty result (no approval_history key)
      await storage.appendHistory(makeHistoryEntry({ toolName: 'solo' }));
      await vi.advanceTimersByTimeAsync(2000);
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(1);
      expect(saved[0].toolName).toBe('solo');
    });

    it('should not write if pendingHistoryEntries is empty at flush time', async () => {
      // Manually trigger a scenario: append then immediately manually clear pending
      // This tests the guard in flushHistory
      await storage.appendHistory(makeHistoryEntry());
      // Remove the entry before flush fires
      (storage as any).pendingHistoryEntries.splice(0);
      await vi.advanceTimersByTimeAsync(2000);
      // set should NOT have been called because flush found 0 pending entries
      expect(mockStorage.set).not.toHaveBeenCalled();
    });

    it('should handle error during flush gracefully', async () => {
      const errStorage = {
        get: vi.fn(async () => { throw new Error('flush read error'); }),
        set: vi.fn(),
      };
      const errInstance = new ApprovalConfigStorage(() => errStorage);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await errInstance.appendHistory(makeHistoryEntry());
      await vi.advanceTimersByTimeAsync(2000);
      // Should not throw, just log
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should allow subsequent flushes after the first one completes', async () => {
      await storage.appendHistory(makeHistoryEntry({ toolName: 'batch1' }));
      await vi.advanceTimersByTimeAsync(2000);

      await storage.appendHistory(makeHistoryEntry({ toolName: 'batch2' }));
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockStorage.set).toHaveBeenCalledTimes(2);
      const saved = mockStorage._store[STORAGE_KEYS.APPROVAL_HISTORY];
      expect(saved).toHaveLength(2);
      expect(saved[0].toolName).toBe('batch1');
      expect(saved[1].toolName).toBe('batch2');
    });
  });
});

// ===========================================================================
// defaultRules — getDefaultRules()
// ===========================================================================

describe('getDefaultRules (defaultRules.ts)', () => {

  // -----------------------------------------------------------------------
  // Platform selection
  // -----------------------------------------------------------------------

  describe('platform selection', () => {
    it('should return extension rules by default (no argument)', () => {
      const rules = getDefaultRules();
      const hasExtensionRule = rules.some(r => r.match.tool === 'browser_dom');
      const hasDesktopRule = rules.some(r => r.match.tool === 'terminal');
      expect(hasExtensionRule).toBe(true);
      expect(hasDesktopRule).toBe(false);
    });

    it('should include shared rules in extension platform', () => {
      const rules = getDefaultRules('extension');
      expect(rules.find(r => r.match.tool === 'planning_tool')).toBeDefined();
      expect(rules.find(r => r.match.tool === 'web_search')).toBeDefined();
      expect(rules.find(r => r.match.riskAbove === 85 && r.type === 'deny')).toBeDefined();
      expect(rules.find(r => r.match.riskAbove === 30 && r.type === 'ask')).toBeDefined();
    });

    it('should include shared rules in desktop platform', () => {
      const rules = getDefaultRules('desktop');
      expect(rules.find(r => r.match.tool === 'planning_tool')).toBeDefined();
      expect(rules.find(r => r.match.tool === 'web_search')).toBeDefined();
      expect(rules.find(r => r.match.riskAbove === 85 && r.type === 'deny')).toBeDefined();
      expect(rules.find(r => r.match.riskAbove === 30 && r.type === 'ask')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Extension-specific rules
  // -----------------------------------------------------------------------

  describe('extension rules', () => {
    let rules: PolicyRule[];

    beforeEach(() => {
      rules = getDefaultRules('extension');
    });

    it('should allow browser_dom snapshot', () => {
      const rule = rules.find(r => r.match.tool === 'browser_dom' && r.match.pattern === '^snapshot$');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('allow');
    });

    it('should allow browser_dom scroll', () => {
      const rule = rules.find(r => r.match.tool === 'browser_dom' && r.match.pattern === '^scroll$');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('allow');
    });

    it('should ask for browser_dom click', () => {
      const rule = rules.find(r => r.match.tool === 'browser_dom' && r.match.pattern === '^click$');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('ask');
    });

    it('should ask for browser_dom type', () => {
      const rule = rules.find(r => r.match.tool === 'browser_dom' && r.match.pattern === '^type$');
      expect(rule).toBeDefined();
      expect(rule!.type).toBe('ask');
    });

    it('should not contain any terminal rules', () => {
      const terminalRules = rules.filter(r => r.match.tool === 'terminal');
      expect(terminalRules).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Desktop-specific rules
  // -----------------------------------------------------------------------

  describe('desktop rules', () => {
    let rules: PolicyRule[];

    beforeEach(() => {
      rules = getDefaultRules('desktop');
    });

    it('should allow read-only terminal commands (ls, cat, etc.)', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'allow' && r.match.pattern?.includes('ls')
      );
      expect(rule).toBeDefined();
    });

    it('should allow read-only git commands', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'allow' && r.match.pattern?.includes('git')
      );
      expect(rule).toBeDefined();
      expect(rule!.match.pattern).toContain('status');
      expect(rule!.match.pattern).toContain('log');
      expect(rule!.match.pattern).toContain('diff');
    });

    it('should ask for modifying terminal commands (sudo, rm, etc.)', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'ask' && r.match.pattern?.includes('sudo')
      );
      expect(rule).toBeDefined();
      expect(rule!.match.pattern).toContain('rm');
      expect(rule!.match.pattern).toContain('chmod');
    });

    it('should deny destructive rm on root', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'deny' && r.match.pattern?.includes('rm')
      );
      expect(rule).toBeDefined();
    });

    it('should deny curl piped to shell', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'deny' && r.match.pattern?.includes('curl')
      );
      expect(rule).toBeDefined();
    });

    it('should deny wget piped to shell', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'deny' && r.match.pattern?.includes('wget')
      );
      expect(rule).toBeDefined();
    });

    it('should deny fork bomb pattern', () => {
      const rule = rules.find(
        r => r.match.tool === 'terminal' && r.type === 'deny' && r.match.pattern?.includes(':\\(\\)')
      );
      expect(rule).toBeDefined();
    });

    it('should not contain any browser_dom rules', () => {
      const domRules = rules.filter(r => r.match.tool === 'browser_dom');
      expect(domRules).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Shared rules integrity
  // -----------------------------------------------------------------------

  describe('shared rules', () => {
    it('critical-risk deny rule should match riskAbove 85', () => {
      const rules = getDefaultRules('extension');
      const rule = rules.find(r => r.type === 'deny' && r.match.riskAbove === 85);
      expect(rule).toBeDefined();
      expect(rule!.description).toContain('critical-risk');
    });

    it('medium-risk ask rule should match riskAbove 30', () => {
      const rules = getDefaultRules('extension');
      const rule = rules.find(r => r.type === 'ask' && r.match.riskAbove === 30);
      expect(rule).toBeDefined();
      expect(rule!.description).toContain('medium-risk');
    });

    it('planning_tool should be typed as allow', () => {
      const rules = getDefaultRules('extension');
      const rule = rules.find(r => r.match.tool === 'planning_tool');
      expect(rule!.type).toBe('allow');
    });

    it('web_search should be typed as allow', () => {
      const rules = getDefaultRules('extension');
      const rule = rules.find(r => r.match.tool === 'web_search');
      expect(rule!.type).toBe('allow');
    });
  });

  // -----------------------------------------------------------------------
  // Return value immutability / fresh copies
  // -----------------------------------------------------------------------

  describe('return value immutability', () => {
    it('should return a new array each call (not a shared reference)', () => {
      const a = getDefaultRules('extension');
      const b = getDefaultRules('extension');
      expect(a).not.toBe(b);
    });

    it('mutating the returned array should not affect subsequent calls', () => {
      const first = getDefaultRules('extension');
      const originalLength = first.length;
      first.push({ type: 'deny', match: { tool: 'injected' }, description: 'injected' });
      const second = getDefaultRules('extension');
      expect(second).toHaveLength(originalLength);
    });
  });

  // -----------------------------------------------------------------------
  // Every rule has a description
  // -----------------------------------------------------------------------

  describe('rule descriptions', () => {
    it('every extension rule should have a non-empty description', () => {
      const rules = getDefaultRules('extension');
      for (const rule of rules) {
        expect(rule.description).toBeTruthy();
        expect(typeof rule.description).toBe('string');
      }
    });

    it('every desktop rule should have a non-empty description', () => {
      const rules = getDefaultRules('desktop');
      for (const rule of rules) {
        expect(rule.description).toBeTruthy();
        expect(typeof rule.description).toBe('string');
      }
    });
  });
});
