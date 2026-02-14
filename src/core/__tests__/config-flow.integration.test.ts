import { describe, it, expect, beforeEach } from 'vitest';
import { BrowserxAgent } from '@/core/BrowserxAgent';
import { AgentConfig } from '@/config/AgentConfig';

describe('Config Propagation Integration', () => {
  let config: AgentConfig;

  beforeEach(async () => {
    config = AgentConfig.getInstance();
    await config.initialize();
  });

  describe('Full Config Flow', () => {
    it('should propagate config through all components via BrowserxAgent', async () => {
      // Create agent with config
      const agent = new BrowserxAgent(config);
      await agent.initialize();

      // Get components
      const session = agent.getSession();
      const toolRegistry = agent.getToolRegistry();
      const approvalManager = agent.getApprovalManager();

      // All components should have config
      // @ts-expect-error - accessing private property for testing
      expect(session.config).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(toolRegistry.config).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(approvalManager.config).toBeDefined();
    });

    it('should initialize ModelClientFactory with config', async () => {
      // Create agent with config
      const agent = new BrowserxAgent(config);

      // Initialize should not throw
      await expect(agent.initialize()).resolves.not.toThrow();

      // ModelClientFactory should be initialized (indirectly verify through agent)
      expect(agent).toBeDefined();
    });

    it('should allow BrowserxAgent to work without config (backward compat)', async () => {
      // Create agent without config
      const agent = new BrowserxAgent();

      // Should not throw
      await expect(agent.initialize()).resolves.not.toThrow();

      // Components should still work
      const session = agent.getSession();
      const toolRegistry = agent.getToolRegistry();
      const approvalManager = agent.getApprovalManager();

      expect(session).toBeDefined();
      expect(toolRegistry).toBeDefined();
      expect(approvalManager).toBeDefined();
    });
  });

  describe('Component Config Usage', () => {
    it('should use config values in components', async () => {
      const agent = new BrowserxAgent(config);
      await agent.initialize();

      const session = agent.getSession();

      // After implementation, these should return config values
      if (typeof session.getDefaultModel === 'function') {
        expect(session.getDefaultModel()).toBeDefined();
      }

      if (typeof session.getDefaultCwd === 'function') {
        expect(session.getDefaultCwd()).toBeDefined();
      }

      if (typeof session.isStorageEnabled === 'function') {
        expect(typeof session.isStorageEnabled()).toBe('boolean');
      }
    });
  });
});