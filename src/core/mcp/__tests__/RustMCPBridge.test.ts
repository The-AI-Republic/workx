/**
 * Unit tests for RustMCPBridge
 *
 * Tests the thin JS adapter that delegates to Tauri invoke() for stdio MCP servers.
 * Mocks @tauri-apps/api/core to verify correct invoke calls and response mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RustMCPBridge } from '../RustMCPBridge';
import type { IMCPServerConfig } from '../types';

// Mock Tauri invoke
const mockInvoke = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

describe('RustMCPBridge', () => {
  const createConfig = (overrides: Partial<IMCPServerConfig> = {}): IMCPServerConfig => ({
    id: 'test-server-id',
    name: 'browser',
    url: '',
    transport: 'stdio',
    platform: 'desktop',
    builtin: true,
    command: 'npx',
    args: ['chrome-devtools-mcp'],
    enabled: true,
    timeout: 180000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a bridge with disconnected status', () => {
      const bridge = new RustMCPBridge({ config: createConfig() });

      expect(bridge.getStatus()).toBe('disconnected');
      expect(bridge.getTools()).toEqual([]);
      expect(bridge.getResources()).toEqual([]);
      expect(bridge.getConfigId()).toBe('test-server-id');
    });
  });

  describe('connect', () => {
    it('should call mcp_connect via invoke and store server info', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'chrome-devtools-mcp',
            server_version: '1.0.0',
            protocol_version: '2025-03-26',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        if (cmd === 'mcp_list_tools') {
          return Promise.resolve([
            { name: 'click', description: 'Click element', input_schema: { type: 'object' } },
          ]);
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      expect(bridge.getStatus()).toBe('connected');
      expect(bridge.getServerInfo()).toEqual({
        name: 'chrome-devtools-mcp',
        version: '1.0.0',
      });
      expect(bridge.getProtocolVersion()).toBe('2025-03-26');
      expect(bridge.getCapabilities()?.tools).toBeDefined();
      expect(bridge.getCapabilities()?.resources).toBeUndefined();

      expect(mockInvoke).toHaveBeenCalledWith('mcp_connect', {
        serverId: 'test-server-id',
        command: 'npx',
        args: ['chrome-devtools-mcp'],
        env: undefined,
        cwd: undefined,
      });
    });

    it('should throw on connection failure', async () => {
      mockInvoke.mockResolvedValue({
        success: false,
        error: 'Process not found',
      });

      const bridge = new RustMCPBridge({ config: createConfig() });

      await expect(bridge.connect()).rejects.toThrow('Process not found');
      expect(bridge.getStatus()).toBe('error');
      expect(bridge.getLastError()).toContain('Process not found');
    });

    it('should be idempotent when already connected', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      mockInvoke.mockClear();
      await bridge.connect(); // Should be a no-op

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should call onStatusChange callback', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: false, resources: false, prompts: false },
          });
        }
        return Promise.resolve([]);
      });

      const onStatusChange = vi.fn();
      const bridge = new RustMCPBridge({ config: createConfig(), onStatusChange });
      await bridge.connect();

      expect(onStatusChange).toHaveBeenCalledWith('connecting', undefined);
      expect(onStatusChange).toHaveBeenCalledWith('connected', undefined);
    });
  });

  describe('disconnect', () => {
    it('should call mcp_disconnect via invoke', async () => {
      // First connect
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: false, resources: false, prompts: false },
          });
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      mockInvoke.mockClear();
      mockInvoke.mockResolvedValue(true);

      await bridge.disconnect();

      expect(bridge.getStatus()).toBe('disconnected');
      expect(mockInvoke).toHaveBeenCalledWith('mcp_disconnect', {
        serverId: 'test-server-id',
      });
    });

    it('should be idempotent when already disconnected', async () => {
      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.disconnect(); // Should not throw

      expect(bridge.getStatus()).toBe('disconnected');
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it('should clean up state on disconnect', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        if (cmd === 'mcp_list_tools') {
          return Promise.resolve([
            { name: 'click', description: 'Click', input_schema: {} },
          ]);
        }
        return Promise.resolve(true);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();
      expect(bridge.getTools()).toHaveLength(1);

      await bridge.disconnect();
      expect(bridge.getTools()).toHaveLength(0);
      expect(bridge.getServerInfo()).toBeUndefined();
      expect(bridge.getCapabilities()).toBeUndefined();
    });
  });

  describe('listTools', () => {
    it('should throw if not connected', async () => {
      const bridge = new RustMCPBridge({ config: createConfig() });

      await expect(bridge.listTools()).rejects.toThrow('Not connected');
    });

    it('should map Rust tool definitions to IMCPTool format', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        if (cmd === 'mcp_list_tools') {
          return Promise.resolve([
            {
              name: 'click',
              description: 'Click an element',
              input_schema: {
                type: 'object',
                properties: { selector: { type: 'string' } },
              },
            },
            {
              name: 'take_snapshot',
              description: null,
              input_schema: { type: 'object' },
            },
          ]);
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      const tools = bridge.getTools();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('click');
      expect(tools[0].description).toBe('Click an element');
      expect(tools[1].description).toBe('');
    });
  });

  describe('callTool', () => {
    it('should throw if not connected', async () => {
      const bridge = new RustMCPBridge({ config: createConfig() });

      await expect(bridge.callTool('click', {})).rejects.toThrow('Not connected');
    });

    it('should map Rust tool result to IMCPToolResult', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        if (cmd === 'mcp_list_tools') {
          return Promise.resolve([]);
        }
        if (cmd === 'mcp_call_tool') {
          return Promise.resolve({
            content: [
              { type: 'text', text: 'Clicked element' },
            ],
            is_error: false,
          });
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      const result = await bridge.callTool('click', { selector: '#submit' });

      expect(result.isError).toBe(false);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Clicked element' });

      expect(mockInvoke).toHaveBeenCalledWith('mcp_call_tool', {
        serverId: 'test-server-id',
        toolName: 'click',
        arguments: { selector: '#submit' },
        timeoutMs: 180000,
      });
    });

    it('should return error result on invoke failure', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'mcp_connect') {
          return Promise.resolve({
            success: true,
            server_name: 'test',
            server_version: '1.0',
            capabilities: { tools: true, resources: false, prompts: false },
          });
        }
        if (cmd === 'mcp_list_tools') {
          return Promise.resolve([]);
        }
        if (cmd === 'mcp_call_tool') {
          return Promise.reject(new Error('Timeout'));
        }
        return Promise.resolve([]);
      });

      const bridge = new RustMCPBridge({ config: createConfig() });
      await bridge.connect();

      const result = await bridge.callTool('click', {});

      expect(result.isError).toBe(true);
      expect((result.content[0] as any).text).toContain('Timeout');
    });
  });

  describe('readResource', () => {
    it('should throw if not connected', async () => {
      const bridge = new RustMCPBridge({ config: createConfig() });

      await expect(bridge.readResource('file:///test.txt')).rejects.toThrow('Not connected');
    });
  });

  describe('getters', () => {
    it('should return configId from options', () => {
      const bridge = new RustMCPBridge({ config: createConfig({ id: 'my-id' }) });
      expect(bridge.getConfigId()).toBe('my-id');
    });

    it('should return undefined lastError initially', () => {
      const bridge = new RustMCPBridge({ config: createConfig() });
      expect(bridge.getLastError()).toBeUndefined();
    });
  });
});
