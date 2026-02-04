/**
 * Integration tests for MCP tool execution
 * Task: T031 [US2]
 *
 * Tests the end-to-end flow of tool discovery and execution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPToolAdapter, registerMCPTools, unregisterMCPTools, type IToolRegistry } from '../MCPToolAdapter';
import type { IMCPTool, IMCPManager, IMCPToolResult } from '../types';
import type { ToolDefinition, ToolHandler } from '../../../tools/BaseTool';

describe('MCP Tool Execution Integration', () => {
  // Mock tool registry
  let registeredTools: Map<string, { definition: ToolDefinition; handler: ToolHandler }>;

  const mockRegistry: IToolRegistry = {
    register: vi.fn(async (definition: ToolDefinition, handler: ToolHandler) => {
      const name = definition.type === 'function' ? definition.function.name : 'unknown';
      registeredTools.set(name, { definition, handler });
    }),
    unregister: vi.fn(async (name: string) => {
      registeredTools.delete(name);
    }),
  };

  beforeEach(() => {
    registeredTools = new Map();
    vi.clearAllMocks();
  });

  describe('registerMCPTools', () => {
    it('should register all tools from a server', async () => {
      const tools: IMCPTool[] = [
        {
          name: 'search',
          description: 'Search repositories',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: 'create_issue',
          description: 'Create an issue',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ];

      const mockManager = {
        executeTool: vi.fn(),
      } as unknown as IMCPManager;

      await registerMCPTools(mockManager, 'github', tools, mockRegistry);

      expect(mockRegistry.register).toHaveBeenCalledTimes(2);
      expect(registeredTools.has('github:search')).toBe(true);
      expect(registeredTools.has('github:create_issue')).toBe(true);
    });

    it('should create handlers that execute tools via manager', async () => {
      const tools: IMCPTool[] = [
        {
          name: 'search',
          description: 'Search',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      const mockResult: IMCPToolResult = {
        content: [{ type: 'text', text: 'Found 10 results' }],
        isError: false,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      await registerMCPTools(mockManager, 'github', tools, mockRegistry);

      const tool = registeredTools.get('github:search');
      expect(tool).toBeDefined();

      const result = await tool!.handler({ query: 'test' });

      expect(mockManager.executeTool).toHaveBeenCalledWith('github:search', { query: 'test' });
      expect(result).toBe('Found 10 results');
    });
  });

  describe('unregisterMCPTools', () => {
    it('should unregister all tools from a server', async () => {
      const tools: IMCPTool[] = [
        { name: 'tool1', description: 'Tool 1', inputSchema: { type: 'object', properties: {} } },
        { name: 'tool2', description: 'Tool 2', inputSchema: { type: 'object', properties: {} } },
      ];

      // First register
      const mockManager = { executeTool: vi.fn() } as unknown as IMCPManager;
      await registerMCPTools(mockManager, 'server', tools, mockRegistry);

      expect(registeredTools.size).toBe(2);

      // Then unregister
      await unregisterMCPTools('server', tools, mockRegistry);

      expect(mockRegistry.unregister).toHaveBeenCalledWith('server:tool1');
      expect(mockRegistry.unregister).toHaveBeenCalledWith('server:tool2');
      expect(registeredTools.size).toBe(0);
    });
  });

  describe('end-to-end tool execution', () => {
    it('should handle successful tool execution', async () => {
      const adapter = new MCPToolAdapter();

      const tool: IMCPTool = {
        name: 'get_weather',
        description: 'Get weather for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string' },
          },
          required: ['location'],
        },
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: 'Weather in New York: 72°F, Sunny' },
          ],
          isError: false,
        }),
      } as unknown as IMCPManager;

      // Adapt tool
      const definition = adapter.adaptTool(tool, 'weather');
      expect(definition.function.name).toBe('weather:get_weather');

      // Create handler
      const handler = adapter.createHandler(mockManager, 'weather', 'get_weather');

      // Execute
      const result = await handler({ location: 'New York' });

      expect(result).toBe('Weather in New York: 72°F, Sunny');
      expect(mockManager.executeTool).toHaveBeenCalledWith('weather:get_weather', {
        location: 'New York',
      });
    });

    it('should handle tool execution errors gracefully', async () => {
      const adapter = new MCPToolAdapter();

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'API rate limit exceeded' }],
          isError: true,
        }),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'api', 'call');

      await expect(handler({})).rejects.toThrow('API rate limit exceeded');
    });

    it('should handle connection errors', async () => {
      const adapter = new MCPToolAdapter();

      const mockManager = {
        executeTool: vi.fn().mockRejectedValue(new Error('Server disconnected')),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'api', 'call');

      await expect(handler({})).rejects.toThrow('Server disconnected');
    });

    it('should handle complex multi-content results', async () => {
      const adapter = new MCPToolAdapter();

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue({
          content: [
            { type: 'text', text: '## Search Results' },
            { type: 'text', text: '1. Result one' },
            { type: 'text', text: '2. Result two' },
            { type: 'resource_link', uri: 'https://example.com/more', name: 'More results' },
          ],
          isError: false,
        }),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'search', 'query');
      const result = await handler({ q: 'test' });

      expect(result).toContain('## Search Results');
      expect(result).toContain('1. Result one');
      expect(result).toContain('2. Result two');
      expect(result).toContain('More results');
      expect(result).toContain('https://example.com/more');
    });
  });

  describe('tool schema preservation', () => {
    it('should preserve required fields in schema', () => {
      const adapter = new MCPToolAdapter();

      const tool: IMCPTool = {
        name: 'create_file',
        description: 'Create a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      };

      const definition = adapter.adaptTool(tool, 'fs');

      expect((definition.function.parameters as any).required).toEqual(['path', 'content']);
    });

    it('should preserve nested schema structures', () => {
      const adapter = new MCPToolAdapter();

      const tool: IMCPTool = {
        name: 'complex_tool',
        description: 'A complex tool',
        inputSchema: {
          type: 'object',
          properties: {
            config: {
              type: 'object',
              properties: {
                nested: { type: 'string' },
                array: {
                  type: 'array',
                  items: { type: 'number' },
                },
              },
            },
          },
        },
      };

      const definition = adapter.adaptTool(tool, 'server');

      expect((definition.function.parameters as any).properties?.config?.type).toBe('object');
      expect((definition.function.parameters as any).properties?.config?.properties?.array?.type).toBe('array');
    });
  });
});
