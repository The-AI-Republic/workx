import { describe, it, expect } from 'vitest';
import { Session } from '@/core/Session';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { ApprovalManager } from '@/core/ApprovalManager';
import { ModelClientFactory } from '@/core/models/ModelClientFactory';

describe('Backward Compatibility', () => {
  describe('Components without Config', () => {
    it('Session should work without config parameter', () => {
      // Old usage patterns should still work
      expect(() => new Session()).not.toThrow();
      expect(() => new Session(true)).not.toThrow();
      expect(() => new Session(false)).not.toThrow();

      // With undefined explicitly
      expect(() => new Session(undefined)).not.toThrow();
      expect(() => new Session(undefined, true)).not.toThrow();
      expect(() => new Session(undefined, false)).not.toThrow();
    });

    it('ToolRegistry should work without config parameter', () => {
      // Old usage patterns should still work
      expect(() => new ToolRegistry()).not.toThrow();
      expect(() => new ToolRegistry(undefined)).not.toThrow();

      const registry = new ToolRegistry();
      expect(registry).toBeDefined();
    });

    it('ApprovalManager should work without config parameter', () => {
      // Old usage patterns should still work
      expect(() => new ApprovalManager()).not.toThrow();
      expect(() => new ApprovalManager(undefined)).not.toThrow();

      const manager = new ApprovalManager();
      expect(manager).toBeDefined();
    });

    it('ModelClientFactory should be constructable without arguments', () => {
      const factory = new ModelClientFactory();
      expect(factory).toBeDefined();
    });
  });

  describe('Default Behavior', () => {
    it('Session should have sensible defaults without config', () => {
      const session = new Session();

      // Should have default turn context
      const turnContext = session.getTurnContext();
      expect(turnContext).toBeDefined();
      expect(turnContext.getModel()).toBeDefined();
    });

    it('ToolRegistry should have default behavior without config', async () => {
      const registry = new ToolRegistry();

      // Should be able to register tools with the correct definition shape
      await expect(registry.register({
        type: 'function',
        function: {
          name: 'test-tool',
          description: 'Test tool',
          strict: false,
          parameters: { type: 'object', properties: {} }
        }
      }, async () => ({ success: true }))).resolves.not.toThrow();
    });

    it('ApprovalManager should have default policy without config', () => {
      const manager = new ApprovalManager();

      // Should have default approval policy
      // @ts-expect-error - accessing private property for testing
      expect(manager.policy).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(manager.policy.mode).toBeDefined();
    });
  });

  describe('Mixed Usage', () => {
    it('should allow Session and ToolRegistry with or without config', () => {
      // Mix of components with and without config
      const sessionWithoutConfig = new Session();
      const registryWithoutConfig = new ToolRegistry();

      // All should work
      expect(sessionWithoutConfig).toBeDefined();
      expect(registryWithoutConfig).toBeDefined();
    });
  });
});
