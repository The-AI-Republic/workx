/**
 * Unit Test: TurnContext Methods
 *
 * Purpose: Validates TurnContext methods
 *
 * Test Coverage:
 * - getSessionId()
 * - Session ID in constructor and configuration
 * - Session ID in export/import
 * - Session ID in clone()
 *
 * Breaking Changes Tested:
 * - Removed cwd field
 * - Removed tabId field (now managed by Session/SessionState)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TurnContext } from '@/core/TurnContext';
import { ModelClient } from '@/core/models/ModelClient';

describe('TurnContext Methods', () => {
  let mockModelClient: ModelClient;

  beforeEach(async () => {
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

  describe('Constructor and Initialization', () => {
    it('should initialize with sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'session-1',
      });

      expect(context.getSessionId()).toBe('session-1');
    });

    it('should default sessionId to empty string', () => {
      const context = new TurnContext(mockModelClient);

      expect(context.getSessionId()).toBe('');
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

  describe('update() method', () => {
    it('should update sessionId', () => {
      const context = new TurnContext(mockModelClient);

      context.update({ sessionId: 'updated-session' });

      expect(context.getSessionId()).toBe('updated-session');
    });
  });

  describe('export() method', () => {
    it('should export sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'export-test',
      });

      const exported = context.export();

      expect(exported.sessionId).toBe('export-test');
    });

    it('should not export cwd field (breaking change)', () => {
      const context = new TurnContext(mockModelClient);

      const exported = context.export();

      expect(exported).not.toHaveProperty('cwd');
    });

    it('should not export tabId field (breaking change - tabId now in Session/SessionState)', () => {
      const context = new TurnContext(mockModelClient);

      const exported = context.export();

      expect(exported).not.toHaveProperty('tabId');
    });
  });

  describe('import() static method', () => {
    it('should import sessionId', () => {
      const imported = TurnContext.import(mockModelClient, {
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
    it('should clone sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'clone-test',
      });

      const cloned = context.clone();

      expect(cloned.getSessionId()).toBe('clone-test');
    });
  });

  describe('validate() method', () => {
    it('should require sessionId', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: '',
      });

      const result = context.validate();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Session ID is required');
    });

    it('should validate with sessionId present', () => {
      const validContext = new TurnContext(mockModelClient, {
        sessionId: 'test',
      });

      const result = validContext.validate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('getDebugInfo() method', () => {
    it('should include sessionId in debug info', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'debug-test',
      });

      const debugInfo = context.getDebugInfo();

      expect(debugInfo.sessionId).toBe('debug-test');
    });

    it('should not include tabId in debug info (breaking change - tabId now in Session)', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'debug-test',
      });

      const debugInfo = context.getDebugInfo();

      expect(debugInfo).not.toHaveProperty('tabId');
      expect(debugInfo).not.toHaveProperty('hasTabAttached');
    });
  });

  describe('Breaking Changes: cwd and tabId removal', () => {
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

    it('should not have getTabId method (breaking change - use Session.getTabId() instead)', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('getTabId');
    });

    it('should not have setTabId method (breaking change - use Session.setTabId() instead)', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('setTabId');
    });

    it('should not have hasTabAttached method (breaking change - use Session.sessionState.hasTabAttached() instead)', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('hasTabAttached');
    });

    it('should not have validateCurrentTab method (breaking change)', () => {
      const context = new TurnContext(mockModelClient);

      expect(context).not.toHaveProperty('validateCurrentTab');
    });
  });
});
