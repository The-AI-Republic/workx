import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock objects (available to vi.mock factories)
// ---------------------------------------------------------------------------

const { mockPlanningTool, mockWebSearchTool, mockMCPManagerInstance } = vi.hoisted(() => ({
  mockPlanningTool: {
    getDefinition: vi.fn(),
    execute: vi.fn(),
  },
  mockWebSearchTool: {
    getDefinition: vi.fn(),
    execute: vi.fn(),
  },
  mockMCPManagerInstance: {
    getServerByName: vi.fn(),
    addServer: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnection: vi.fn(),
    getServer: vi.fn(),
    on: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// vi.mock declarations
// ---------------------------------------------------------------------------

// Use vi.hoisted to create the mock fn so it's available in the factory
const { mockExecSyncFn } = vi.hoisted(() => ({
  mockExecSyncFn: vi.fn<(...args: any[]) => any>(() => { throw new Error('not found'); }),
}));

// Mock child_process — for CJS modules, named imports resolve from
// the `default` export, so we must override execSync there too.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const defaultWithMock = { ...(actual as any).default, execSync: mockExecSyncFn };
  return { ...actual, execSync: mockExecSyncFn, default: defaultWithMock };
});

vi.mock('@/tools/PlanningTool', () => ({
  PlanningTool: vi.fn().mockImplementation(() => mockPlanningTool),
}));

vi.mock('@/tools/WebSearchTool', () => ({
  WebSearchTool: vi.fn().mockImplementation(() => mockWebSearchTool),
}));

vi.mock('@/core/approval/assessors/StaticRiskAssessor', () => ({
  StaticRiskAssessor: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/core/taskmanager', () => ({
  getTaskStore: vi.fn().mockReturnValue({}),
}));

vi.mock('@/core/mcp/MCPManager', () => ({
  MCPManager: {
    getInstance: vi.fn().mockResolvedValue(mockMCPManagerInstance),
  },
}));

vi.mock('@/core/mcp/MCPToolAdapter', () => ({
  registerMCPTools: vi.fn().mockResolvedValue(undefined),
  unregisterMCPTools: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { registerServerTools } from '../registerServerTools';
import { PlanningTool } from '@/tools/PlanningTool';
import { WebSearchTool } from '@/tools/WebSearchTool';
import { MCPManager } from '@/core/mcp/MCPManager';
import { StaticRiskAssessor } from '@/core/approval/assessors/StaticRiskAssessor';
import { getTaskStore } from '@/core/taskmanager';

function makeRegistry() {
  return {
    register: vi.fn().mockResolvedValue(undefined),
    getTool: vi.fn().mockReturnValue(undefined),
  } as any;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  // Save and clear env vars
  for (const key of ['CHROME_REMOTE_URL', 'CHROME_WS_ENDPOINT', 'CHROME_WS_HEADERS', 'CHROME_BIN']) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Re-setup mock implementations (mockReset: true clears them between tests)
  mockPlanningTool.getDefinition.mockReturnValue({ name: 'planning_tool', schema: {} });
  mockPlanningTool.execute.mockResolvedValue({});

  mockWebSearchTool.getDefinition.mockReturnValue({ name: 'web_search', schema: {} });
  mockWebSearchTool.execute.mockResolvedValue({});

  vi.mocked(PlanningTool).mockImplementation(() => mockPlanningTool as any);
  vi.mocked(WebSearchTool).mockImplementation(() => mockWebSearchTool as any);
  vi.mocked(StaticRiskAssessor).mockImplementation(() => ({}) as any);
  vi.mocked(getTaskStore).mockReturnValue({} as any);
  vi.mocked(MCPManager.getInstance).mockResolvedValue(mockMCPManagerInstance as any);

  mockMCPManagerInstance.getServerByName.mockReturnValue(null);
  mockMCPManagerInstance.addServer.mockResolvedValue({ id: 'browser-server-id', name: 'browser' });
  mockMCPManagerInstance.connect.mockResolvedValue(undefined);
  mockMCPManagerInstance.getConnection.mockReturnValue({ tools: [] });
  mockMCPManagerInstance.on.mockReturnValue(undefined);

  mockExecSyncFn.mockImplementation(() => { throw new Error('not found'); });
});

afterEach(() => {
  for (const key of ['CHROME_REMOTE_URL', 'CHROME_WS_ENDPOINT', 'CHROME_WS_HEADERS', 'CHROME_BIN']) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

// ---------------------------------------------------------------------------
// Planning + web search tool registration
// ---------------------------------------------------------------------------

describe('planning and web search registration', () => {
  it('registers planning tool', async () => {
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'planning_tool' }),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('registers web search tool', async () => {
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'web_search' }),
      expect.any(Function),
      expect.any(Object),
    );
  });

  it('skips registration when tool already exists', async () => {
    const registry = makeRegistry();
    registry.getTool.mockImplementation((name: string) => {
      if (name === 'planning_tool' || name === 'web_search' || name === 'resource_fetch') return {};
      return undefined;
    });
    await registerServerTools(registry);
    expect(registry.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Chrome binary detection
// ---------------------------------------------------------------------------

describe('chrome binary detection', () => {
  it('does not register browser tools when Chrome is not found', async () => {
    mockExecSyncFn.mockImplementation(() => { throw new Error('not found'); });
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(mockMCPManagerInstance.addServer).not.toHaveBeenCalled();
  });

  it('attempts to add browser MCP server when Chrome is found', async () => {
    mockExecSyncFn.mockImplementation((cmd: any) => {
      if (typeof cmd === 'string' && cmd.includes('google-chrome')) return '/usr/bin/google-chrome' as any;
      throw new Error('not found');
    });
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(mockMCPManagerInstance.addServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'browser', transport: 'stdio' }),
    );
  });
});

// ---------------------------------------------------------------------------
// CHROME_REMOTE_URL routing
// ---------------------------------------------------------------------------

describe('CHROME_REMOTE_URL', () => {
  it('uses --browserUrl arg when env var is set', async () => {
    process.env.CHROME_REMOTE_URL = 'http://browser:3000';
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(mockMCPManagerInstance.addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--browserUrl', 'http://browser:3000']),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// CHROME_WS_ENDPOINT routing
// ---------------------------------------------------------------------------

describe('CHROME_WS_ENDPOINT', () => {
  it('uses --wsEndpoint arg when env var is set', async () => {
    process.env.CHROME_WS_ENDPOINT = 'ws://browser:9222';
    const registry = makeRegistry();
    await registerServerTools(registry);
    expect(mockMCPManagerInstance.addServer).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--wsEndpoint', 'ws://browser:9222']),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation
// ---------------------------------------------------------------------------

describe('graceful degradation', () => {
  it('does not throw when MCP addServer fails', async () => {
    process.env.CHROME_REMOTE_URL = 'http://browser:3000';
    mockMCPManagerInstance.addServer.mockRejectedValue(new Error('MCP unavailable'));
    const registry = makeRegistry();
    await expect(registerServerTools(registry)).resolves.not.toThrow();
  });

  it('does not throw when MCP connect fails after retries', async () => {
    process.env.CHROME_REMOTE_URL = 'http://browser:3000';
    mockMCPManagerInstance.connect.mockRejectedValue(new Error('connect timeout'));
    const registry = makeRegistry();
    await expect(registerServerTools(registry)).resolves.not.toThrow();
  });

  it('does not throw on general failure', async () => {
    const registry = makeRegistry();
    await expect(registerServerTools(registry)).resolves.not.toThrow();
  });
});
