import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';
import { AgentConfig } from '@/config/AgentConfig';

describe('ToolRegistry - Initialize Method', () => {
  describe('Initialize Method', () => {
    it('should have an initialize method that accepts AgentConfig', () => {
      const registry = new ToolRegistry();

      // Method should exist
      expect(registry.initialize).toBeDefined();
      expect(typeof registry.initialize).toBe('function');
    });

    it('should accept AgentConfig and return a Promise', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const registry = new ToolRegistry();

      // Should return a Promise
      const result = registry.initialize(config);
      expect(result).toBeInstanceOf(Promise);

      // Should not throw
      await expect(result).resolves.not.toThrow();
    });

    it('should be idempotent - safe to call multiple times', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      const registry = new ToolRegistry();

      // Should not throw when called multiple times
      await expect(registry.initialize(config)).resolves.not.toThrow();
      await expect(registry.initialize(config)).resolves.not.toThrow();
    });

    it('should work with config passed in constructor and initialize', async () => {
      const config = AgentConfig.getInstance();
      await config.initialize();

      // Pass config in constructor
      const registry = new ToolRegistry(config);

      // Should still work with initialize
      await expect(registry.initialize(config)).resolves.not.toThrow();
    });
  });
});