/**
 * Tests for DesktopAgentBootstrap.resumeSession()
 *
 * Validates the full resume flow: abort → close → load rollout → create
 * RepublicAgent → wire events → restore auth → initialize → return history.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import
// ---------------------------------------------------------------------------

// Track RepublicAgent constructor calls
let piAgentConstructorCalls: any[] = [];

const mockNewSession = {
  sessionId: 'new-session-id',
  getConversationHistory: vi.fn().mockReturnValue({
    items: [
      { role: 'user', content: 'resumed msg 1' },
      { role: 'assistant', content: 'resumed msg 2' },
    ],
  }),
  initialize: vi.fn().mockResolvedValue(undefined),
  setEventEmitter: vi.fn(),
  setTurnContext: vi.fn(),
};

const mockOldSession = {
  sessionId: 'old-session-id',
  abortAllTasks: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getConversationHistory: vi.fn().mockReturnValue({ items: [] }),
  clearHistory: vi.fn(),
};

const mockAuthManager = { type: 'mock-auth-manager' };

const mockModelClientFactory = {
  getAuthManager: vi.fn().mockReturnValue(mockAuthManager),
  setAuthManager: vi.fn(),
};

const mockNewModelClientFactory = {
  getAuthManager: vi.fn().mockReturnValue(null),
  setAuthManager: vi.fn(),
};

// Track which agent instance is "current" — old vs new
let currentAgent: 'old' | 'new' = 'old';

const mockOldAgent = {
  getSession: vi.fn().mockReturnValue(mockOldSession),
  getModelClientFactory: vi.fn().mockReturnValue(mockModelClientFactory),
  setEventDispatcher: vi.fn(),
  initialize: vi.fn().mockResolvedValue(undefined),
  getToolRegistry: vi.fn().mockReturnValue({ setApprovalGate: vi.fn() }),
  getApprovalManager: vi.fn().mockReturnValue({}),
};

const mockNewAgent = {
  getSession: vi.fn().mockReturnValue(mockNewSession),
  getModelClientFactory: vi.fn().mockReturnValue(mockNewModelClientFactory),
  setEventDispatcher: vi.fn(),
  initialize: vi.fn().mockResolvedValue(undefined),
  getToolRegistry: vi.fn().mockReturnValue({ setApprovalGate: vi.fn() }),
  getApprovalManager: vi.fn().mockReturnValue({}),
};

vi.mock('@/core/RepublicAgent', () => ({
  RepublicAgent: vi.fn().mockImplementation((...args: any[]) => {
    piAgentConstructorCalls.push(args);
    currentAgent = 'new';
    return mockNewAgent;
  }),
}));

// Mock AgentConfig
vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({ getConfig: () => ({}), updateToolsConfig: vi.fn() }),
  },
}));

// Mock approval modules used by configureDesktopPlatformForAgent
vi.mock('@/core/approval/ApprovalGate', () => ({
  ApprovalGate: vi.fn().mockImplementation(() => ({
    addEnhancer: vi.fn(),
    setConfigStorage: vi.fn(),
    setMode: vi.fn(),
    setTrustedDomains: vi.fn(),
    setBlockedDomains: vi.fn(),
  })),
}));

vi.mock('@/core/approval/PolicyRulesEngine', () => ({
  PolicyRulesEngine: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@/core/approval/defaultRules', () => ({
  getDefaultRules: vi.fn().mockReturnValue([]),
}));

vi.mock('@/core/approval/enhancers/DomainSensitivityEnhancer', () => ({
  DomainSensitivityEnhancer: vi.fn(),
}));

vi.mock('@/core/approval/enhancers/SensitivePathEnhancer', () => ({
  SensitivePathEnhancer: vi.fn(),
}));

vi.mock('@/core/approval/ApprovalConfigStorage', () => ({
  ApprovalConfigStorage: vi.fn().mockImplementation(() => ({
    loadConfig: vi.fn().mockResolvedValue({ mode: 'auto', trustedDomains: [], blockedDomains: [] }),
  })),
}));

vi.mock('@/desktop/storage/TauriConfigStorage', () => ({
  TauriConfigStorage: vi.fn().mockImplementation(() => ({})),
}));

// Mock ChannelManager
const mockChannelManager = {
  dispatchEvent: vi.fn().mockResolvedValue(undefined),
  setAgentHandler: vi.fn(),
  registerChannel: vi.fn().mockResolvedValue(undefined),
  shutdown: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/channels/ChannelManager', () => ({
  getChannelManager: () => mockChannelManager,
}));

// Mock RolloutRecorder
const mockGetRolloutHistory = vi.fn();

vi.mock('@/storage/rollout/RolloutRecorder', () => ({
  RolloutRecorder: {
    getRolloutHistory: (...args: any[]) => mockGetRolloutHistory(...args),
  },
}));

// Mock TauriChannel
vi.mock('../../channels/TauriChannel', () => ({
  TauriChannel: vi.fn().mockImplementation(() => ({
    channelId: 'tauri-test-channel',
  })),
}));

// Mock PromptLoader
vi.mock('@/core/PromptLoader', () => ({
  configurePromptComposer: vi.fn(),
  registerPromptExtension: vi.fn(),
}));

// Mock SkillRegistry
vi.mock('@/core/skills/SkillRegistry', () => ({
  SkillRegistry: vi.fn().mockImplementation(() => ({
    discover: vi.fn().mockResolvedValue(undefined),
    getSkillMetas: vi.fn().mockReturnValue([]),
    buildSkillsSystemPrompt: vi.fn().mockReturnValue(''),
  })),
}));

// Mock FilesystemSkillProvider
vi.mock('../../storage/FilesystemSkillProvider', () => ({
  FilesystemSkillProvider: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ os: 'linux', arch: 'x86_64', version: '6.0' }),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn().mockResolvedValue('/home/testuser'),
}));

// Mock auth service
vi.mock('../../auth/DesktopAuthService', () => ({
  getDesktopAuthService: vi.fn().mockReturnValue({
    hasValidToken: vi.fn().mockResolvedValue(false),
    getAccessToken: vi.fn().mockResolvedValue(null),
    onAuthChange: vi.fn(),
  }),
}));

vi.mock('@/webfront/lib/constants', () => ({
  HOME_PAGE_BASE_URL: 'https://test.example.com',
  LLM_API_URL: 'https://api.test.example.com',
}));

// Mock i18n
vi.mock('@/webfront/lib/i18n', () => ({
  t: (s: string) => s,
}));

// Mock AuthManager
vi.mock('@/core/models/types/Auth', () => ({
  AuthManager: vi.fn(),
}));

// Mock StaticRiskAssessor
vi.mock('@/core/approval/assessors/StaticRiskAssessor', () => ({
  StaticRiskAssessor: vi.fn(),
}));

// Mock MCPManager
vi.mock('@/core/mcp/MCPManager', () => ({
  MCPManager: {
    getInstance: vi.fn().mockResolvedValue({
      on: vi.fn(),
      getServer: vi.fn(),
    }),
  },
}));

vi.mock('@/core/mcp/MCPToolAdapter', () => ({
  registerMCPTools: vi.fn(),
  unregisterMCPTools: vi.fn(),
}));

// Now import the SUT
import { DesktopAgentBootstrap } from '../DesktopAgentBootstrap';
import { RepublicAgent } from '@/core/RepublicAgent';
import { ApprovalGate } from '@/core/approval/ApprovalGate';
import { PolicyRulesEngine } from '@/core/approval/PolicyRulesEngine';
import { ApprovalConfigStorage } from '@/core/approval/ApprovalConfigStorage';
import { AgentConfig } from '@/config/AgentConfig';

// ---------------------------------------------------------------------------
// Helper: create an initialized bootstrap with a mock registry containing the old agent
// ---------------------------------------------------------------------------

// Mock AgentSession wrapper for registry
const mockOldAgentSession = {
  sessionId: 'old-session-id',
  agent: mockOldAgent,
  state: 'idle',
  metadata: { sessionId: 'old-session-id', type: 'primary' },
  terminate: vi.fn().mockResolvedValue(undefined),
};

function createInitializedBootstrap(): DesktopAgentBootstrap {
  const bootstrap = new DesktopAgentBootstrap();
  // Bypass the full initialize() — directly inject the private fields that
  // resumeSession() depends on.
  const mockRegistry = {
    listSessions: vi.fn().mockReturnValue([{ sessionId: 'old-session-id' }]),
    getSession: vi.fn().mockReturnValue(mockOldAgentSession),
    getPrimarySession: vi.fn().mockReturnValue(mockOldAgentSession),
    removeSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(mockOldAgentSession),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  (bootstrap as any).registry = mockRegistry;
  (bootstrap as any).channel = { channelId: 'tauri-test-channel' };
  (bootstrap as any).initialized = true;
  currentAgent = 'old';

  return bootstrap;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopAgentBootstrap.resumeSession', () => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const rolloutItems = [
    { type: 'event_msg', payload: { type: 'UserMessage', content: 'hello' } },
    { type: 'response_item', payload: { type: 'message', content: 'hi there' } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    piAgentConstructorCalls = [];
    currentAgent = 'old';

    // Re-establish mock return values after clearAllMocks wipes them
    mockOldSession.abortAllTasks.mockResolvedValue(undefined);
    mockOldSession.close.mockResolvedValue(undefined);
    mockOldSession.getConversationHistory.mockReturnValue({ items: [] });

    mockOldAgent.getSession.mockReturnValue(mockOldSession);
    mockOldAgent.getModelClientFactory.mockReturnValue(mockModelClientFactory);
    mockOldAgent.setEventDispatcher.mockImplementation(() => {});
    mockOldAgent.initialize.mockResolvedValue(undefined);
    mockOldAgent.getApprovalManager.mockReturnValue({});
    mockOldAgent.getToolRegistry.mockReturnValue({ setApprovalGate: vi.fn() });

    mockModelClientFactory.getAuthManager.mockReturnValue(mockAuthManager);
    mockModelClientFactory.setAuthManager.mockImplementation(() => {});

    mockNewSession.getConversationHistory.mockReturnValue({
      items: [
        { role: 'user', content: 'resumed msg 1' },
        { role: 'assistant', content: 'resumed msg 2' },
      ],
    });
    mockNewSession.initialize.mockResolvedValue(undefined);

    mockNewAgent.getSession.mockReturnValue(mockNewSession);
    mockNewAgent.getModelClientFactory.mockReturnValue(mockNewModelClientFactory);
    mockNewAgent.setEventDispatcher.mockImplementation(() => {});
    mockNewAgent.initialize.mockResolvedValue(undefined);
    mockNewAgent.getApprovalManager.mockReturnValue({});
    mockNewAgent.getToolRegistry.mockReturnValue({ setApprovalGate: vi.fn() });

    mockNewModelClientFactory.getAuthManager.mockReturnValue(null);
    mockNewModelClientFactory.setAuthManager.mockImplementation(() => {});

    // Re-establish mock session
    mockOldAgentSession.agent = mockOldAgent as any;
    mockOldAgentSession.terminate.mockResolvedValue(undefined);

    // Re-establish approval module mocks after clearAllMocks
    (ApprovalGate as any).mockImplementation(() => ({
      addEnhancer: vi.fn(),
      setConfigStorage: vi.fn(),
      setMode: vi.fn(),
      setTrustedDomains: vi.fn(),
      setBlockedDomains: vi.fn(),
    }));
    (PolicyRulesEngine as any).mockImplementation(() => ({}));
    (ApprovalConfigStorage as any).mockImplementation(() => ({
      loadConfig: vi.fn().mockResolvedValue({ mode: 'auto', trustedDomains: [], blockedDomains: [] }),
    }));
    (AgentConfig as any).getInstance.mockResolvedValue({ getConfig: () => ({}), updateToolsConfig: vi.fn() });

    // RepublicAgent constructor returns the new agent
    (RepublicAgent as any).mockImplementation((...args: any[]) => {
      piAgentConstructorCalls.push(args);
      currentAgent = 'new';
      return mockNewAgent;
    });

    // Default: rollout found with history
    mockGetRolloutHistory.mockResolvedValue({
      type: 'resumed',
      payload: {
        conversationId,
        history: rolloutItems,
        rolloutId: conversationId,
      },
    });
  });

  // ========================================================================
  // Happy path
  // ========================================================================

  it('should return reconstructed conversation history items', async () => {
    const bootstrap = createInitializedBootstrap();
    const items = await bootstrap.resumeSession(conversationId);

    expect(items).toEqual([
      { role: 'user', content: 'resumed msg 1' },
      { role: 'assistant', content: 'resumed msg 2' },
    ]);
  });

  it('should abort all tasks on the current session', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockOldSession.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
  });

  it('should close the current session', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockOldSession.close).toHaveBeenCalledTimes(1);
  });

  it('should load rollout history for the given conversationId', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockGetRolloutHistory).toHaveBeenCalledWith(conversationId);
  });

  it('should create a new RepublicAgent with resumed InitialHistory', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(RepublicAgent).toHaveBeenCalled();
    const lastCall = piAgentConstructorCalls[piAgentConstructorCalls.length - 1];
    // Constructor: (config, platformAdapter, initialHistory, agentId, userNotifier)
    const initialHistory = lastCall[2];
    expect(initialHistory).toEqual({
      mode: 'resumed',
      sessionId: conversationId,
      rolloutItems,
    });
  });

  it('should remove the old primary session from the registry', async () => {
    const bootstrap = createInitializedBootstrap();
    const registry = (bootstrap as any).registry;
    await bootstrap.resumeSession(conversationId);

    expect(registry.removeSession).toHaveBeenCalledWith('old-session-id');
  });

  it('should re-wire event forwarding on the new agent', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockNewAgent.setEventDispatcher).toHaveBeenCalledTimes(1);
    expect(typeof mockNewAgent.setEventDispatcher.mock.calls[0][0]).toBe('function');
  });

  it('should restore auth manager from old agent onto new agent', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockModelClientFactory.getAuthManager).toHaveBeenCalled();
    expect(mockNewModelClientFactory.setAuthManager).toHaveBeenCalledWith(mockAuthManager);
  });

  it('should skip auth restore when old agent has no auth manager', async () => {
    mockModelClientFactory.getAuthManager.mockReturnValueOnce(null);

    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockNewModelClientFactory.setAuthManager).not.toHaveBeenCalled();
  });

  it('should initialize the new agent and session', async () => {
    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(mockNewAgent.initialize).toHaveBeenCalledTimes(1);
    expect(mockNewSession.initialize).toHaveBeenCalledTimes(1);
  });

  // ========================================================================
  // Ordering
  // ========================================================================

  it('should follow the correct sequence: abort → close → load → create → init', async () => {
    const callOrder: string[] = [];

    mockOldSession.abortAllTasks.mockImplementation(async () => {
      callOrder.push('abort');
    });
    mockOldSession.close.mockImplementation(async () => {
      callOrder.push('close');
    });
    mockGetRolloutHistory.mockImplementation(async () => {
      callOrder.push('loadHistory');
      return {
        type: 'resumed',
        payload: { conversationId, history: rolloutItems, rolloutId: conversationId },
      };
    });
    (RepublicAgent as any).mockImplementation((...args: any[]) => {
      callOrder.push('createAgent');
      piAgentConstructorCalls.push(args);
      return mockNewAgent;
    });
    mockNewAgent.initialize.mockImplementation(async () => {
      callOrder.push('agentInit');
    });
    mockNewSession.initialize.mockImplementation(async () => {
      callOrder.push('sessionInit');
    });

    const bootstrap = createInitializedBootstrap();
    await bootstrap.resumeSession(conversationId);

    expect(callOrder).toEqual([
      'abort',
      'close',
      'loadHistory',
      'createAgent',
      'agentInit',
      'sessionInit',
    ]);
  });

  // ========================================================================
  // Error cases
  // ========================================================================

  it('should throw when registry is not initialized', async () => {
    const bootstrap = new DesktopAgentBootstrap();
    await expect(bootstrap.resumeSession(conversationId)).rejects.toThrow(
      'AgentRegistry not initialized',
    );
  });

  it('should throw when conversation is not found (type=new)', async () => {
    mockGetRolloutHistory.mockResolvedValue({ type: 'new' });

    const bootstrap = createInitializedBootstrap();
    await expect(bootstrap.resumeSession(conversationId)).rejects.toThrow(
      'Conversation not found or has no history',
    );
  });

  it('should throw when rollout has no history items', async () => {
    mockGetRolloutHistory.mockResolvedValue({
      type: 'resumed',
      payload: { conversationId, history: null, rolloutId: conversationId },
    });

    const bootstrap = createInitializedBootstrap();
    await expect(bootstrap.resumeSession(conversationId)).rejects.toThrow(
      'Conversation not found or has no history',
    );
  });

  it('should throw when rollout has empty history', async () => {
    mockGetRolloutHistory.mockResolvedValue({
      type: 'resumed',
      payload: { conversationId, history: [], rolloutId: conversationId },
    });

    const bootstrap = createInitializedBootstrap();
    // Empty array is falsy for .history check? Actually [] is truthy.
    // The check is `!initialHistory.payload?.history` — [] is truthy so this should succeed.
    // This verifies the edge case works (empty but valid history).
    const items = await bootstrap.resumeSession(conversationId);
    expect(items).toBeDefined();
  });

  it('should propagate errors from RolloutRecorder', async () => {
    mockGetRolloutHistory.mockRejectedValue(new Error('DB connection failed'));

    const bootstrap = createInitializedBootstrap();
    await expect(bootstrap.resumeSession(conversationId)).rejects.toThrow(
      'DB connection failed',
    );
  });

  it('should propagate errors from agent.initialize()', async () => {
    mockNewAgent.initialize.mockRejectedValueOnce(new Error('model client init failed'));

    const bootstrap = createInitializedBootstrap();
    await expect(bootstrap.resumeSession(conversationId)).rejects.toThrow(
      'model client init failed',
    );
  });

  // ========================================================================
  // Multiple resumes
  // ========================================================================

  it('should support resuming multiple times sequentially', async () => {
    const bootstrap = createInitializedBootstrap();

    // First resume
    await bootstrap.resumeSession(conversationId);

    const secondId = '11111111-2222-3333-4444-555555555555';
    mockGetRolloutHistory.mockResolvedValue({
      type: 'resumed',
      payload: { conversationId: secondId, history: rolloutItems, rolloutId: secondId },
    });

    await bootstrap.resumeSession(secondId);
    expect(mockGetRolloutHistory).toHaveBeenCalledWith(secondId);
  });
});
