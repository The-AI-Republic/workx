import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalManager } from '@/core/ApprovalManager';
import { AgentConfig } from '@/config/AgentConfig';

describe('ApprovalManager - AgentConfig Integration', () => {
  describe('Constructor', () => {
    it('should accept optional AgentConfig parameter as first argument', async () => {
      const config = await AgentConfig.getInstance();

      // This should not throw
      expect(() => new ApprovalManager(config)).not.toThrow();
      expect(() => new ApprovalManager(config, undefined)).not.toThrow();
    });

    it('should work without config (backward compatibility)', () => {
      expect(() => new ApprovalManager()).not.toThrow();
      expect(() => new ApprovalManager(undefined)).not.toThrow();
      expect(() => new ApprovalManager(undefined, undefined)).not.toThrow();
    });

    it('should store config reference when provided', async () => {
      const config = await AgentConfig.getInstance();
      const approvalManager = new ApprovalManager(config);

      // @ts-expect-error - accessing private property for testing
      expect(approvalManager.config).toBe(config);
    });
  });

  describe('Config Usage', () => {
    it('should use config for default policy', async () => {
      const config = await AgentConfig.getInstance();

      const approvalManager = new ApprovalManager(config);

      // These methods should exist after implementation
      expect(approvalManager.getDefaultPolicy).toBeDefined();
      expect(approvalManager.getDefaultPolicy()).toBeDefined();
    });

    it('should use config for auto approve list', async () => {
      const config = await AgentConfig.getInstance();

      const approvalManager = new ApprovalManager(config);

      // These methods should exist after implementation
      expect(approvalManager.getAutoApproveList).toBeDefined();
      expect(Array.isArray(approvalManager.getAutoApproveList())).toBe(true);
    });

    it('should use config for approval timeout', async () => {
      const config = await AgentConfig.getInstance();

      const approvalManager = new ApprovalManager(config);

      // These methods should exist after implementation
      expect(approvalManager.getApprovalTimeout).toBeDefined();
      expect(typeof approvalManager.getApprovalTimeout()).toBe('number');
    });
  });
});
