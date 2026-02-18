/**
 * Unit tests for WebSocketChannel
 *
 * Covers turn tracking (lastActiveTurnId), tool use ID correlation
 * between ToolExecutionStart/End events, and EventMsg → WS message mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the WebSocketServer (Tauri dependency) before importing the SUT
// ---------------------------------------------------------------------------

const mockServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  send: vi.fn().mockResolvedValue(undefined),
  broadcast: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  getClients: vi.fn().mockReturnValue([]),
  updateConfig: vi.fn(),
};

vi.mock('../websocket/WebSocketServer', () => ({
  WebSocketServer: vi.fn(() => mockServer),
}));

import { WebSocketChannel } from '../WebSocketChannel';
import type { EventMsg } from '@/core/protocol/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate an incoming user_turn message through the server's onMessage callback */
async function simulateUserTurn(channel: WebSocketChannel, clientId = 'client-1', content = 'hello') {
  // Extract the onMessage handler registered during initialize()
  const onMessageHandler = mockServer.onMessage.mock.calls[0][0] as (
    clientId: string,
    message: Record<string, unknown>,
  ) => Promise<void>;

  await onMessageHandler(clientId, {
    type: 'user_turn',
    content,
  });
}

/** Extract the turnId from the assistant_turn_start message sent by handleUserTurn */
function getLastSentTurnId(): string {
  const calls = mockServer.send.mock.calls;
  // Find the assistant_turn_start message
  for (const call of calls) {
    const msg = call[1];
    if (msg?.type === 'assistant_turn_start') {
      return msg.turnId;
    }
  }
  throw new Error('No assistant_turn_start message found');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocketChannel', () => {
  let channel: WebSocketChannel;

  beforeEach(async () => {
    vi.clearAllMocks();
    channel = new WebSocketChannel();
    await channel.initialize();
  });

  // -----------------------------------------------------------------------
  // Turn tracking
  // -----------------------------------------------------------------------

  describe('turn tracking (lastActiveTurnId)', () => {
    it('returns null for events when no turn is active', async () => {
      const event: EventMsg = {
        type: 'AgentMessageDelta',
        data: { delta: 'hello' },
      };

      await channel.sendEvent(event);

      // No turn active → event is dropped (not sent)
      expect(mockServer.send).not.toHaveBeenCalled();
      expect(mockServer.broadcast).not.toHaveBeenCalled();
    });

    it('routes events to the most recently started turn', async () => {
      // Start two turns
      await simulateUserTurn(channel, 'client-1', 'first');
      mockServer.send.mockClear();

      await simulateUserTurn(channel, 'client-2', 'second');
      const secondTurnId = getLastSentTurnId();
      mockServer.send.mockClear();

      // Send an event — should use the SECOND turn's ID (most recent)
      const event: EventMsg = {
        type: 'AgentMessageDelta',
        data: { delta: 'response' },
      };
      await channel.sendEvent(event);

      // broadcast is used when no targetClientId
      const broadcastCall = mockServer.broadcast.mock.calls[0];
      expect(broadcastCall[0].turnId).toBe(secondTurnId);
    });

    it('clears lastActiveTurnId on TaskComplete', async () => {
      await simulateUserTurn(channel, 'client-1');
      mockServer.send.mockClear();

      // Complete the turn
      const completeEvent: EventMsg = {
        type: 'TaskComplete',
        data: { last_agent_message: 'done' },
      };
      await channel.sendEvent(completeEvent);

      // The TaskComplete itself should be sent
      expect(mockServer.broadcast).toHaveBeenCalledTimes(1);
      mockServer.broadcast.mockClear();

      // Subsequent events should be dropped (no active turn)
      const deltaEvent: EventMsg = {
        type: 'AgentMessageDelta',
        data: { delta: 'orphan' },
      };
      await channel.sendEvent(deltaEvent);
      expect(mockServer.broadcast).not.toHaveBeenCalled();
    });

    it('clears lastActiveTurnId on cancel', async () => {
      await simulateUserTurn(channel, 'client-1');
      mockServer.send.mockClear();

      // Simulate cancel message
      const onMessageHandler = mockServer.onMessage.mock.calls[0][0];
      await onMessageHandler('client-1', { type: 'cancel' });

      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      // Events should be dropped (no active turn)
      const event: EventMsg = {
        type: 'AgentMessageDelta',
        data: { delta: 'orphan' },
      };
      await channel.sendEvent(event);
      expect(mockServer.broadcast).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Tool use ID correlation
  // -----------------------------------------------------------------------

  describe('tool use ID correlation', () => {
    it('produces matching toolUseIds for ToolExecutionStart and ToolExecutionEnd with call_id', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      // Send start event with call_id
      const startEvent: EventMsg = {
        type: 'ToolExecutionStart',
        data: {
          tool_name: 'browser_click',
          call_id: 'call-abc-123',
          start_time: 1000,
        },
      };
      await channel.sendEvent(startEvent);

      const startMsg = mockServer.broadcast.mock.calls[0][0];
      expect(startMsg.type).toBe('tool_use');
      const startToolUseId = startMsg.toolUseId;
      expect(startToolUseId).toBe('call-abc-123');

      mockServer.broadcast.mockClear();

      // Send end event with same call_id
      const endEvent: EventMsg = {
        type: 'ToolExecutionEnd',
        data: {
          tool_name: 'browser_click',
          call_id: 'call-abc-123',
          success: true,
        },
      };
      await channel.sendEvent(endEvent);

      const endMsg = mockServer.broadcast.mock.calls[0][0];
      expect(endMsg.type).toBe('tool_result');
      expect(endMsg.toolUseId).toBe(startToolUseId);
    });

    it('produces matching toolUseIds using tool_name fallback when no call_id', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      // Send start event without call_id
      const startEvent: EventMsg = {
        type: 'ToolExecutionStart',
        data: { tool_name: 'web_search' },
      };
      await channel.sendEvent(startEvent);

      const startMsg = mockServer.broadcast.mock.calls[0][0];
      const startToolUseId = startMsg.toolUseId;
      expect(startToolUseId).toContain('tool-web_search-');

      mockServer.broadcast.mockClear();

      // Send end event without call_id, same tool_name
      const endEvent: EventMsg = {
        type: 'ToolExecutionEnd',
        data: { tool_name: 'web_search', success: true },
      };
      await channel.sendEvent(endEvent);

      const endMsg = mockServer.broadcast.mock.calls[0][0];
      expect(endMsg.toolUseId).toBe(startToolUseId);
    });

    it('uses a fallback toolUseId for orphaned ToolExecutionEnd', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      // Send end event with no matching start
      const endEvent: EventMsg = {
        type: 'ToolExecutionEnd',
        data: { tool_name: 'orphan_tool', success: false },
      };
      await channel.sendEvent(endEvent);

      const endMsg = mockServer.broadcast.mock.calls[0][0];
      expect(endMsg.toolUseId).toBe('tool-orphan_tool-unknown');
    });
  });

  // -----------------------------------------------------------------------
  // Tool params forwarding
  // -----------------------------------------------------------------------

  describe('tool params forwarding', () => {
    it('forwards params from ToolExecutionStart to the WS tool_use message', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      const startEvent: EventMsg = {
        type: 'ToolExecutionStart',
        data: {
          tool_name: 'browser_click',
          params: { selector: '#btn', button: 'left' },
        },
      };
      await channel.sendEvent(startEvent);

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.input).toEqual({ selector: '#btn', button: 'left' });
    });

    it('defaults to empty object when params are not provided', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      const startEvent: EventMsg = {
        type: 'ToolExecutionStart',
        data: { tool_name: 'screenshot' },
      };
      await channel.sendEvent(startEvent);

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.input).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Event mapping
  // -----------------------------------------------------------------------

  describe('eventToWSMessage mapping', () => {
    beforeEach(async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();
    });

    it('maps AgentMessageDelta to assistant_chunk', async () => {
      await channel.sendEvent({
        type: 'AgentMessageDelta',
        data: { delta: 'hello world' },
      });

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.type).toBe('assistant_chunk');
      expect(msg.content).toBe('hello world');
      expect(msg.turnId).toBeTruthy();
    });

    it('maps TaskComplete to assistant_turn_complete', async () => {
      await channel.sendEvent({
        type: 'TaskComplete',
        data: { last_agent_message: 'All done.' },
      });

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.type).toBe('assistant_turn_complete');
      expect(msg.content).toBe('All done.');
    });

    it('maps Error to error with code', async () => {
      await channel.sendEvent({
        type: 'Error',
        data: { message: 'something broke', code: 'RATE_LIMIT' },
      });

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.type).toBe('error');
      expect(msg.message).toBe('something broke');
      expect(msg.code).toBe('RATE_LIMIT');
    });

    it('defaults error code to ERROR when not provided', async () => {
      await channel.sendEvent({
        type: 'Error',
        data: { message: 'unknown failure' },
      });

      const msg = mockServer.broadcast.mock.calls[0][0];
      expect(msg.code).toBe('ERROR');
    });

    it('drops unknown event types silently', async () => {
      await channel.sendEvent({
        type: 'AgentReasoning',
        data: { content: 'thinking...' },
      } as EventMsg);

      expect(mockServer.broadcast).not.toHaveBeenCalled();
      expect(mockServer.send).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // close() cleanup
  // -----------------------------------------------------------------------

  describe('close()', () => {
    it('resets all tracking state', async () => {
      await simulateUserTurn(channel);
      mockServer.send.mockClear();
      mockServer.broadcast.mockClear();

      await channel.close();

      // After close, events should be dropped (no active turn, not initialized)
      await expect(
        channel.sendEvent({ type: 'AgentMessageDelta', data: { delta: 'after close' } }),
      ).rejects.toThrow('WebSocketChannel not initialized');
    });
  });
});
