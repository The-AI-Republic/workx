/**
 * Unit tests for MCPClient
 * Task: T012 [US1]
 *
 * Note: MCPClient relies on the MCP SDK Client which uses the Transport interface.
 * Full integration testing requires a mock MCP server.
 * These tests focus on client construction and state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MCPClient } from '../MCPClient';
import type { IMCPServerConfig } from '../types';

describe('MCPClient', () => {
  const createConfig = (overrides: Partial<IMCPServerConfig> = {}): IMCPServerConfig => ({
    id: 'test-server-id',
    name: 'test-server',
    url: 'https://example.com/mcp',
    enabled: true,
    timeout: 30000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  });

  describe('constructor', () => {
    it('should create a client with the given configuration', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client).toBeDefined();
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should initialize with empty tools and resources', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getTools()).toEqual([]);
      expect(client.getResources()).toEqual([]);
    });
  });

  describe('getters', () => {
    it('should return configId', () => {
      const config = createConfig({ id: 'my-config-id' });
      const client = new MCPClient({ config });

      expect(client.getConfigId()).toBe('my-config-id');
    });

    it('should return undefined serverInfo before connection', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getServerInfo()).toBeUndefined();
    });

    it('should return undefined capabilities before connection', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getCapabilities()).toBeUndefined();
    });

    it('should return undefined protocolVersion before connection', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getProtocolVersion()).toBeUndefined();
    });

    it('should return undefined lastError initially', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getLastError()).toBeUndefined();
    });
  });

  describe('status tracking', () => {
    it('should start in disconnected status', () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      expect(client.getStatus()).toBe('disconnected');
    });

    it('should call onStatusChange when status changes', async () => {
      const config = createConfig();
      const onStatusChange = vi.fn();
      const client = new MCPClient({ config, onStatusChange });

      // Trigger connect (will fail but should update status)
      try {
        await client.connect();
      } catch {
        // Expected to fail
      }

      // Should have been called with 'connecting' at minimum
      expect(onStatusChange).toHaveBeenCalledWith('connecting', undefined);
    });
  });

  describe('listTools', () => {
    it('should throw if not connected', async () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      await expect(client.listTools()).rejects.toThrow('Not connected');
    });
  });

  describe('callTool', () => {
    it('should throw if not connected', async () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      await expect(client.callTool('test-tool', {})).rejects.toThrow(
        'Not connected'
      );
    });
  });

  describe('readResource', () => {
    it('should throw if not connected', async () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      await expect(client.readResource('file:///test.txt')).rejects.toThrow(
        'Not connected'
      );
    });
  });

  describe('disconnect', () => {
    it('should be idempotent when already disconnected', async () => {
      const config = createConfig();
      const client = new MCPClient({ config });

      // Should not throw
      await client.disconnect();
      await client.disconnect();

      expect(client.getStatus()).toBe('disconnected');
    });
  });
});
