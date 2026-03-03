/**
 * Tests for TauriMessageService
 *
 * Covers the desktop-specific message routing: RESUME_SESSION, SESSION_RESET,
 * HEALTH_CHECK, GET_STATE, SUBMISSION, INTERRUPT, CONFIG_UPDATE, and the
 * event/message listener plumbing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before the SUT import
// ---------------------------------------------------------------------------

// Mock Tauri event API
const mockEmit = vi.fn().mockResolvedValue(undefined);
const mockListen = vi.fn().mockImplementation(async (_event: string, _handler: Function) => {
  return vi.fn(); // unlisten function
});

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: any[]) => mockEmit(...args),
  listen: (...args: any[]) => mockListen(...args),
}));

// Mock the large-payload helpers (no-op for tests)
vi.mock('@/desktop/channels/LargePayloadStore', () => ({
  isPayloadRef: vi.fn().mockReturnValue(false),
  retrievePayload: vi.fn(),
}));

// Mock session with both clearHistory and reset
const mockSession = {
  getTabId: vi.fn().mockReturnValue(42),
  getConversationHistory: vi.fn().mockReturnValue({
    items: [{ role: 'user', content: 'hello' }],
  }),
  clearHistory: vi.fn(),
  reset: vi.fn().mockResolvedValue(undefined),
  abortAllTasks: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockAgent = {
  getSession: vi.fn().mockReturnValue(mockSession),
  interrupt: vi.fn().mockResolvedValue(undefined),
  getModelClientFactory: vi.fn().mockReturnValue({
    getAuthManager: vi.fn().mockReturnValue(null),
    setAuthManager: vi.fn(),
  }),
};

const mockBootstrap = {
  getAgent: vi.fn().mockReturnValue(mockAgent),
  getReadyState: vi.fn().mockResolvedValue({
    ready: true,
    message: 'Desktop mode',
    provider: 'test-provider',
    model: 'test-model',
    authMode: 'api_key',
  }),
  getSkillRegistry: vi.fn().mockReturnValue(null),
  handleConfigUpdate: vi.fn().mockResolvedValue(undefined),
  resumeSession: vi.fn().mockResolvedValue([
    { role: 'user', content: 'previous message' },
    { role: 'assistant', content: 'previous response' },
  ]),
};

vi.mock('@/desktop/agent/DesktopAgentBootstrap', () => ({
  getDesktopAgentBootstrap: () => mockBootstrap,
}));

vi.mock('../../MessageRouter', () => ({
  MessageType: {
    SUBMISSION: 'SUBMISSION',
    PING: 'PING',
    HEALTH_CHECK: 'HEALTH_CHECK',
    HEALTH_STATUS: 'HEALTH_STATUS',
    GET_STATE: 'GET_STATE',
    SESSION_RESET: 'SESSION_RESET',
    RESUME_SESSION: 'RESUME_SESSION',
    INTERRUPT: 'INTERRUPT',
    CONFIG_UPDATE: 'CONFIG_UPDATE',
    EVENT: 'EVENT',
    RESPONSE_OUTPUT_TEXT_DELTA: 'RESPONSE_OUTPUT_TEXT_DELTA',
    RESPONSE_REASONING_CONTENT_DELTA: 'RESPONSE_REASONING_CONTENT_DELTA',
    APPROVAL_REQUEST: 'APPROVAL_REQUEST',
    SKILLS_LIST: 'SKILLS_LIST',
    SKILLS_LOAD: 'SKILLS_LOAD',
    SKILLS_SAVE: 'SKILLS_SAVE',
    SKILLS_DELETE: 'SKILLS_DELETE',
    SKILLS_UPDATE_MODE: 'SKILLS_UPDATE_MODE',
    SKILLS_IMPORT: 'SKILLS_IMPORT',
    SKILLS_EXPORT: 'SKILLS_EXPORT',
    SKILLS_TRUST: 'SKILLS_TRUST',
    AGENT_REINITIALIZED: 'AGENT_REINITIALIZED',
  },
}));

// Re-import the mocked MessageType for use in tests
import { MessageType } from '../../MessageRouter';
import { TauriMessageService } from '../TauriMessageService';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Helper to re-establish all mock return values after clearAllMocks
function resetMockReturnValues() {
  mockEmit.mockResolvedValue(undefined);
  mockListen.mockImplementation(async (_event: string, _handler: Function) => {
    return vi.fn(); // unlisten function
  });

  mockSession.getTabId.mockReturnValue(42);
  mockSession.getConversationHistory.mockReturnValue({
    items: [{ role: 'user', content: 'hello' }],
  });
  mockSession.reset.mockResolvedValue(undefined);
  mockSession.abortAllTasks.mockResolvedValue(undefined);
  mockSession.close.mockResolvedValue(undefined);

  mockAgent.getSession.mockReturnValue(mockSession);
  mockAgent.interrupt.mockResolvedValue(undefined);
  mockAgent.getModelClientFactory.mockReturnValue({
    getAuthManager: vi.fn().mockReturnValue(null),
    setAuthManager: vi.fn(),
  });

  mockBootstrap.getAgent.mockReturnValue(mockAgent);
  mockBootstrap.getReadyState.mockResolvedValue({
    ready: true,
    message: 'Desktop mode',
    provider: 'test-provider',
    model: 'test-model',
    authMode: 'api_key',
  });
  mockBootstrap.getSkillRegistry.mockReturnValue(null);
  mockBootstrap.handleConfigUpdate.mockResolvedValue(undefined);
  mockBootstrap.resumeSession.mockResolvedValue([
    { role: 'user', content: 'previous message' },
    { role: 'assistant', content: 'previous response' },
  ]);
}

describe('TauriMessageService', () => {
  let service: TauriMessageService;

  beforeEach(() => {
    vi.clearAllMocks();
    resetMockReturnValues();
    service = new TauriMessageService();
  });

  afterEach(async () => {
    await service.destroy();
  });

  // ========================================================================
  // Initialization
  // ========================================================================

  describe('initialize', () => {
    it('should load Tauri APIs and transition to connected', async () => {
      await service.initialize();
      expect(service.getConnectionState()).toBe('connected');
      expect(service.isConnected()).toBe(true);
    });

    it('should set up event listeners via Tauri listen', async () => {
      await service.initialize();
      // Listens for pi:event and pi:message
      expect(mockListen).toHaveBeenCalledTimes(2);
      expect(mockListen.mock.calls[0][0]).toBe('pi:event');
      expect(mockListen.mock.calls[1][0]).toBe('pi:message');
    });
  });

  // ========================================================================
  // Connection state
  // ========================================================================

  describe('connection state', () => {
    it('starts disconnected', () => {
      expect(service.getConnectionState()).toBe('disconnected');
      expect(service.isConnected()).toBe(false);
    });

    it('returns disconnected after destroy', async () => {
      await service.initialize();
      await service.destroy();
      expect(service.getConnectionState()).toBe('disconnected');
    });
  });

  // ========================================================================
  // send() routing
  // ========================================================================

  describe('send', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should throw if Tauri APIs are not initialized', async () => {
      const uninitService = new TauriMessageService();
      await expect(uninitService.send(MessageType.PING)).rejects.toThrow(
        'Tauri APIs not initialized',
      );
    });

    // --- PING ---
    it('PING should return { pong: true }', async () => {
      const result = await service.send(MessageType.PING);
      expect(result).toEqual({ pong: true });
    });

    // --- HEALTH_CHECK ---
    it('HEALTH_CHECK should query bootstrap and return health status', async () => {
      const result = await service.send<any>(MessageType.HEALTH_CHECK);
      expect(result.ready).toBe(true);
      expect(result.authMode).toBe('api_key');
      expect(mockBootstrap.getReadyState).toHaveBeenCalled();
    });

    it('HEALTH_CHECK should return not-ready when bootstrap throws', async () => {
      mockBootstrap.getReadyState.mockRejectedValueOnce(new Error('init failed'));
      const result = await service.send<any>(MessageType.HEALTH_CHECK);
      expect(result.ready).toBe(false);
      expect(result.message).toBe('init failed');
    });

    // --- GET_STATE ---
    it('GET_STATE should return session tab and history', async () => {
      const result = await service.send<any>(MessageType.GET_STATE);
      expect(result.tabId).toBe(42);
      expect(result.history).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('GET_STATE should return empty state when agent is null', async () => {
      mockBootstrap.getAgent.mockReturnValueOnce(null);
      const result = await service.send<any>(MessageType.GET_STATE);
      expect(result.tabId).toBe(-1);
      expect(result.history).toEqual([]);
    });

    // --- SUBMISSION ---
    it('SUBMISSION should emit to pi:submit', async () => {
      const payload = { op: { type: 'chat' }, context: { tabId: 1 } };
      const result = await service.send<any>(MessageType.SUBMISSION, payload);
      expect(result.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith('pi:submit', {
        op: { type: 'chat' },
        context: { tabId: 1 },
      });
    });

    // --- INTERRUPT ---
    it('INTERRUPT should call agent.interrupt()', async () => {
      const result = await service.send<any>(MessageType.INTERRUPT);
      expect(result.success).toBe(true);
      expect(mockAgent.interrupt).toHaveBeenCalled();
    });

    it('INTERRUPT should return success false on error', async () => {
      mockAgent.interrupt.mockRejectedValueOnce(new Error('oops'));
      const result = await service.send<any>(MessageType.INTERRUPT);
      expect(result.success).toBe(false);
    });

    // --- CONFIG_UPDATE ---
    it('CONFIG_UPDATE should route to bootstrap.handleConfigUpdate()', async () => {
      await service.send(MessageType.CONFIG_UPDATE);
      expect(mockBootstrap.handleConfigUpdate).toHaveBeenCalledTimes(1);
    });

    it('CONFIG_UPDATE should return { success: true } on success', async () => {
      const result = await service.send(MessageType.CONFIG_UPDATE);
      expect(result).toEqual({ success: true });
    });

    it('CONFIG_UPDATE should return { success: false } on error', async () => {
      mockBootstrap.handleConfigUpdate.mockRejectedValueOnce(new Error('reload failed'));
      const result = await service.send(MessageType.CONFIG_UPDATE);
      expect(result).toEqual({ success: false });
    });

    it('CONFIG_UPDATE should log error on failure', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockBootstrap.handleConfigUpdate.mockRejectedValueOnce(new Error('boom'));

      await service.send(MessageType.CONFIG_UPDATE);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config update failed'),
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    // --- Default ---
    it('unknown message types should emit to pi:message', async () => {
      const result = await service.send<any>('UNKNOWN_TYPE' as any, { data: 1 });
      expect(result.success).toBe(true);
      expect(mockEmit).toHaveBeenCalledWith('pi:message', {
        type: 'UNKNOWN_TYPE',
        payload: { data: 1 },
      });
    });
  });

  // ========================================================================
  // SESSION_RESET
  // ========================================================================

  describe('SESSION_RESET', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should call session.reset() (not clearHistory)', async () => {
      const result = await service.send<any>(MessageType.SESSION_RESET);
      expect(result.success).toBe(true);
      expect(mockSession.reset).toHaveBeenCalledTimes(1);
      expect(mockSession.clearHistory).not.toHaveBeenCalled();
    });

    it('should return success even when agent is null', async () => {
      mockBootstrap.getAgent.mockReturnValueOnce(null);
      const result = await service.send<any>(MessageType.SESSION_RESET);
      expect(result.success).toBe(true);
    });

    it('should return success false on error', async () => {
      mockSession.reset.mockRejectedValueOnce(new Error('reset failed'));
      const result = await service.send<any>(MessageType.SESSION_RESET);
      expect(result.success).toBe(false);
    });
  });

  // ========================================================================
  // RESUME_SESSION
  // ========================================================================

  describe('RESUME_SESSION', () => {
    beforeEach(async () => {
      await service.initialize();
    });

    it('should delegate to bootstrap.resumeSession and return history', async () => {
      const payload = { conversationId: 'conv-abc-123' };
      const result = await service.send<any>(MessageType.RESUME_SESSION, payload);

      expect(mockBootstrap.resumeSession).toHaveBeenCalledWith('conv-abc-123');
      expect(result.history).toEqual([
        { role: 'user', content: 'previous message' },
        { role: 'assistant', content: 'previous response' },
      ]);
    });

    it('should return empty history when resumeSession throws', async () => {
      mockBootstrap.resumeSession.mockRejectedValueOnce(
        new Error('Conversation not found or has no history'),
      );
      const result = await service.send<any>(MessageType.RESUME_SESSION, {
        conversationId: 'nonexistent',
      });
      expect(result.history).toEqual([]);
    });

    it('should pass conversationId correctly from payload', async () => {
      const id = '11111111-2222-3333-4444-555555555555';
      await service.send(MessageType.RESUME_SESSION, { conversationId: id });
      expect(mockBootstrap.resumeSession).toHaveBeenCalledWith(id);
    });
  });

  // ========================================================================
  // on / off / event dispatch
  // ========================================================================

  describe('on / off', () => {
    it('registers and unregisters handlers', async () => {
      const handler = vi.fn();
      const unsub = service.on(MessageType.EVENT, handler);
      expect(typeof unsub).toBe('function');

      unsub();
      // No assertion needed — just verifying it doesn't throw
    });

    it('unsubscribe returned by on() removes only that handler', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      const unsub1 = service.on(MessageType.EVENT, h1);
      service.on(MessageType.EVENT, h2);

      unsub1();

      // off for already-removed handler is a no-op
      expect(() => service.off(MessageType.EVENT, h1)).not.toThrow();
    });

    it('off is a no-op for unregistered types', () => {
      expect(() => service.off(MessageType.PING, vi.fn())).not.toThrow();
    });
  });

  // ========================================================================
  // Incoming event handling
  // ========================================================================

  describe('incoming events', () => {
    let eventHandler: Function;

    beforeEach(async () => {
      // Capture the pi:event listener callback
      mockListen.mockImplementation(async (event: string, handler: Function) => {
        if (event === 'pi:event') {
          eventHandler = handler;
        }
        return vi.fn();
      });
      await service.initialize();
    });

    it('should dispatch incoming events to EVENT handlers', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      eventHandler({ payload: { type: 'TaskStarted', data: {} } });

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0];
      expect(event).toHaveProperty('id');
      expect(event).toHaveProperty('msg');
      expect(event.msg.type).toBe('TaskStarted');
    });

    it('should dispatch AssistantTextDelta to RESPONSE_OUTPUT_TEXT_DELTA handlers', () => {
      const handler = vi.fn();
      service.on(MessageType.RESPONSE_OUTPUT_TEXT_DELTA, handler);

      eventHandler({ payload: { type: 'AssistantTextDelta', delta: 'hello' } });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should ignore events with no type', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      eventHandler({ payload: {} });
      eventHandler({ payload: null });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should catch handler errors without breaking other handlers', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const errorHandler = vi.fn(() => { throw new Error('boom'); });
      const goodHandler = vi.fn();

      service.on(MessageType.EVENT, errorHandler);
      service.on(MessageType.EVENT, goodHandler);

      eventHandler({ payload: { type: 'TaskComplete', data: {} } });

      expect(errorHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  // ========================================================================
  // Incoming message handling (pi:message)
  // ========================================================================

  describe('incoming messages', () => {
    let messageHandler: Function;

    beforeEach(async () => {
      mockListen.mockImplementation(async (event: string, handler: Function) => {
        if (event === 'pi:message') {
          messageHandler = handler;
        }
        return vi.fn();
      });
      await service.initialize();
    });

    it('should dispatch pi:message payloads to typed handlers', () => {
      const handler = vi.fn();
      service.on(MessageType.AGENT_REINITIALIZED as any, handler);

      messageHandler({ payload: { type: MessageType.AGENT_REINITIALIZED, payload: { ok: true } } });

      expect(handler).toHaveBeenCalledWith({ ok: true });
    });

    it('should ignore messages with no type', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      messageHandler({ payload: {} });
      messageHandler({ payload: null });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // destroy
  // ========================================================================

  describe('destroy', () => {
    it('should clean up listeners and handlers', async () => {
      const unlisten1 = vi.fn();
      const unlisten2 = vi.fn();
      let callCount = 0;
      mockListen.mockImplementation(async () => {
        return callCount++ === 0 ? unlisten1 : unlisten2;
      });

      await service.initialize();
      service.on(MessageType.EVENT, vi.fn());

      await service.destroy();

      expect(unlisten1).toHaveBeenCalled();
      expect(unlisten2).toHaveBeenCalled();
      expect(service.getConnectionState()).toBe('disconnected');
    });

    it('is safe to call before initialize', async () => {
      await expect(service.destroy()).resolves.not.toThrow();
    });

    it('is safe to call multiple times', async () => {
      await service.initialize();
      await service.destroy();
      await expect(service.destroy()).resolves.not.toThrow();
    });
  });
});
