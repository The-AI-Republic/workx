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

  describe('setModelClient()', () => {
    it('should replace the model client so getModelClient() returns the new client', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      // Verify original client is returned
      expect(context.getModelClient()).toBe(mockModelClient);

      // Create a new mock ModelClient
      const newModelClient = {
        getModel: vi.fn().mockReturnValue('new-model'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(16384),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: true }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      // Replace the client
      context.setModelClient(newModelClient);

      // getModelClient() should return the new client, not the original
      expect(context.getModelClient()).toBe(newModelClient);
      expect(context.getModelClient()).not.toBe(mockModelClient);
    });

    it('should cause getModel() to return the new model after setModelClient', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      // Verify original model
      expect(context.getModel()).toBe('test-model');
      expect(mockModelClient.getModel).toHaveBeenCalled();

      // Create new client with different model
      const newModelClient = {
        getModel: vi.fn().mockReturnValue('gpt-4o'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(128000),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      context.setModelClient(newModelClient);

      // getModel() should now delegate to the new client
      expect(context.getModel()).toBe('gpt-4o');
      expect(newModelClient.getModel).toHaveBeenCalled();
    });

    it('should return the new client instance after setModelClient', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      const newModelClient = {
        getModel: vi.fn().mockReturnValue('claude-opus-4-20250514'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(200000),
        getReasoningEffort: vi.fn().mockReturnValue('high'),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: true }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      context.setModelClient(newModelClient);

      // The returned client should be the exact same object reference
      const returnedClient = context.getModelClient();
      expect(returnedClient).toBe(newModelClient);

      // Verify delegated methods also work through the new client
      expect(context.getModelContextWindow()).toBe(200000);
      expect(newModelClient.getModelContextWindow).toHaveBeenCalled();
    });

    it('should allow multiple successive setModelClient calls', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      const secondClient = {
        getModel: vi.fn().mockReturnValue('model-2'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(4096),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      const thirdClient = {
        getModel: vi.fn().mockReturnValue('model-3'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(32000),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      context.setModelClient(secondClient);
      expect(context.getModel()).toBe('model-2');
      expect(context.getModelClient()).toBe(secondClient);

      context.setModelClient(thirdClient);
      expect(context.getModel()).toBe('model-3');
      expect(context.getModelClient()).toBe(thirdClient);
      expect(context.getModelClient()).not.toBe(secondClient);
    });

    it('should not affect other TurnContext properties when replacing the client', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'preserve-session',
        baseInstructions: 'base instructions',
        userInstructions: 'user instructions',
        approvalPolicy: 'never',
        sandboxPolicy: { mode: 'read-only' },
        browserEnvironmentPolicy: 'clean',
        reviewMode: true,
      });

      const newModelClient = {
        getModel: vi.fn().mockReturnValue('replacement-model'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(64000),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      context.setModelClient(newModelClient);

      // All other properties should remain unchanged
      expect(context.getSessionId()).toBe('preserve-session');
      expect(context.getBaseInstructions()).toBe('base instructions');
      expect(context.getUserInstructions()).toBe('user instructions');
      expect(context.getApprovalPolicy()).toBe('never');
      expect(context.getSandboxPolicy()).toEqual({ mode: 'read-only' });
      expect(context.getBrowserEnvironmentPolicy()).toBe('clean');
      expect(context.isReviewMode()).toBe(true);

      // But model-related methods should reflect the new client
      expect(context.getModel()).toBe('replacement-model');
    });
  });

  describe('setSelectedModelKey() / getSelectedModelKey()', () => {
    it('should fall back to getModel() when no selected key is set', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      // No explicit key set, should delegate to modelClient.getModel()
      expect(context.getSelectedModelKey()).toBe('test-model');
    });

    it('should return the composite key after setSelectedModelKey', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      context.setSelectedModelKey('openai:gpt-5');
      expect(context.getSelectedModelKey()).toBe('openai:gpt-5');
    });

    it('should be independent of setModelClient', () => {
      const context = new TurnContext(mockModelClient, {
        sessionId: 'test-session',
      });

      context.setSelectedModelKey('anthropic:claude-4');

      const newClient = {
        getModel: vi.fn().mockReturnValue('raw-model-name'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(128000),
        getReasoningEffort: vi.fn().mockReturnValue(undefined),
        setReasoningEffort: vi.fn(),
        getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
        setReasoningSummary: vi.fn(),
        stream: vi.fn(),
      } as any;

      context.setModelClient(newClient);

      // selectedModelKey should still be the composite key, not the raw model name
      expect(context.getSelectedModelKey()).toBe('anthropic:claude-4');
      // getModel() should return the raw name from the new client
      expect(context.getModel()).toBe('raw-model-name');
    });

    it('should allow overwriting the selected model key', () => {
      const context = new TurnContext(mockModelClient);

      context.setSelectedModelKey('openai:gpt-5');
      expect(context.getSelectedModelKey()).toBe('openai:gpt-5');

      context.setSelectedModelKey('google:gemini-2.0-flash');
      expect(context.getSelectedModelKey()).toBe('google:gemini-2.0-flash');
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
