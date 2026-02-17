/**
 * Unit tests for MCPManager platform filtering, builtin server seeding,
 * and transport routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../MCPManager';
import type { IMCPServerConfig, IMCPServerConfigCreate } from '../types';

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

// Mock MCPClient
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

vi.mock('../MCPClient', () => ({
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
}));

// Mock encryption
vi.mock('../../utils/encryption', () => ({
  encryptApiKey: vi.fn((key: string) => `encrypted:${key}`),
  decryptApiKey: vi.fn((encrypted: string) => encrypted?.replace('encrypted:', '') || null),
}));

describe('MCPManager Platform Features', () => {
  beforeEach(() => {
    (globalThis as any).chrome = mockChromeStorage;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(mockRandomUUID);
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
    uuidCounter = 0;
    vi.clearAllMocks();
    MCPManager.resetInstance();
  });

  afterEach(() => {
    (globalThis as any).chrome = undefined;
    MCPManager.resetInstance();
  });

  describe('platform filtering', () => {
    it('should default to extension platform when no platform specified', async () => {
      const manager = await MCPManager.getInstance();
      expect(manager.getPlatform()).toBe('extension');
    });

    it('should accept desktop platform', async () => {
      const manager = await MCPManager.getInstance('desktop');
      expect(manager.getPlatform()).toBe('desktop');
    });

    it('should filter servers by platform scope', async () => {
      // Create manager with desktop platform
      const manager = await MCPManager.getInstance('desktop');

      // Add servers with different platform scopes
      await manager.addServer({
        name: 'shared-server',
        url: 'https://shared.example.com',
        platform: 'shared',
      });

      await manager.addServer({
        name: 'desktop-server',
        url: 'https://desktop.example.com',
        platform: 'desktop',
      });

      // getServers should return shared + desktop servers (not extension)
      const servers = manager.getServers();
      const serverNames = servers.map(s => s.name);

      expect(serverNames).toContain('shared-server');
      expect(serverNames).toContain('desktop-server');
      // browser builtin is also present on desktop
      expect(serverNames).toContain('browser');
    });
  });

  describe('builtin server seeding', () => {
    it('should seed builtin browser server on desktop platform', async () => {
      const manager = await MCPManager.getInstance('desktop');

      const servers = manager.getServers();
      const browserServer = servers.find(s => s.name === 'browser');

      expect(browserServer).toBeDefined();
      expect(browserServer?.builtin).toBe(true);
      expect(browserServer?.transport).toBe('stdio');
      expect(browserServer?.platform).toBe('desktop');
      expect(browserServer?.command).toBe('npx');
      expect(browserServer?.args).toEqual(['chrome-devtools-mcp', '--no-usage-statistics', '--isolated', '--chromeArg=--no-sandbox', '--chromeArg=--disable-setuid-sandbox']);
      expect(browserServer?.timeout).toBe(180000);
    });

    it('should NOT seed builtin server on extension platform', async () => {
      const manager = await MCPManager.getInstance('extension');

      const servers = manager.getServers();
      const browserServer = servers.find(s => s.name === 'browser');

      expect(browserServer).toBeUndefined();
    });

    it('should not persist builtin servers to storage', async () => {
      const manager = await MCPManager.getInstance('desktop');

      // Add a user server (triggers persist)
      await manager.addServer({
        name: 'user-server',
        url: 'https://user.example.com',
      });

      // Check that storage only has the user server, not the builtin
      const storageCall = mockChromeStorage.storage.local.set.mock.calls;
      const lastCall = storageCall[storageCall.length - 1];
      const savedServers = lastCall?.[0]?.mcpServers || [];

      const builtinInStorage = savedServers.find(
        (s: IMCPServerConfig) => s.builtin === true
      );
      expect(builtinInStorage).toBeUndefined();
    });

    it('should prevent deletion of builtin servers', async () => {
      const manager = await MCPManager.getInstance('desktop');

      const browserServer = manager.getServerByName('browser');
      expect(browserServer).toBeDefined();

      await expect(manager.removeServer(browserServer!.id)).rejects.toThrow(
        /cannot remove builtin/i
      );
    });

    it('should find builtin server by name', async () => {
      const manager = await MCPManager.getInstance('desktop');

      const server = manager.getServerByName('browser');

      expect(server).toBeDefined();
      expect(server?.name).toBe('browser');
      expect(server?.builtin).toBe(true);
    });
  });

  describe('server limit', () => {
    it('should not count builtin servers toward the 5-server limit', async () => {
      const manager = await MCPManager.getInstance('desktop');

      // Builtin browser server exists but shouldn't count
      // Should be able to add 5 user servers
      for (let i = 0; i < 5; i++) {
        await manager.addServer({
          name: `server-${i}`,
          url: `https://server${i}.example.com`,
        });
      }

      // 6th user server should fail
      await expect(
        manager.addServer({
          name: 'server-6',
          url: 'https://server6.example.com',
        })
      ).rejects.toThrow(/maximum/i);
    });
  });

  describe('transport routing', () => {
    it('should reject stdio transport on extension platform', async () => {
      const manager = await MCPManager.getInstance('extension');

      await expect(
        manager.addServer({
          name: 'stdio-server',
          transport: 'stdio',
          command: 'npx',
          args: ['some-mcp-server'],
        })
      ).rejects.toThrow(/desktop/i);
    });

    it('should accept stdio transport on desktop platform', async () => {
      const manager = await MCPManager.getInstance('desktop');

      const config = await manager.addServer({
        name: 'custom-stdio',
        transport: 'stdio',
        platform: 'desktop',
        command: 'npx',
        args: ['my-mcp-server'],
      });

      expect(config.transport).toBe('stdio');
      expect(config.command).toBe('npx');
    });
  });

  describe('storage migration', () => {
    it('should add default transport and platform to legacy server configs', async () => {
      // Simulate legacy configs without transport/platform fields
      const legacyServers = [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'github',
          url: 'https://github.example.com',
          enabled: true,
          timeout: 30000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          // No transport or platform fields
        },
      ];

      mockStorage.mcpServers = legacyServers;

      const manager = await MCPManager.getInstance();
      const servers = manager.getServers();

      expect(servers).toHaveLength(1);
      expect(servers[0].transport).toBe('sse');
      expect(servers[0].platform).toBe('shared');
    });
  });
});
