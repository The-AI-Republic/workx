/**
 * Unit tests for SettingTool
 *
 * Tests the SettingTool which extends BaseTool to provide
 * read/write access to allowlisted user settings via chat.
 * Access is gated by the Zod-based config schema.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingTool } from '../SettingTool';
import { setConfigStorage, type ConfigStorageProvider } from '@/core/storage/ConfigStorageProvider';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Map-based ConfigStorageProvider mock
const store = new Map<string, any>();

function createMockConfigStorage(): ConfigStorageProvider {
  return {
    get: vi.fn(async <T>(key: string): Promise<T | null> => (store.get(key) as T) ?? null),
    set: vi.fn(async <T>(key: string, value: T): Promise<void> => { store.set(key, value); }),
    remove: vi.fn(async (key: string): Promise<void> => { store.delete(key); }),
    getMany: vi.fn(async <T>(keys: string[]): Promise<Record<string, T>> => {
      const result: Record<string, T> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key);
      }
      return result;
    }),
    setMany: vi.fn(async <T>(items: Record<string, T>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }),
    removeMany: vi.fn(async (keys: string[]): Promise<void> => {
      for (const key of keys) store.delete(key);
    }),
    getAll: vi.fn(async (): Promise<Record<string, unknown>> => Object.fromEntries(store)),
    clear: vi.fn(async (): Promise<void> => { store.clear(); }),
    getBytesInUse: vi.fn(async (): Promise<number | null> => null),
  };
}

// Mock the defaults module
vi.mock('../../config/defaults', () => ({
  STORAGE_KEYS: {
    CONFIG: 'agent_config',
  },
}));

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('SettingTool', () => {
  let tool: SettingTool;

  beforeEach(() => {
    // Reset storage
    store.clear();

    // Install mock ConfigStorageProvider
    const mockStorage = createMockConfigStorage();
    setConfigStorage(mockStorage);

    // Set up default storage state
    store.set('agent_config', {
      tools: {
        dom_tool: true,
        enable_all_tools: false,
      },
      preferences: {
        uiTheme: 'modern-auto',
        theme: 'dark',
        language: 'en',
      },
      selectedModelKey: 'openai:gpt-4o',
      approval: {
        mode: 'balanced',
        trustedDomains: ['example.com'],
        blockedDomains: [],
      },
    });

    tool = new SettingTool();
  });

  // ─── Tool definition ────────────────────────────────────────────

  describe('tool definition', () => {
    it('has the correct name', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('setting_tool');
      }
    });

    it('has a description', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.description).toBeTruthy();
      }
    });
  });

  // ─── Get action ─────────────────────────────────────────────────

  describe('get action', () => {
    it('reads a valid setting', async () => {
      const result = await tool.execute({ action: 'get', key: 'approval.mode' });
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.action).toBe('get');
      expect(result.data.value).toBe('balanced');
    });

    it('reads a tool toggle', async () => {
      const result = await tool.execute({ action: 'get', key: 'tools.dom_tool' });
      expect(result.success).toBe(true);
      expect(result.data.value).toBe(true);
    });

    it('reads model selection via canonical path', async () => {
      const result = await tool.execute({ action: 'get', key: 'selectedModelKey' });
      expect(result.success).toBe(true);
      expect(result.data.value).toBe('openai:gpt-4o');
    });

    it('reads model selection via alias', async () => {
      const result = await tool.execute({ action: 'get', key: 'model.selection' });
      expect(result.success).toBe(true);
      expect(result.data.value).toBe('openai:gpt-4o');
    });

    it('reads preferences via alias', async () => {
      const result = await tool.execute({ action: 'get', key: 'general.uiTheme' });
      expect(result.success).toBe(true);
      expect(result.data.value).toBe('modern-auto');
    });

    it('returns error for non-accessible key', async () => {
      const result = await tool.execute({ action: 'get', key: 'providers.openai.apiKey' });
      expect(result.success).toBe(true); // execute succeeds
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('not accessible');
    });

    it('returns error when key is missing', async () => {
      const result = await tool.execute({ action: 'get' });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('key');
    });

    it('returns label and description in response', async () => {
      const result = await tool.execute({ action: 'get', key: 'approval.mode' });
      expect(result.data.success).toBe(true);
      expect(result.data.label).toBe('Approval Mode');
      expect(typeof result.data.description).toBe('string');
      expect(result.data.description.length).toBeGreaterThan(0);
    });

    it('returns undefined for field not yet in storage', async () => {
      // Remove webSearch from storage — it was never set
      const config = store.get('agent_config');
      delete config.tools.webSearch;
      store.set('agent_config', config);
      const result = await tool.execute({ action: 'get', key: 'tools.webSearch' });
      expect(result.data.success).toBe(true);
      expect(result.data.value).toBeUndefined();
    });
  });

  // ─── Set action ─────────────────────────────────────────────────

  describe('set action', () => {
    it('updates a valid setting', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'approval.mode',
        value: 'high_speed',
      });
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.previousValue).toBe('balanced');
      expect(result.data.value).toBe('high_speed');
    });

    it('updates a boolean tool toggle with string coercion', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'tools.dom_tool',
        value: 'false',
      });
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.value).toBe(false);
      expect(result.data.previousValue).toBe(true);
    });

    it('rejects invalid enum value', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'approval.mode',
        value: 'invalid_mode',
      });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Invalid value');
    });

    it('rejects non-accessible key', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'providers.openai.apiKey',
        value: 'sk-new-key',
      });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('not accessible');
    });

    it('returns error when key is missing', async () => {
      const result = await tool.execute({ action: 'set', value: 'test' });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('key');
    });

    it('adds YOLO transition warning when setting to yolo mode', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'approval.mode',
        value: 'yolo',
      });
      expect(result.data.success).toBe(true);
      expect(result.data.warning).toContain('YOLO mode is now active');
    });

    it('updates via alias key', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'general.theme',
        value: 'light',
      });
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.value).toBe('light');
      expect(result.data.previousValue).toBe('dark');
    });

    it('coerces case-insensitive boolean strings', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'tools.dom_tool',
        value: 'FALSE',
      });
      expect(result.data.success).toBe(true);
      expect(result.data.value).toBe(false);

      const result2 = await tool.execute({
        action: 'set',
        key: 'tools.dom_tool',
        value: 'TRUE',
      });
      expect(result2.data.success).toBe(true);
      expect(result2.data.value).toBe(true);
    });

    it('rejects native non-string value at parameter validation level', async () => {
      // BaseTool validates value as string per the tool definition schema,
      // so native boolean/array values are rejected before reaching executeImpl
      const result = await tool.execute({
        action: 'set',
        key: 'tools.dom_tool',
        value: false,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('validation');
    });

    it('rejects array value at parameter validation level', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'approval.trustedDomains',
        value: ['newdomain.com', 'other.org'],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('validation');
    });

    it('persists value to storage after set', async () => {
      await tool.execute({
        action: 'set',
        key: 'approval.mode',
        value: 'high_speed',
      });
      // Verify storage was actually mutated
      expect(store.get('agent_config').approval.mode).toBe('high_speed');
    });

    it('alias write persists to correct storage path', async () => {
      await tool.execute({
        action: 'set',
        key: 'general.uiTheme',
        value: 'terminal',
      });
      // Alias general.uiTheme maps to preferences.uiTheme
      expect(store.get('agent_config').preferences.uiTheme).toBe('terminal');
    });

    it('does not include YOLO warning when setting to non-yolo mode', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'approval.mode',
        value: 'high_speed',
      });
      expect(result.data.success).toBe(true);
      expect(result.data.warning).toBeUndefined();
    });
  });

  // ─── YOLO mode blocking ─────────────────────────────────────────

  describe('YOLO mode blocking', () => {
    beforeEach(() => {
      const config = store.get('agent_config');
      store.set('agent_config', {
        ...config,
        approval: {
          mode: 'yolo',
          trustedDomains: [],
          blockedDomains: [],
        },
      });
    });

    it('blocks set action in YOLO mode', async () => {
      const result = await tool.execute({
        action: 'set',
        key: 'tools.dom_tool',
        value: 'true',
      });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('YOLO mode');
    });

    it('allows get action in YOLO mode', async () => {
      const result = await tool.execute({
        action: 'get',
        key: 'approval.mode',
      });
      expect(result.data.success).toBe(true);
      expect(result.data.value).toBe('yolo');
    });

    it('allows list action in YOLO mode', async () => {
      const result = await tool.execute({ action: 'list' });
      expect(result.data.success).toBe(true);
      expect(result.data.settings).toBeDefined();
    });
  });

  // ─── Unknown action ──────────────────────────────────────────────

  describe('unknown action', () => {
    it('returns error for unknown action', async () => {
      const result = await tool.execute({ action: 'delete' });
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('Unknown action');
    });
  });

  // ─── List action ────────────────────────────────────────────────

  describe('list action', () => {
    it('returns all settings with current values', async () => {
      const result = await tool.execute({ action: 'list' });
      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.action).toBe('list');
      expect(Array.isArray(result.data.settings)).toBe(true);
      expect(result.data.settings.length).toBeGreaterThan(0);
    });

    it('settings include expected fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const setting = result.data.settings[0];
      expect(setting).toHaveProperty('key');
      expect(setting).toHaveProperty('category');
      expect(setting).toHaveProperty('label');
      expect(setting).toHaveProperty('description');
      expect(setting).toHaveProperty('currentValue');
      expect(setting).toHaveProperty('type');
    });

    it('returns correct current values', async () => {
      const result = await tool.execute({ action: 'list' });
      const approvalMode = result.data.settings.find(
        (s: any) => s.key === 'approval.mode'
      );
      expect(approvalMode).toBeDefined();
      expect(approvalMode.currentValue).toBe('balanced');
    });

    it('returns correct type for boolean fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const domTool = result.data.settings.find(
        (s: any) => s.key === 'tools.dom_tool'
      );
      expect(domTool).toBeDefined();
      expect(domTool.type).toBe('boolean');
    });

    it('returns correct type for enum fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const approvalMode = result.data.settings.find(
        (s: any) => s.key === 'approval.mode'
      );
      expect(approvalMode).toBeDefined();
      expect(approvalMode.type).toBe('string');
    });

    it('returns correct type for array fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const trusted = result.data.settings.find(
        (s: any) => s.key === 'approval.trustedDomains'
      );
      expect(trusted).toBeDefined();
      expect(trusted.type).toBe('string[]');
    });

    it('returns allowedValues for enum fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const approvalMode = result.data.settings.find(
        (s: any) => s.key === 'approval.mode'
      );
      expect(approvalMode.allowedValues).toEqual(['balanced', 'high_speed', 'yolo']);
    });

    it('returns allowedValues [true, false] for boolean fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const domTool = result.data.settings.find(
        (s: any) => s.key === 'tools.dom_tool'
      );
      expect(domTool.allowedValues).toEqual([true, false]);
    });

    it('returns null allowedValues for free-form fields', async () => {
      const result = await tool.execute({ action: 'list' });
      const language = result.data.settings.find(
        (s: any) => s.key === 'preferences.language'
      );
      expect(language.allowedValues).toBeNull();
    });
  });
});
