/**
 * Unit tests for SettingTool
 *
 * Tests the SettingTool which extends BaseTool to provide
 * read/write access to allowlisted user settings via chat.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SettingTool } from '../SettingTool';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};

(global as any).chrome = {
  storage: {
    local: {
      get: vi.fn((key: string) => {
        return Promise.resolve({ [key]: mockStorage[key] });
      }),
      set: vi.fn((data: Record<string, any>) => {
        Object.assign(mockStorage, data);
        return Promise.resolve();
      }),
    },
  },
};

// Mock the defaults module
vi.mock('../../config/defaults', () => ({
  STORAGE_KEYS: {
    CONFIG: 'agent_config',
    APPROVAL_CONFIG: 'approval_config',
  },
}));

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('SettingTool', () => {
  let tool: SettingTool;

  beforeEach(() => {
    // Reset storage
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);

    // Re-setup mock implementations (vi.clearAllMocks clears them)
    (global as any).chrome.storage.local.get = vi.fn((key: string) => {
      return Promise.resolve({ [key]: mockStorage[key] });
    });
    (global as any).chrome.storage.local.set = vi.fn((data: Record<string, any>) => {
      Object.assign(mockStorage, data);
      return Promise.resolve();
    });

    // Set up default storage state
    mockStorage['agent_config'] = {
      tools: {
        dom_tool: true,
        enable_all_tools: false,
      },
      preferences: {
        uiTheme: 'chatgpt',
        theme: 'dark',
        language: 'en',
      },
      selectedModelKey: 'openai:gpt-4o',
    };
    mockStorage['approval_config'] = {
      mode: 'balanced',
      trustedDomains: ['example.com'],
      blockedDomains: [],
    };

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

    it('reads model selection', async () => {
      const result = await tool.execute({ action: 'get', key: 'model.selection' });
      expect(result.success).toBe(true);
      expect(result.data.value).toBe('openai:gpt-4o');
    });

    it('returns error for non-allowlisted key', async () => {
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

    it('rejects non-allowlisted key', async () => {
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
  });

  // ─── YOLO mode blocking ─────────────────────────────────────────

  describe('YOLO mode blocking', () => {
    beforeEach(() => {
      mockStorage['approval_config'] = {
        mode: 'yolo',
        trustedDomains: [],
        blockedDomains: [],
      };
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
  });
});
