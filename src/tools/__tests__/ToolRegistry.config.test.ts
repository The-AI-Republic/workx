import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '@/tools/ToolRegistry';

describe('ToolRegistry - Constructor and Configuration', () => {
  describe('Constructor', () => {
    it('should create instance without arguments', () => {
      expect(() => new ToolRegistry()).not.toThrow();
    });

    it('should accept optional eventCollector parameter', () => {
      const collector = { collect: () => {} };
      expect(() => new ToolRegistry(collector)).not.toThrow();
    });

    it('should start with no registered tools', async () => {
      const registry = new ToolRegistry();
      const result = await registry.discover();
      expect(result.tools).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('Tool Registration', () => {
    it('should register and discover a function tool', async () => {
      const registry = new ToolRegistry();
      const toolDef = {
        type: 'function' as const,
        function: {
          name: 'test_tool',
          description: 'A test tool',
          strict: false,
          parameters: { type: 'object', properties: {} },
        },
      };

      await registry.register(toolDef, async () => ({ success: true }));

      const result = await registry.discover();
      expect(result.total).toBe(1);
      expect(result.tools[0]).toEqual(toolDef);
    });

    it('should reject duplicate tool registration', async () => {
      const registry = new ToolRegistry();
      const toolDef = {
        type: 'function' as const,
        function: {
          name: 'dup_tool',
          description: 'A duplicate tool',
          strict: false,
          parameters: { type: 'object', properties: {} },
        },
      };

      await registry.register(toolDef, async () => ({ success: true }));
      await expect(
        registry.register(toolDef, async () => ({ success: true }))
      ).rejects.toThrow("Tool 'dup_tool' is already registered");
    });
  });
});
