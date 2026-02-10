/**
 * Unit tests for MCPToolAdapter
 * Task: T030 [US2]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPToolAdapter } from '../MCPToolAdapter';
import type { IMCPTool, IMCPManager, IMCPToolResult } from '../types';

describe('MCPToolAdapter', () => {
  let adapter: MCPToolAdapter;

  beforeEach(() => {
    adapter = new MCPToolAdapter();
  });

  describe('adaptTool', () => {
    it('should convert MCP tool to ToolDefinition with prefixed name', () => {
      const mcpTool: IMCPTool = {
        name: 'search_repositories',
        description: 'Search GitHub repositories',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
          },
          required: ['query'],
        },
      };

      const toolDef = adapter.adaptTool(mcpTool, 'github');

      expect(toolDef.type).toBe('function');
      expect(toolDef.function.name).toBe('github:search_repositories');
      expect(toolDef.function.description).toBe('Search GitHub repositories');
      expect(toolDef.function.parameters).toEqual(mcpTool.inputSchema);
    });

    it('should include server name in description if not present', () => {
      const mcpTool: IMCPTool = {
        name: 'list_files',
        description: 'List files in directory',
        inputSchema: { type: 'object', properties: {} },
      };

      const toolDef = adapter.adaptTool(mcpTool, 'filesystem');

      expect(toolDef.function.description).toContain('filesystem');
    });

    it('should handle tools without description', () => {
      const mcpTool: IMCPTool = {
        name: 'ping',
        description: '',
        inputSchema: { type: 'object', properties: {} },
      };

      const toolDef = adapter.adaptTool(mcpTool, 'network');

      expect(toolDef.function.name).toBe('network:ping');
      expect(toolDef.function.description).toBeTruthy();
    });

    it('should preserve complex inputSchema', () => {
      const mcpTool: IMCPTool = {
        name: 'create_issue',
        description: 'Create a GitHub issue',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
            labels: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['title'],
        },
      };

      const toolDef = adapter.adaptTool(mcpTool, 'github');

      expect(toolDef.function.parameters).toEqual(mcpTool.inputSchema);
    });
  });

  describe('parsePrefixedName', () => {
    it('should parse valid prefixed tool name', () => {
      const result = adapter.parsePrefixedName('github:search_repositories');

      expect(result).toEqual({
        serverName: 'github',
        toolName: 'search_repositories',
      });
    });

    it('should handle tool names with multiple colons', () => {
      const result = adapter.parsePrefixedName('server:tool:with:colons');

      expect(result).toEqual({
        serverName: 'server',
        toolName: 'tool:with:colons',
      });
    });

    it('should return null for name without colon', () => {
      const result = adapter.parsePrefixedName('invalid_name');

      expect(result).toBeNull();
    });

    it('should return null for empty server name', () => {
      const result = adapter.parsePrefixedName(':tool_name');

      expect(result).toBeNull();
    });

    it('should return null for empty tool name', () => {
      const result = adapter.parsePrefixedName('server:');

      expect(result).toBeNull();
    });

    it('should return null for empty string', () => {
      const result = adapter.parsePrefixedName('');

      expect(result).toBeNull();
    });
  });

  describe('createHandler', () => {
    it('should create a handler that calls manager.executeTool', async () => {
      const mockResult: IMCPToolResult = {
        content: [{ type: 'text', text: 'Search results...' }],
        isError: false,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'github', 'search');

      const result = await handler({ query: 'test' });

      expect(mockManager.executeTool).toHaveBeenCalledWith('github:search', {
        query: 'test',
      });
      expect(result).toBe('Search results...');
    });

    it('should concatenate multiple text contents', async () => {
      const mockResult: IMCPToolResult = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
        ],
        isError: false,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'server', 'tool');

      const result = await handler({});

      expect(result).toBe('Line 1\nLine 2');
    });

    it('should handle image content', async () => {
      const mockResult: IMCPToolResult = {
        content: [
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
        ],
        isError: false,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'server', 'tool');

      const result = await handler({});

      expect(result).toContain('image/png');
      expect(result).toContain('base64data');
    });

    it('should throw error when tool execution fails', async () => {
      const mockResult: IMCPToolResult = {
        content: [{ type: 'text', text: 'Rate limit exceeded' }],
        isError: true,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'github', 'search');

      await expect(handler({})).rejects.toThrow('Rate limit exceeded');
    });

    it('should handle manager throwing error', async () => {
      const mockManager = {
        executeTool: vi.fn().mockRejectedValue(new Error('Connection lost')),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'github', 'search');

      await expect(handler({})).rejects.toThrow('Connection lost');
    });

    it('should handle empty content array', async () => {
      const mockResult: IMCPToolResult = {
        content: [],
        isError: false,
      };

      const mockManager = {
        executeTool: vi.fn().mockResolvedValue(mockResult),
      } as unknown as IMCPManager;

      const handler = adapter.createHandler(mockManager, 'server', 'tool');

      const result = await handler({});

      expect(result).toBe('');
    });
  });

  describe('formatToolResult', () => {
    it('should format text content', () => {
      const result = adapter.formatToolResult({
        content: [{ type: 'text', text: 'Hello world' }],
        isError: false,
      });

      expect(result).toBe('Hello world');
    });

    it('should format multiple text contents with newlines', () => {
      const result = adapter.formatToolResult({
        content: [
          { type: 'text', text: 'First' },
          { type: 'text', text: 'Second' },
        ],
        isError: false,
      });

      expect(result).toBe('First\nSecond');
    });

    it('should format image content as data URL reference', () => {
      const result = adapter.formatToolResult({
        content: [
          { type: 'image', data: 'abc123', mimeType: 'image/jpeg' },
        ],
        isError: false,
      });

      expect(result).toContain('[Image: image/jpeg]');
    });

    it('should format resource content', () => {
      const result = adapter.formatToolResult({
        content: [
          {
            type: 'resource',
            resource: {
              uri: 'file:///test.txt',
              name: 'test.txt',
              mimeType: 'text/plain',
            },
          },
        ],
        isError: false,
      });

      expect(result).toContain('test.txt');
      expect(result).toContain('file:///test.txt');
    });

    it('should format resource_link content', () => {
      const result = adapter.formatToolResult({
        content: [
          { type: 'resource_link', uri: 'https://example.com/doc', name: 'Documentation' },
        ],
        isError: false,
      });

      expect(result).toContain('Documentation');
      expect(result).toContain('https://example.com/doc');
    });

    it('should handle mixed content types', () => {
      const result = adapter.formatToolResult({
        content: [
          { type: 'text', text: 'Results:' },
          { type: 'image', data: 'img', mimeType: 'image/png' },
          { type: 'text', text: 'End of results' },
        ],
        isError: false,
      });

      expect(result).toContain('Results:');
      expect(result).toContain('[Image: image/png]');
      expect(result).toContain('End of results');
    });
  });
});
