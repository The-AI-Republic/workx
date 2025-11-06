import { describe, it, expect } from 'vitest';
import { Session } from '../../src/core/Session';
import { ToolRegistry } from '../../src/tools/ToolRegistry';
import { ApprovalManager } from '../../src/core/ApprovalManager';
import { ModelClientFactory } from '../../src/models/ModelClientFactory';
import { BrowserxAgent } from '../../src/core/BrowserxAgent';

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

    it('ModelClientFactory should work without initialization', async () => {
      const factory = new ModelClientFactory();

      // Should be able to create clients without initialization
      // (using default config or environment variables)
      const client = await factory.createClientForModel('default');
      expect(client).toBeDefined();
    });

    it('BrowserxAgent should work without config parameter', async () => {
      // Old usage should still work
      const agent = new BrowserxAgent();
      expect(agent).toBeDefined();

      // Initialize without config
      await expect(agent.initialize()).resolves.not.toThrow();

      // All components should be accessible
      expect(agent.getSession()).toBeDefined();
      expect(agent.getToolRegistry()).toBeDefined();
      expect(agent.getApprovalManager()).toBeDefined();
    });
  });

  describe('Default Behavior', () => {
    it('Session should have sensible defaults without config', () => {
      const session = new Session();

      // Should have default turn context
      const turnContext = session.getTurnContext();
      expect(turnContext).toBeDefined();
      expect(turnContext.model).toBeDefined();
      expect(turnContext.cwd).toBeDefined();
    });

    it('ToolRegistry should have default behavior without config', () => {
      const registry = new ToolRegistry();

      // Should be able to register tools
      expect(() => registry.register({
        name: 'test-tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} }
      }, async () => ({ success: true }))).not.toThrow();
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
    it('should allow some components with config and others without', async () => {
      const config = (await import('../../src/config/AgentConfig')).AgentConfig.getInstance();
      await config.initialize();

      // Mix of components with and without config
      const sessionWithConfig = new Session(config);
      const sessionWithoutConfig = new Session();

      const registryWithConfig = new ToolRegistry(config);
      const registryWithoutConfig = new ToolRegistry();

      // All should work
      expect(sessionWithConfig).toBeDefined();
      expect(sessionWithoutConfig).toBeDefined();
      expect(registryWithConfig).toBeDefined();
      expect(registryWithoutConfig).toBeDefined();
    });

    it('should allow gradual migration to config-based setup', async () => {
      // Start with no config
      const agent1 = new BrowserxAgent();
      await agent1.initialize();

      // Later, use with config
      const config = (await import('../../src/config/AgentConfig')).AgentConfig.getInstance();
      await config.initialize();
      const agent2 = new BrowserxAgent(config);
      await agent2.initialize();

      // Both should work
      expect(agent1.getSession()).toBeDefined();
      expect(agent2.getSession()).toBeDefined();
    });
  });
});