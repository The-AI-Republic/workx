/**
 * Unit Tests: DesktopAgentBootstrap.handleConfigUpdate()
 *
 * Verifies the config hot-reload path:
 * 1. Reloads AgentConfig from storage before swapping
 * 2. Calls agent.hotSwapModelClient() (not refreshModelClient)
 * 3. Does NOT emit AGENT_REINITIALIZED
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() – define mock instances before vi.mock hoisting
// ---------------------------------------------------------------------------

const { mockAgent, mockConfig } = vi.hoisted(() => ({
  mockAgent: {
    hotSwapModelClient: vi.fn().mockResolvedValue(undefined),
    refreshModelClient: vi.fn().mockResolvedValue(undefined),
  },
  mockConfig: {
    reload: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// vi.mock() declarations
// ---------------------------------------------------------------------------

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue(mockConfig),
  },
}));

// Stub out imports that DesktopAgentBootstrap pulls in at module scope
vi.mock('../../channels/TauriChannel', () => ({ TauriChannel: vi.fn() }));
vi.mock('../../channels/DesktopMessageRouter', () => ({
  DesktopMessageRouter: vi.fn(() => ({ send: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('@/core/channels/ChannelManager', () => ({
  getChannelManager: vi.fn(() => ({
    setAgentHandler: vi.fn(),
    registerChannel: vi.fn().mockResolvedValue(undefined),
    dispatchEvent: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('@/core/PiAgent', () => ({ PiAgent: vi.fn() }));
vi.mock('@/core/MessageRouter', () => ({
  MessageType: { AGENT_REINITIALIZED: 'AGENT_REINITIALIZED', CONFIG_UPDATE: 'CONFIG_UPDATE' },
}));
vi.mock('@/core/PromptLoader', () => ({
  configurePromptComposer: vi.fn(),
  registerPromptExtension: vi.fn(),
}));
vi.mock('@/core/skills/SkillRegistry', () => ({ SkillRegistry: vi.fn() }));
vi.mock('../../storage/FilesystemSkillProvider', () => ({
  FilesystemSkillProvider: vi.fn(),
}));
vi.mock('@/core/models/types/Auth', () => ({ AuthManager: vi.fn() }));
vi.mock('@/webfront/lib/i18n', () => ({ t: (s: string) => s }));
vi.mock('@/core/approval/assessors/StaticRiskAssessor', () => ({
  StaticRiskAssessor: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { DesktopAgentBootstrap } from '../DesktopAgentBootstrap';
import { AgentConfig } from '@/config/AgentConfig';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a bootstrap instance with a pre-set agent (bypassing initialize()).
 * We reach into the private field directly since initialize() would pull in
 * too many unrelated dependencies (Tauri APIs, channels, etc.).
 */
function createBootstrapWithAgent() {
  const bootstrap = new DesktopAgentBootstrap();
  // Inject mock agent via private field
  (bootstrap as any).agent = mockAgent;
  (bootstrap as any).initialized = true;
  return bootstrap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopAgentBootstrap.handleConfigUpdate()', () => {
  beforeEach(() => {
    // Reset call history and re-establish default implementations
    mockAgent.hotSwapModelClient.mockClear().mockResolvedValue(undefined);
    mockAgent.refreshModelClient.mockClear().mockResolvedValue(undefined);
    mockConfig.reload.mockClear().mockResolvedValue(undefined);
    vi.mocked(AgentConfig.getInstance).mockClear().mockResolvedValue(mockConfig as any);
  });

  it('should reload AgentConfig from storage before hot-swapping', async () => {
    const bootstrap = createBootstrapWithAgent();
    const callOrder: string[] = [];

    mockConfig.reload.mockImplementation(async () => {
      callOrder.push('config.reload');
    });
    mockAgent.hotSwapModelClient.mockImplementation(async () => {
      callOrder.push('agent.hotSwapModelClient');
    });

    await bootstrap.handleConfigUpdate();

    expect(callOrder).toEqual(['config.reload', 'agent.hotSwapModelClient']);
  });

  it('should call agent.hotSwapModelClient() NOT refreshModelClient()', async () => {
    const bootstrap = createBootstrapWithAgent();

    await bootstrap.handleConfigUpdate();

    expect(mockAgent.hotSwapModelClient).toHaveBeenCalledTimes(1);
    expect(mockAgent.refreshModelClient).not.toHaveBeenCalled();
  });

  it('should NOT emit AGENT_REINITIALIZED', async () => {
    const bootstrap = createBootstrapWithAgent();
    const mockMessageRouter = { send: vi.fn() };
    (bootstrap as any).messageRouter = mockMessageRouter;

    await bootstrap.handleConfigUpdate();

    expect(mockMessageRouter.send).not.toHaveBeenCalled();
  });

  it('should return early when agent is not initialized (no error)', async () => {
    const bootstrap = new DesktopAgentBootstrap();
    // agent is null (not initialized)

    await expect(bootstrap.handleConfigUpdate()).resolves.toBeUndefined();
    expect(mockConfig.reload).not.toHaveBeenCalled();
  });

  it('should handle errors from config.reload() gracefully', async () => {
    const bootstrap = createBootstrapWithAgent();
    mockConfig.reload.mockRejectedValue(new Error('storage corrupt'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await expect(bootstrap.handleConfigUpdate()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to handle config update'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });

  it('should handle errors from hotSwapModelClient() gracefully', async () => {
    const bootstrap = createBootstrapWithAgent();
    mockAgent.hotSwapModelClient.mockRejectedValue(new Error('client creation failed'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Should not throw
    await expect(bootstrap.handleConfigUpdate()).resolves.toBeUndefined();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to handle config update'),
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});
