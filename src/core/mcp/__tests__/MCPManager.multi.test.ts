/**
 * Multi-server management tests for MCPManager
 * Task: T044 [US3]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../MCPManager';
import type { IMCPServerConfig } from '../types';

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};
const mockChromeStorage = {
  storage: {
    local: {
      get: vi.fn((key: string) => Promise.resolve({ [key]: mockStorage[key] })),
      set: vi.fn((data: Record<string, any>) => {
        Object.assign(mockStorage, data);
        return Promise.resolve();
      }),
    },
  },
};

// Mock crypto.randomUUID
let uuidCounter = 0;
const mockRandomUUID = vi.fn(() => {
  uuidCounter++;
  return `550e8400-e29b-41d4-a716-44665544000${uuidCounter}`;
});

// Use vi.hoisted to ensure mocks are available when vi.mock runs
// Note: Don't chain mockReturnValue in vi.hoisted - it doesn't work correctly
// Set return values in beforeEach instead
const {
  mockConnect,
  mockDisconnect,
  mockGetServerInfo,
  mockGetCapabilities,
  mockGetTools,
  mockGetResources,
  mockGetProtocolVersion,
  mockCallTool,
  mockReadResource,
  MockMCPClient,
} = vi.hoisted(() => {
  const connect = vi.fn();
  const disconnect = vi.fn();
  const getServerInfo = vi.fn();
  const getCapabilities = vi.fn();
  const getTools = vi.fn();
  const getResources = vi.fn();
  const getProtocolVersion = vi.fn();
  const callTool = vi.fn();
  const readResource = vi.fn();

  // Create the MCPClient mock class (class-based approach works with vi.hoisted)
  class MCPClientMock {
    connect = connect;
    disconnect = disconnect;
    getServerInfo = getServerInfo;
    getCapabilities = getCapabilities;
    getTools = getTools;
    getResources = getResources;
    getProtocolVersion = getProtocolVersion;
    callTool = callTool;
    readResource = readResource;

    constructor(_options: any) {
      // Constructor receives options but we don't need to store them
    }
  }

  return {
    mockConnect: connect,
    mockDisconnect: disconnect,
    mockGetServerInfo: getServerInfo,
    mockGetCapabilities: getCapabilities,
    mockGetTools: getTools,
    mockGetResources: getResources,
    mockGetProtocolVersion: getProtocolVersion,
    mockCallTool: callTool,
    mockReadResource: readResource,
    MockMCPClient: MCPClientMock,
  };
});

// Mock MCPClient module
vi.mock('../MCPClient', () => ({
  MCPClient: MockMCPClient,
}));

// Mock encryption
vi.mock('../../utils/encryption', () => ({
  encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
  decryptApiKey: vi.fn((encrypted: string) => encrypted?.replace('encrypted:', '') || null),
}));

describe('MCPManager Multi-Server', () => {
  beforeEach(() => {
    (globalThis as any).chrome = mockChromeStorage;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(mockRandomUUID as any);

    // Clear mock storage
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
    uuidCounter = 0;

    // Reset mocks and set up default return values
    // (Must be done in beforeEach because chaining in vi.hoisted doesn't work)
    mockConnect.mockReset();
    mockConnect.mockResolvedValue(undefined);

    mockDisconnect.mockReset();
    mockDisconnect.mockResolvedValue(undefined);

    mockGetServerInfo.mockReset();
    mockGetServerInfo.mockReturnValue({ name: 'test', version: '1.0' });

    mockGetCapabilities.mockReset();
    mockGetCapabilities.mockReturnValue({ tools: {} });

    mockGetTools.mockReset();
    mockGetTools.mockReturnValue([
      { name: 'tool1', description: 'Test tool 1', inputSchema: { type: 'object', properties: {} } },
    ]);

    mockGetResources.mockReset();
    mockGetResources.mockReturnValue([]);

    mockGetProtocolVersion.mockReset();
    mockGetProtocolVersion.mockReturnValue('2025-01-01');

    mockCallTool.mockReset();
    mockCallTool.mockResolvedValue({
      content: [{ type: 'text', text: 'result' }],
      isError: false,
    });

    mockReadResource.mockReset();
    mockReadResource.mockResolvedValue({
      uri: 'file:///test.txt',
      text: 'content',
    });

    MCPManager.resetInstance();
  });

  afterEach(() => {
    (globalThis as any).chrome = undefined;
    MCPManager.resetInstance();
  });

  describe('concurrent connections', () => {
    it('should support adding multiple servers', async () => {
      const manager = await MCPManager.getInstance();

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      const server3 = await manager.addServer({
        name: 'server3',
        url: 'https://server3.example.com',
      });

      expect(manager.getServers()).toHaveLength(3);
      expect(manager.getServer(server1.id)?.name).toBe('server1');
      expect(manager.getServer(server2.id)?.name).toBe('server2');
      expect(manager.getServer(server3.id)?.name).toBe('server3');
    });

    it('should maintain separate connection states for each server', async () => {
      const manager = await MCPManager.getInstance();

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      // Connect only server1
      await manager.connect(server1.id);

      const conn1 = manager.getConnection(server1.id);
      const conn2 = manager.getConnection(server2.id);

      expect(conn1?.status).toBe('connected');
      expect(conn2?.status).toBe('disconnected');
    });

    it('should track tools separately for each server', async () => {
      const manager = await MCPManager.getInstance();

      // Setup mock to return different tools for different servers
      let callCount = 0;
      mockGetTools.mockImplementation(() => {
        callCount++;
        return [
          {
            name: `tool${callCount}`,
            description: `Tool from server ${callCount}`,
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      });

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.connect(server1.id);
      await manager.connect(server2.id);

      const conn1 = manager.getConnection(server1.id);
      const conn2 = manager.getConnection(server2.id);

      expect(conn1?.tools).toHaveLength(1);
      expect(conn2?.tools).toHaveLength(1);
    });
  });

  describe('getAllTools', () => {
    it('should aggregate tools from all connected servers', async () => {
      const manager = await MCPManager.getInstance();

      // Setup mock to return different tools for different servers
      let callCount = 0;
      mockGetTools.mockImplementation(() => {
        callCount++;
        return [
          {
            name: `tool${callCount}`,
            description: `Tool from server ${callCount}`,
            inputSchema: { type: 'object', properties: {} },
          },
        ];
      });

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.connect(server1.id);
      await manager.connect(server2.id);

      const allTools = manager.getAllTools();

      expect(allTools).toHaveLength(2);
      expect(allTools[0].serverName).toBe('server1');
      expect(allTools[1].serverName).toBe('server2');
    });

    it('should only include tools from connected servers', async () => {
      const manager = await MCPManager.getInstance();

      mockGetTools.mockReturnValue([
        { name: 'tool', description: 'Test tool', inputSchema: { type: 'object', properties: {} } },
      ]);

      const server1 = await manager.addServer({
        name: 'connected',
        url: 'https://connected.example.com',
      });

      await manager.addServer({
        name: 'disconnected',
        url: 'https://disconnected.example.com',
      });

      await manager.connect(server1.id);

      const allTools = manager.getAllTools();

      expect(allTools).toHaveLength(1);
      expect(allTools[0].serverName).toBe('connected');
    });
  });

  describe('getConnections', () => {
    it('should return all connection states', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.addServer({
        name: 'server3',
        url: 'https://server3.example.com',
      });

      const connections = manager.getConnections();

      expect(connections).toHaveLength(3);
    });

    it('should reflect mixed connection states', async () => {
      const manager = await MCPManager.getInstance();

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.connect(server1.id);
      // server2 remains disconnected

      const connections = manager.getConnections();
      const connectedCount = connections.filter((c) => c.status === 'connected').length;
      const disconnectedCount = connections.filter((c) => c.status === 'disconnected').length;

      expect(connectedCount).toBe(1);
      expect(disconnectedCount).toBe(1);
    });
  });

  describe('server limit', () => {
    it('should enforce maximum of 5 servers', async () => {
      const manager = await MCPManager.getInstance();

      // Add 5 servers successfully
      for (let i = 0; i < 5; i++) {
        await manager.addServer({
          name: `server-${i}`,
          url: `https://server${i}.example.com`,
        });
      }

      expect(manager.getServers()).toHaveLength(5);

      // 6th server should fail
      await expect(
        manager.addServer({
          name: 'server-5',
          url: 'https://server5.example.com',
        })
      ).rejects.toThrow(/maximum/i);
    });

    it('should allow adding after removing', async () => {
      const manager = await MCPManager.getInstance();

      // Add 5 servers
      const servers: IMCPServerConfig[] = [];
      for (let i = 0; i < 5; i++) {
        const server = await manager.addServer({
          name: `server-${i}`,
          url: `https://server${i}.example.com`,
        });
        servers.push(server);
      }

      // Remove one
      await manager.removeServer(servers[0].id);

      // Should now be able to add another
      const newServer = await manager.addServer({
        name: 'new-server',
        url: 'https://new.example.com',
      });

      expect(manager.getServers()).toHaveLength(5);
      expect(newServer.name).toBe('new-server');
    });
  });

  describe('server isolation', () => {
    it('should disconnect one server without affecting others', async () => {
      const manager = await MCPManager.getInstance();

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.connect(server1.id);
      await manager.connect(server2.id);

      // Disconnect server1
      await manager.disconnect(server1.id);

      const conn1 = manager.getConnection(server1.id);
      const conn2 = manager.getConnection(server2.id);

      expect(conn1?.status).toBe('disconnected');
      expect(conn2?.status).toBe('connected');
    });

    it('should remove one server without affecting others', async () => {
      const manager = await MCPManager.getInstance();

      const server1 = await manager.addServer({
        name: 'server1',
        url: 'https://server1.example.com',
      });

      const server2 = await manager.addServer({
        name: 'server2',
        url: 'https://server2.example.com',
      });

      await manager.connect(server1.id);
      await manager.connect(server2.id);

      // Remove server1
      await manager.removeServer(server1.id);

      expect(manager.getServers()).toHaveLength(1);
      expect(manager.getServer(server2.id)).toBeDefined();

      const conn2 = manager.getConnection(server2.id);
      expect(conn2?.status).toBe('connected');
    });
  });

  describe('unique server names', () => {
    it('should reject duplicate server names', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'duplicate',
        url: 'https://server1.example.com',
      });

      await expect(
        manager.addServer({
          name: 'duplicate',
          url: 'https://server2.example.com',
        })
      ).rejects.toThrow(/already exists/i);
    });

    it('should reject duplicate names case-insensitively', async () => {
      const manager = await MCPManager.getInstance();

      await manager.addServer({
        name: 'MyServer',
        url: 'https://server1.example.com',
      });

      await expect(
        manager.addServer({
          name: 'myserver',
          url: 'https://server2.example.com',
        })
      ).rejects.toThrow(/already exists/i);
    });
  });
});
