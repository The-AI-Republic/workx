/**
 * Unit tests for MCPManager platform filtering, builtin server seeding,
 * and transport routing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MCPManager } from '../MCPManager';
import type { IMCPServerConfig, IMCPServerConfigCreate } from '../types';
import { setConfigStorage, type ConfigStorageProvider } from '../../storage/ConfigStorageProvider';

// Map-based ConfigStorageProvider mock
const store = new Map<string, any>();
const HUB_ENV_KEYS = [
  'WORKX_GATEWAY_BASE_URL',
  'WORKX_GATEWAY_MCP_URL',
  'WORKX_GATEWAY_MCP_NAME',
  'WORKX_GATEWAY_MCP_AUTH_MODE',
  'WORKX_GATEWAY_MCP_API_KEY',
  'WORKX_GATEWAY_MCP_TOOL_DISCOVERY',
  'WORKX_AI_HUB_GATEWAY_BASE_URL',
  'WORKX_AI_HUB_MCP_URL',
  'WORKX_AI_HUB_MCP_NAME',
  'WORKX_AI_HUB_MCP_AUTH_MODE',
  'WORKX_AI_HUB_MCP_TOOL_DISCOVERY',
  'VITE_GATEWAY_BASE_URL',
  'VITE_GATEWAY_MCP_URL',
  'VITE_AI_HUB_GATEWAY_BASE_URL',
  'VITE_AI_HUB_MCP_URL',
] as const;
const originalHubEnv = new Map<string, string | undefined>();

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

// Mock crypto.randomUUID — zero-padded to 12 hex chars for the 100-server cap (Track 10).
let uuidCounter = 0;
const mockRandomUUID = vi.fn(() => {
  uuidCounter++;
  const tail = uuidCounter.toString(16).padStart(12, '0');
  return `550e8400-e29b-41d4-a716-${tail}`;
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
  let mockStorage: ConfigStorageProvider;

  beforeEach(() => {
    // Clear mock storage and install ConfigStorageProvider
    store.clear();
    for (const key of HUB_ENV_KEYS) {
      originalHubEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    mockStorage = createMockConfigStorage();
    setConfigStorage(mockStorage);

    vi.spyOn(crypto, 'randomUUID').mockImplementation(mockRandomUUID as any);
    uuidCounter = 0;
    vi.clearAllMocks();
    MCPManager.resetInstance();
  });

  afterEach(() => {
    for (const key of HUB_ENV_KEYS) {
      const original = originalHubEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalHubEnv.clear();
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

    it('should seed generic gateway MCP only when a gateway URL is configured', async () => {
      process.env.WORKX_GATEWAY_BASE_URL = 'https://gateway.example.com';

      const manager = await MCPManager.getInstance('desktop');
      const hubServer = manager.getServerByName('gateway');

      expect(hubServer).toMatchObject({
        name: 'gateway',
        url: 'https://gateway.example.com/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        builtin: true,
      });
      expect(hubServer?.headers).toBeUndefined();
    });

    it('should seed first-party gateway MCP only when overlay config asks for it', async () => {
      process.env.WORKX_AI_HUB_GATEWAY_BASE_URL = 'https://gateway.example.com';
      process.env.WORKX_AI_HUB_MCP_NAME = 'ai-hub';
      process.env.WORKX_AI_HUB_MCP_AUTH_MODE = 'session-jwt';
      process.env.WORKX_AI_HUB_MCP_TOOL_DISCOVERY = 'folded';

      const manager = await MCPManager.getInstance('desktop');
      const hubServer = manager.getServerByName('ai-hub');

      expect(hubServer).toMatchObject({
        name: 'ai-hub',
        url: 'https://gateway.example.com/mcp',
        transport: 'streamable-http',
        authMode: 'session-jwt',
        headers: { 'X-Air-Tool-Discovery': 'folded' },
        builtin: true,
      });
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
      const savedServers = store.get('mcpServers') || [];

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
    it('should not count builtin servers toward the user server limit (raised to 100 in Track 10)', async () => {
      const manager = await MCPManager.getInstance('desktop');

      // Builtin browser server exists but shouldn't count
      // Should be able to add 100 user servers (post-Track-10 ceiling)
      for (let i = 0; i < 100; i++) {
        await manager.addServer({
          name: `server-${i}`,
          url: `https://server${i}.example.com`,
        });
      }

      // 101st user server should fail
      await expect(
        manager.addServer({
          name: 'server-100',
          url: 'https://server100.example.com',
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

      store.set('mcpServers', legacyServers);

      const manager = await MCPManager.getInstance();
      const servers = manager.getServers();

      expect(servers).toHaveLength(1);
      expect(servers[0].transport).toBe('sse');
      expect(servers[0].platform).toBe('shared');
    });
  });
});
