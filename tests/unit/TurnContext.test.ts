/**
 * Unit Test: TurnContext tabId Methods
 *
 * Purpose: Validates TurnContext tabId-related methods and tab binding integration
 *
 * Test Coverage:
 * - getTabId() / setTabId()
 * - getSessionId()
 * - hasTabAttached()
 * - validateCurrentTab()
 * - Tab ID in constructor and configuration
 * - Tab ID in export/import
 * - Tab ID in clone()
 *
 * Breaking Changes Tested:
 * - Removed cwd field
 * - Added tabId and sessionId fields
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TurnContext } from '../../src/core/TurnContext';
import { ModelClient } from '../../src/models/ModelClient';
import { TabManager } from '../../src/core/TabManager';
import { TabInvalidReason } from '../../src/types/session';

describe('TurnContext tabId Methods', () => {
  let chromeMock: any;
  let mockModelClient: ModelClient;

  beforeEach(async () => {
    // Reset singleton
    (TabManager as any).instance = null;

    // Mock chrome APIs
    chromeMock = {
      tabs: {
        get: vi.fn(),
        onRemoved: {
          addListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
    global.chrome = chromeMock as any;

    // Initialize TabManager
    const bindingManager = TabManager.getInstance();
    await bindingManager.initialize();

    // Create mock ModelClient
    mockModelClient = {
      getModel: vi.fn().mockReturnValue('test-model'),
      setModel: vi.fn(),
      getModelContextWindow: vi.fn().mockReturnValue(8192),
      getReasoningEffort: vi.fn().mockReturnValue(undefined),
      setReasoningEffort: vi.fn(),
      getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
      setReasoningSummary: vi.fn(),
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor and Initialization', () => {
    it('should initialize with default tabId = -1', () => {
      const context = new TurnContext(mockModelClient);

      expect(context.getTabId()).toBe(-1);
      expect(context.hasTabAttached()).toBe(false);
    });

    it('should initialize with provided tabId', () => {
      const context = new TurnContext(mockModelClient, {
        tabId: 123,
      });

      expect(context.getTabId()).toBe(123);
      expect(context.hasTabAttached()).toBe(true);
    });

    it('should initialize with sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'session-1',
      });

      expect(context.getSessionId()).toBe('session-1');
    });

    it('should initialize with both tabId and sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        tabId: 123,
        sessionId: 'session-1',
      });

      expect(context.getTabId()).toBe(123);
      expect(context.getSessionId()).toBe('session-1');
      expect(context.hasTabAttached()).toBe(true);
    });

    it('should default sessionId to empty string', () => {
      const context = new TurnContext(mockModelClient);

      expect(context.getSessionId()).toBe('');
    });
  });

  describe('getTabId() / setTabId()', () => {
    it('should get tab ID', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });

      expect(context.getTabId()).toBe(123);
    });

    it('should set tab ID', () => {
      const context = new TurnContext(mockModelClient);

      context.setTabId(456);

      expect(context.getTabId()).toBe(456);
      expect(context.hasTabAttached()).toBe(true);
    });

    it('should update tab ID from -1 to valid ID', () => {
      const context = new TurnContext(mockModelClient);
      expect(context.getTabId()).toBe(-1);
      expect(context.hasTabAttached()).toBe(false);

      context.setTabId(789);

      expect(context.getTabId()).toBe(789);
      expect(context.hasTabAttached()).toBe(true);
    });

    it('should reset tab ID to -1', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });
      expect(context.hasTabAttached()).toBe(true);

      context.setTabId(-1);

      expect(context.getTabId()).toBe(-1);
      expect(context.hasTabAttached()).toBe(false);
    });
  });

  describe('getSessionId()', () => {
    it('should return session ID', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      expect(context.getSessionId()).toBe('test-session');
    });

    it('should return empty string for default sessionId', () => {
      const context = new TurnContext(mockModelClient);

      expect(context.getSessionId()).toBe('');
    });
  });

  describe('hasTabAttached()', () => {
    it('should return false when tabId = -1', () => {
      const context = new TurnContext(mockModelClient);

      expect(context.hasTabAttached()).toBe(false);
    });

    it('should return true when tabId > 0', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });

      expect(context.hasTabAttached()).toBe(true);
    });

    it('should update when tabId changes', () => {
      const context = new TurnContext(mockModelClient);
      expect(context.hasTabAttached()).toBe(false);

      context.setTabId(123);
      expect(context.hasTabAttached()).toBe(true);

      context.setTabId(-1);
      expect(context.hasTabAttached()).toBe(false);
    });
  });

  describe('validateCurrentTab()', () => {
    it('should return valid state when tab exists', async () => {
      const mockTab = { id: 123, url: 'https://example.com' };
      chromeMock.tabs.get.mockResolvedValue(mockTab);

      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const result = await context.validateCurrentTab();

      expect(result.status).toBe('valid');
      if (result.status === 'valid') {
        expect(result.tab.id).toBe(123);
      }
    });

    it('should return invalid state when tab does not exist', async () => {
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 123'));

      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const result = await context.validateCurrentTab();

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBeDefined();
      }
    });

    it('should return invalid state for tabId = -1', async () => {
      const context = new TurnContext(mockModelClient);

      const result = await context.validateCurrentTab();

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe(TabInvalidReason.NOT_FOUND);
      }
    });

    it('should detect permission errors', async () => {
      chromeMock.tabs.get.mockRejectedValue(new Error('permission denied'));

      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const result = await context.validateCurrentTab();

      expect(result.status).toBe('invalid');
      if (result.status === 'invalid') {
        expect(result.reason).toBe(TabInvalidReason.PERMISSION_DENIED);
      }
    });
  });

  describe('update() method', () => {
    it('should update tabId', () => {
      const context = new TurnContext(mockModelClient);

      context.update({ tabId: 123 });

      expect(context.getTabId()).toBe(123);
    });

    it('should update sessionId', () => {
      const context = new TurnContext(mockModelClient);

      context.update({ sessionId: 'updated-session' });

      expect(context.getSessionId()).toBe('updated-session');
    });

    it('should update both tabId and sessionId', () => {
      const context = new TurnContext(mockModelClient);

      context.update({
        tabId: 456,
        sessionId: 'new-session',
      });

      expect(context.getTabId()).toBe(456);
      expect(context.getSessionId()).toBe('new-session');
    });
  });

  describe('export() method', () => {
    it('should export tabId', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const exported = context.export();

      expect(exported.tabId).toBe(123);
    });

    it('should export sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'export-test',
      });

      const exported = context.export();

      expect(exported.sessionId).toBe('export-test');
    });

    it('should export both tabId and sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        tabId: 789,
        sessionId: 'full-export',
      });

      const exported = context.export();

      expect(exported.tabId).toBe(789);
      expect(exported.sessionId).toBe('full-export');
    });

    it('should not export cwd field (breaking change)', () => {
      const context = new TurnContext(mockModelClient);

      const exported = context.export();

      expect(exported).not.toHaveProperty('cwd');
    });
  });

  describe('import() static method', () => {
    it('should import tabId', () => {
      const imported = TurnContext.import(mockModelClient, {
        tabId: 123,
        sessionId: 'import-test',
        approvalPolicy: 'on-request',
        sandboxPolicy: { mode: 'workspace-write' },
        browserEnvironmentPolicy: 'preserve',
        toolsConfig: {
          execCommand: true,
          webSearch: true,
          fileOperations: true,
          mcpTools: true,
        },
        model: 'test-model',
        summary: { enabled: false },
        reviewMode: false,
      });

      expect(imported.getTabId()).toBe(123);
    });

    it('should import sessionId', () => {
      const imported = TurnContext.import(mockModelClient, {
        tabId: -1,
        sessionId: 'imported-session',
        approvalPolicy: 'on-request',
        sandboxPolicy: { mode: 'workspace-write' },
        browserEnvironmentPolicy: 'preserve',
        toolsConfig: {
          execCommand: true,
          webSearch: true,
          fileOperations: true,
          mcpTools: true,
        },
        model: 'test-model',
        summary: { enabled: false },
        reviewMode: false,
      });

      expect(imported.getSessionId()).toBe('imported-session');
    });

    it('should not accept cwd field (breaking change)', () => {
      const data: any = {
        cwd: '/some/path',
        tabId: -1,
        sessionId: 'test',
        approvalPolicy: 'on-request',
        sandboxPolicy: { mode: 'workspace-write' },
        browserEnvironmentPolicy: 'preserve',
        toolsConfig: {
          execCommand: true,
          webSearch: true,
          fileOperations: true,
          mcpTools: true,
        },
        model: 'test-model',
        summary: { enabled: false },
        reviewMode: false,
      };

      // Should not throw, but cwd should be ignored
      const imported = TurnContext.import(mockModelClient, data);
      const exported = imported.export();

      expect(exported).not.toHaveProperty('cwd');
    });
  });

  describe('clone() method', () => {
    it('should clone tabId', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const cloned = context.clone();

      expect(cloned.getTabId()).toBe(123);
      expect(cloned).not.toBe(context); // Different instance
    });

    it('should clone sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'clone-test',
      });

      const cloned = context.clone();

      expect(cloned.getSessionId()).toBe('clone-test');
    });

    it('should maintain independence from original', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });
      const cloned = context.clone();

      cloned.setTabId(456);

      expect(context.getTabId()).toBe(123); // Original unchanged
      expect(cloned.getTabId()).toBe(456); // Clone changed
    });
  });

  describe('validate() method', () => {
    it('should validate tabId is -1 or positive integer', () => {
      const validContext = new TurnContext(mockModelClient, {
        tabId: 123,
        sessionId: 'test',
      });

      const result = validContext.validate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject negative tabId (except -1)', () => {
      const context = new TurnContext(mockModelClient, {
        tabId: -2,
        sessionId: 'test',
      });

      const result = context.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'Tab ID must be -1 (unbound) or a positive integer'
      );
    });

    it('should reject non-integer tabId', () => {
      const context = new TurnContext(mockModelClient, {
        tabId: 123.5 as any,
        sessionId: 'test',
      });

      const result = context.validate();

      expect(result.valid).toBe(false);
    });

    it('should require sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: '',
      });

      const result = context.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Session ID is required');
    });
  });

  describe('getDebugInfo() method', () => {
    it('should include tabId in debug info', () => {
      const context = new TurnContext(mockModelClient, { tabId: 123 });

      const debugInfo = context.getDebugInfo();

      expect(debugInfo.tabId).toBe(123);
    });

    it('should include sessionId in debug info', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'debug-test',
      });

      const debugInfo = context.getDebugInfo();

      expect(debugInfo.sessionId).toBe('debug-test');
    });

    it('should include hasTabAttached in debug info', () => {
      const contextWithTab = new TurnContext(mockModelClient, { tabId: 123 });
      const contextWithoutTab = new TurnContext(mockModelClient);

      expect(contextWithTab.getDebugInfo().hasTabAttached).toBe(true);
      expect(contextWithoutTab.getDebugInfo().hasTabAttached).toBe(false);
    });
  });

  describe('Breaking Changes: cwd removal', () => {
    it('should not have getCwd method', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('getCwd');
    });

    it('should not have setCwd method', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('setCwd');
    });

    it('should not have resolvePath method', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('resolvePath');
    });

    it('should not have isPathWritable method', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('isPathWritable');
    });
  });
});
