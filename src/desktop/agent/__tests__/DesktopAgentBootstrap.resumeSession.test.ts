/**
 * Tests for session resume via session-services + AgentRegistry
 *
 * Validates that the resume flow now goes through createSession() with
 * resume config, rather than the deleted DesktopAgentBootstrap.resumeSession().
 *
 * The DesktopAgentBootstrap wires loadRolloutHistory into session deps,
 * and the session.resume handler in session-services orchestrates:
 *   load history → abort old primary → createSession({ resume }) → return history
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let piAgentConstructorCalls: any[] = [];

const mockSession = {
  sessionId: 'new-session-id',
  getConversationHistory: vi.fn().mockReturnValue({
    items: [
      { role: 'user', content: 'resumed msg 1' },
      { role: 'assistant', content: 'resumed msg 2' },
    ],
  }),
  initialize: vi.fn().mockResolvedValue(undefined),
  abortAllTasks: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockAgent = {
  getSession: vi.fn().mockReturnValue(mockSession),
  getModelClientFactory: vi.fn().mockReturnValue({
    getAuthManager: vi.fn().mockReturnValue(null),
    setAuthManager: vi.fn(),
  }),
  setEventDispatcher: vi.fn(),
  initialize: vi.fn().mockResolvedValue(undefined),
  getToolRegistry: vi.fn().mockReturnValue({ setApprovalGate: vi.fn() }),
  getApprovalManager: vi.fn().mockReturnValue({}),
  getHookDispatcher: vi.fn().mockReturnValue({ fire: vi.fn().mockResolvedValue({}) }),
  refreshModelClient: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@/core/RepublicAgent', () => ({
  RepublicAgent: vi.fn().mockImplementation((...args: any[]) => {
    piAgentConstructorCalls.push(args);
    return mockAgent;
  }),
}));

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({ getConfig: () => ({}), updateToolsConfig: vi.fn() }),
  },
}));

// Mock the session-services module
import { createSessionServices, type SessionServiceDeps } from '@/core/services/session-services';
import type { SubmissionContext } from '@/core/channels/types';

const ctx = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Desktop session resume via session-services', () => {
  const conversationId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const rolloutItems = [
    { type: 'event_msg', payload: { type: 'UserMessage', content: 'hello' } },
    { type: 'response_item', payload: { type: 'message', content: 'hi there' } },
  ];

  let deps: SessionServiceDeps;
  let services: ReturnType<typeof createSessionServices>;

  beforeEach(() => {
    vi.clearAllMocks();
    piAgentConstructorCalls = [];

    mockSession.getConversationHistory.mockReturnValue({
      items: [
        { role: 'user', content: 'resumed msg 1' },
        { role: 'assistant', content: 'resumed msg 2' },
      ],
    });
    mockSession.initialize.mockResolvedValue(undefined);
    mockSession.abortAllTasks.mockResolvedValue(undefined);
    mockSession.close.mockResolvedValue(undefined);
    mockAgent.getSession.mockReturnValue(mockSession);

    const oldSession = {
      sessionId: 'old-session-id',
      agent: {
        getSession: vi.fn().mockReturnValue({
          abortAllTasks: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
        }),
      },
    };

    deps = {
      registry: {
        listSessions: vi.fn().mockReturnValue([
          { sessionId: 'old-session-id', type: 'primary', state: 'idle' },
        ]),
        getMaxConcurrent: vi.fn().mockReturnValue(5),
        getActiveCount: vi.fn().mockReturnValue(1),
        canCreateSession: vi.fn().mockReturnValue(true),
        createSession: vi.fn().mockResolvedValue({
          sessionId: 'new-session-id',
          sessionLetter: 'a',
          agent: mockAgent,
        }),
        removeSession: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockImplementation((id: string) => {
          if (id === 'old-session-id') return oldSession;
          return undefined;
        }),
        getPrimarySession: vi.fn().mockReturnValue({ sessionId: 'old-session-id' }),
        setMaxConcurrent: vi.fn(),
      },
      loadRolloutHistory: vi.fn().mockResolvedValue({
        sessionId: conversationId,
        rolloutItems,
      }),
    };

    services = createSessionServices(deps);
  });

  it('should call loadRolloutHistory with the session ID', async () => {
    await services['session.resume']({ sessionId: conversationId }, ctx);
    expect(deps.loadRolloutHistory).toHaveBeenCalledWith(conversationId);
  });

  it('should close existing primary session before creating resumed one', async () => {
    await services['session.resume']({ sessionId: conversationId }, ctx);

    expect(deps.registry.removeSession).toHaveBeenCalledWith('old-session-id');
  });

  it('should skip closing when no primary session exists', async () => {
    (deps.registry.getPrimarySession as any).mockReturnValue(undefined);
    await services['session.resume']({ sessionId: conversationId }, ctx);

    expect(deps.registry.removeSession).not.toHaveBeenCalled();
  });

  it('should call createSession with resume config', async () => {
    await services['session.resume']({ sessionId: conversationId }, ctx);

    expect(deps.registry.createSession).toHaveBeenCalledWith({
      type: 'primary',
      resume: {
        sessionId: conversationId,
        rolloutItems,
      },
    });
  });

  it('should return the reconstructed conversation history', async () => {
    const result = await services['session.resume']({ sessionId: conversationId }, ctx);

    expect(result).toEqual({
      sessionId: conversationId,
      history: [
        { role: 'user', content: 'resumed msg 1' },
        { role: 'assistant', content: 'resumed msg 2' },
      ],
    });
  });

  it('should throw when loadRolloutHistory is not provided', async () => {
    deps = { ...deps, loadRolloutHistory: undefined };
    services = createSessionServices(deps);

    await expect(
      services['session.resume']({ sessionId: conversationId }, ctx)
    ).rejects.toThrow('Session resume not supported');
  });

  it('should throw when history not found (returns null)', async () => {
    (deps.loadRolloutHistory as any).mockResolvedValue(null);

    await expect(
      services['session.resume']({ sessionId: conversationId }, ctx)
    ).rejects.toThrow('Conversation not found or has no history');
  });

  it('should throw for missing sessionId', async () => {
    await expect(
      services['session.resume']({}, ctx)
    ).rejects.toThrow('sessionId is required');
  });

});
