import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { AgentConfig } from '@/config/AgentConfig';

describe('ToolRegistry - AgentConfig Integration', () => {
  describe('Constructor', () => {
    it('should accept optional AgentConfig parameter as first argument', () => {
      const config = AgentConfig.getInstance();

      // This should not throw
      expect(() => new ToolRegistry(config)).not.toThrow();
      expect(() => new ToolRegistry(config, undefined)).not.toThrow();
    });

    it('should work without config (backward compatibility)', () => {
      expect(() => new ToolRegistry()).not.toThrow();
      expect(() => new ToolRegistry(undefined)).not.toThrow();
      expect(() => new ToolRegistry(undefined, undefined)).not.toThrow();
    });

    it('should store config reference when provided', () => {
      const config = AgentConfig.getInstance();
      const registry = new ToolRegistry(config);

      // @ts-expect-error - accessing private property for testing
      expect(registry.config).toBe(config);
    });
  });

  describe('Config Usage', () => {
    it('should use config for enabled tools', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const registry = new ToolRegistry(config);

      // These methods should exist after implementation
      expect(registry.getEnabledTools).toBeDefined();
      expect(Array.isArray(registry.getEnabledTools())).toBe(true);
    });

    it('should use config for tool timeout', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const registry = new ToolRegistry(config);

      // These methods should exist after implementation
      expect(registry.getToolTimeout).toBeDefined();
      expect(typeof registry.getToolTimeout()).toBe('number');
    });

    it('should use config for sandbox policy', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const registry = new ToolRegistry(config);

      // These methods should exist after implementation
      expect(registry.getSandboxPolicy).toBeDefined();
      expect(registry.getSandboxPolicy()).toBeDefined();
    });
  });
});