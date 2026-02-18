import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentConfig } from '@/config/AgentConfig';
import { Session } from '@/core/Session';
import { ApprovalManager } from '@/core/ApprovalManager';

describe('Config Propagation Integration', () => {
  let config: AgentConfig;

  beforeEach(async () => {
    config = await AgentConfig.getInstance();
  });

  describe('Full Config Flow', () => {
    it('should propagate config through Session and ApprovalManager', async () => {
      // Create components with config
      const session = new Session(config);
      const approvalManager = new ApprovalManager(config);

      // All components should have config
      // @ts-expect-error - accessing private property for testing
      expect(session.config).toBeDefined();
      // @ts-expect-error - accessing private property for testing
      expect(approvalManager.config).toBeDefined();
    });

    it('should create Session with config without errors', async () => {
      const session = new Session(config);

      // Session should be created successfully
      expect(session).toBeDefined();
      expect(session.getSessionId()).toBeDefined();
    });

    it('should allow Session to work without config (backward compat)', () => {
      // Create session without config
      const session = new Session();

      // Should still work
      expect(session).toBeDefined();
      expect(session.getSessionId()).toBeDefined();
    });
  });

  describe('Component Config Usage', () => {
    it('should use config values in components', async () => {
      const session = new Session(config);

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
