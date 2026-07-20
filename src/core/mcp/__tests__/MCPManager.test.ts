/**
 * Unit tests for MCPManager
 * Task: T014 [US1]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../MCPManager';
import type { IMCPServerConfig, IMCPServerConfigCreate, MCPManagerEvent } from '../types';
import { setConfigStorage, type ConfigStorageProvider } from '../../storage/ConfigStorageProvider';

// Map-based ConfigStorageProvider mock
const store = new Map<string, any>();

function createMockConfigStorage(): ConfigStorageProvider {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null) as any,
    set: vi.fn(async (key: string, value: any) => { store.set(key, value); }) as any,
    remove: vi.fn(async (key: string) => { store.delete(key); }),
    getMany: vi.fn(async (keys: string[]) => {
      const result: Record<string, any> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key);
      }
      return result;
    }) as any,
    setMany: vi.fn(async (items: Record<string, any>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }) as any,
    removeMany: vi.fn(async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    }),
    getAll: vi.fn(async () => Object.fromEntries(store)),
    clear: vi.fn(async () => { store.clear(); }),
    getBytesInUse: vi.fn(async () => null),
  };
}

// Mock crypto.randomUUID - must return a valid UUID format.
// Counter is zero-padded to 12 hex chars (last UUID segment) so we can
// generate up to 16^12 distinct UUIDs — well over the 100-server cap.
let uuidCounter = 0;
const mockRandomUUID = vi.fn(() => {
  uuidCounter++;
  const tail = uuidCounter.toString(16).padStart(12, '0');
  return `550e8400-e29b-41d4-a716-${tail}`;
});

// Mock MCPClient functions
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetServerInfo = vi.fn().mockReturnValue({ name: 'test', version: '1.0' });
const mockGetCapabilities = vi.fn().mockReturnValue({ tools: {} });
const mockGetTools = vi.fn().mockReturnValue([]);
const mockGetResources = vi.fn().mockReturnValue([]);
const mockCallTool = vi.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'result' }],
  isError: false,
});
const mockGetProtocolVersion = vi.fn().mockReturnValue('2025-01-01');
const mockReadResource = vi.fn().mockResolvedValue({
  uri: 'file:///test.txt',
  text: 'content',
});

// Mock MCPClient module
vi.mock('../MCPClient', () => {
  return {
    MCPClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      getServerInfo: mockGetServerInfo,
      getCapabilities: mockGetCapabilities,
      getTools: mockGetTools,
      getResources: mockGetResources,
      getProtocolVersion: mockGetProtocolVersion,
      callTool: mockCallTool,
      readResource: mockReadResource,
    })),
  };
});

// Mock encryption
vi.mock('../../utils/encryption', () => ({
  encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
  decryptApiKey: vi.fn((encrypted: string) => encrypted?.replace('encrypted:', '') || null),
}));

describe('MCPManager', () => {
  let mockStorage: ConfigStorageProvider;

  beforeEach(() => {
    // Clear mock storage
    store.clear();

    // Install mock ConfigStorageProvider
    mockStorage = createMockConfigStorage();
    setConfigStorage(mockStorage);

    // Mock crypto.randomUUID (it's read-only in some environments)
    vi.spyOn(crypto, 'randomUUID').mockImplementation(mockRandomUUID as any);

    // Reset UUID counter
    uuidCounter = 0;

    // Reset all mocks
    vi.clearAllMocks();

    // Reset singleton
    MCPManager.resetInstance();
  });

  afterEach(() => {
    MCPManager.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', async () => {
      const instance1 = await MCPManager.getInstance();
      const instance2 = await MCPManager.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('should load existing servers from storage', async () => {
      const existingServers: IMCPServerConfig[] = [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'github',
          url: 'https://github.example.com',
          enabled: true,
          timeout: 30000,
          transport: 'sse' as const,
          platform: 'shared' as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];

      store.set('mcpServers', existingServers);

      const manager = await MCPManager.getInstance();
      const servers = manager.getServers();

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('github');
    });
  });

  describe('addServer', () => {
    it('should add a new server configuration', async () => {
      const manager = await MCPManager.getInstance();

      const input: IMCPServerConfigCreate = {
        name: 'github',
        url: 'https://mcp.github.example.com',
      };

      const config = await manager.addServer(input);

      expect(config.name).toBe('github');
      expect(config.url).toBe('https://mcp.github.example.com');
      expect(config.id).toBeDefined();
      expect(manager.getServers()).toHaveLength(1);
    });

    it('should emit config-added event', async () => {
      const manager = await MCPManager.getInstance();
      const eventHandler = vi.fn();
      manager.on('event', eventHandler);

      await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config-added',
        })
      );
    });

    it('should persist to storage', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      expect(mockStorage.set).toHaveBeenCalled();
    });

    it('should enforce MAX_SERVERS limit (raised to 100 in Track 10)', async () => {
      const manager = await MCPManager.getInstance();

      // Add 100 servers (the post-Track-10 ceiling)
      for (let i = 0; i < 100; i++) {
        await manager.addServer({
          name: `server-${i}`,
          url: `https://server${i}.example.com`,
        });
      }

      // 101st server should fail
      await expect(
        manager.addServer({
          name: 'server-100',
          url: 'https://server100.example.com',
        })
      ).rejects.toThrow(/maximum/i);
    });

    it('Track 10: persists pluginId through addServer round-trip', async () => {
      const manager = await MCPManager.getInstance();
      const config = await manager.addServer({
        name: 'gh-tools',
        url: 'https://gh.example.com',
        pluginId: 'gh-workflow@official',
      });
      expect(config.pluginId).toBe('gh-workflow@official');
      const fetched = manager.getServer(config.id);
      expect(fetched?.pluginId).toBe('gh-workflow@official');
    });

    it('Track 10: removeByPluginId removes only matching plugin servers', async () => {
      const manager = await MCPManager.getInstance();
      await manager.addServer({ name: 'a1', url: 'https://a1.example.com', pluginId: 'plugin-a' });
      await manager.addServer({ name: 'a2', url: 'https://a2.example.com', pluginId: 'plugin-a' });
      await manager.addServer({ name: 'b1', url: 'https://b1.example.com', pluginId: 'plugin-b' });
      await manager.addServer({ name: 'user1', url: 'https://user1.example.com' });

      await manager.removeByPluginId('plugin-a');

      const remaining = manager.getServers().filter((s) => !s.builtin);
      expect(remaining.map((s) => s.name).sort()).toEqual(['b1', 'user1']);
    });

    it('should reject duplicate server names', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'github',
        url: 'https://mcp1.example.com',
      });

      await expect(
        manager.addServer({
          name: 'github',
          url: 'https://mcp2.example.com',
        })
      ).rejects.toThrow(/already exists/i);
    });
  });

  describe('updateServer', () => {
    it('should update existing server configuration', async () => {
      const manager = await MCPManager.getInstance();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      const updated = await manager.updateServer(config.id, {
        name: 'github-updated',
        timeout: 60000,
      });

      expect(updated.name).toBe('github-updated');
      expect(updated.timeout).toBe(60000);
    });

    it('should emit config-updated event', async () => {
      const manager = await MCPManager.getInstance();
      const eventHandler = vi.fn();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      manager.on('event', eventHandler);

      await manager.updateServer(config.id, { name: 'github-updated' });

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config-updated',
        })
      );
    });

    it('should throw for non-existent server', async () => {
      const manager = await MCPManager.getInstance();

      await expect(
        manager.updateServer('non-existent-id', { name: 'test' })
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('removeServer', () => {
    it('should remove server configuration', async () => {
      const manager = await MCPManager.getInstance();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      await manager.removeServer(config.id);

      expect(manager.getServers()).toHaveLength(0);
    });

    it('should emit config-removed event', async () => {
      const manager = await MCPManager.getInstance();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      const eventHandler = vi.fn();
      manager.on('event', eventHandler);

      await manager.removeServer(config.id);

      expect(eventHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'config-removed',
          configId: config.id,
        })
      );
    });

    // Note: This test requires proper MCPClient mocking
    // it('should disconnect before removing if connected', ...);

    it('should throw for non-existent server', async () => {
      const manager = await MCPManager.getInstance();

      await expect(manager.removeServer('non-existent-id')).rejects.toThrow(
        /not found/i
      );
    });
  });

  // Note: Connect/disconnect tests require proper module mocking setup
  // which is complex with Vitest. These features are tested via integration tests.
  describe('connect', () => {
    it('should throw for non-existent server', async () => {
      const manager = await MCPManager.getInstance();

      await expect(manager.connect('non-existent-id')).rejects.toThrow(
        /not found/i
      );
    });

    it('makes concurrent callers await the same connection attempt', async () => {
      const manager = await MCPManager.getInstance();
      const config = await manager.addServer({
        name: 'gateway',
        url: 'https://gateway.example.com/mcp',
        transport: 'sse',
      });
      let finishConnect!: () => void;
      const deferredConnect = vi.fn(
        () => new Promise<void>((resolve) => { finishConnect = resolve; }),
      );
      vi.spyOn(manager as any, 'createAdapter').mockResolvedValue({
        connect: deferredConnect,
        disconnect: vi.fn(),
        getServerInfo: () => ({ name: 'gateway', version: '1.0' }),
        getCapabilities: () => ({ tools: {} }),
        getTools: () => [],
        getResources: () => [],
        getProtocolVersion: () => '2025-01-01',
      });

      const first = manager.connect(config.id);
      await vi.waitFor(() => expect(deferredConnect).toHaveBeenCalledTimes(1));
      const second = manager.connect(config.id);
      let secondSettled = false;
      void second.then(() => { secondSettled = true; });
      await Promise.resolve();

      expect(secondSettled).toBe(false);
      expect(deferredConnect).toHaveBeenCalledTimes(1);

      finishConnect();
      await Promise.all([first, second]);
      expect(manager.getConnection(config.id)?.status).toBe('connected');
    });
  });

  describe('disconnect', () => {
    it('should handle disconnect for server without active client', async () => {
      const manager = await MCPManager.getInstance();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      // Disconnect without connecting first - should not throw
      await manager.disconnect(config.id);

      const connection = manager.getConnection(config.id);
      expect(connection?.status).toBe('disconnected');
    });
  });

  describe('getConnection', () => {
    it('should return connection state for server', async () => {
      const manager = await MCPManager.getInstance();

      const config = await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      const connection = manager.getConnection(config.id);

      expect(connection).toBeDefined();
      expect(connection?.configId).toBe(config.id);
      expect(connection?.status).toBe('disconnected');
    });

    it('should return undefined for non-existent server', async () => {
      const manager = await MCPManager.getInstance();

      const connection = manager.getConnection('non-existent-id');

      expect(connection).toBeUndefined();
    });
  });

  describe('getConnections', () => {
    it('should return all connections', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'server-1',
        url: 'https://server1.example.com',
      });
      await manager.addServer({
        name: 'server-2',
        url: 'https://server2.example.com',
      });

      const connections = manager.getConnections();

      expect(connections).toHaveLength(2);
    });
  });

  describe('getAllTools', () => {
    it('should return empty array when no servers connected', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      // Not connected
      const tools = manager.getAllTools();

      expect(tools).toHaveLength(0);
    });
  });

  describe('executeTool', () => {
    it('should throw for invalid tool name format', async () => {
      const manager = await MCPManager.getInstance();

      await expect(manager.executeTool('invalid-format', {})).rejects.toThrow(
        /invalid tool name format/i
      );
    });

    it('should throw for non-existent server', async () => {
      const manager = await MCPManager.getInstance();

      await expect(manager.executeTool('unknown__search', {})).rejects.toThrow(
        /not found/i
      );
    });

    it('should throw for disconnected server', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      // Not connected
      await expect(manager.executeTool('github__search', {})).rejects.toThrow(
        /not connected/i
      );
    });
  });

  describe('event handling', () => {
    it('should allow subscribing and unsubscribing to events', async () => {
      const manager = await MCPManager.getInstance();
      const handler = vi.fn();

      manager.on('event', handler);

      await manager.addServer({
        name: 'github',
        url: 'https://mcp.github.example.com',
      });

      expect(handler).toHaveBeenCalledTimes(1);

      manager.off('event', handler);

      await manager.addServer({
        name: 'github2',
        url: 'https://mcp2.github.example.com',
      });

      // Handler should not be called again after unsubscribing
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});
