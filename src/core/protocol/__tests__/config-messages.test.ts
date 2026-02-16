import { describe, it, expect, vi, beforeEach } from 'vitest';

// These imports will initially fail because the implementations don't exist yet
import {
  ConfigMessage,
  ConfigMessageType,
  ConfigUpdateMessage,
  ConfigSyncMessage,
  ProfileSwitchMessage,
  createConfigMessage,
  isConfigMessage,
  handleConfigMessage
} from '@/core/protocol/config-messages';
import type { AgentConfigData } from '@/config/types';

describe('Config Messages Protocol', () => {
  describe('Message Creation', () => {
    it('should create config update messages', () => {
      const config: Partial<AgentConfigData> = {
        model: 'claude-3-haiku-20240307',
        approval_policy: 'never'
      };

      const message = createConfigMessage('CONFIG_UPDATE', config);

      expect(message).toEqual({
        type: 'CONFIG_MESSAGE',
        subtype: 'CONFIG_UPDATE',
        payload: config,
        timestamp: expect.any(Number),
        source: expect.any(String)
      });
    });

    it('should create profile switch messages', () => {
      const message = createConfigMessage('PROFILE_SWITCH', { profileName: 'development' });

      expect(message).toEqual({
        type: 'CONFIG_MESSAGE',
        subtype: 'PROFILE_SWITCH',
        payload: { profileName: 'development' },
        timestamp: expect.any(Number),
        source: expect.any(String)
      });
    });

    it('should create config sync request messages', () => {
      const message = createConfigMessage('SYNC_REQUEST', { requestId: 'req-123' });

      expect(message).toEqual({
        type: 'CONFIG_MESSAGE',
        subtype: 'SYNC_REQUEST',
        payload: { requestId: 'req-123' },
        timestamp: expect.any(Number),
        source: expect.any(String)
      });
    });

    it('should create config sync response messages', () => {
      const config: AgentConfigData = {
        model: 'claude-3-5-sonnet-20241022',
        approval_policy: 'on-request',
        sandbox_policy: { mode: 'read-only' }
      };

      const message = createConfigMessage('SYNC_RESPONSE', {
        requestId: 'req-123',
        config,
        activeProfile: 'default'
      });

      expect(message.subtype).toBe('SYNC_RESPONSE');
      expect(message.payload).toEqual({
        requestId: 'req-123',
        config,
        activeProfile: 'default'
      });
    });

    it('should include source context in messages', () => {
      const message = createConfigMessage('CONFIG_UPDATE', {}, 'background');

      expect(message.source).toBe('background');
    });
  });

  describe('Message Validation', () => {
    it('should identify valid config messages', () => {
      const validMessage: ConfigMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'CONFIG_UPDATE',
        payload: { model: 'claude-3-haiku-20240307' },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      expect(isConfigMessage(validMessage)).toBe(true);
    });

    it('should reject invalid message structure', () => {
      const invalidMessages = [
        { type: 'OTHER_MESSAGE' },
        { type: 'CONFIG_MESSAGE' }, // Missing subtype
        { type: 'CONFIG_MESSAGE', subtype: 'INVALID_SUBTYPE' },
        null,
        undefined,
        'not-an-object'
      ];

      invalidMessages.forEach(message => {
        expect(isConfigMessage(message as any)).toBe(false);
      });
    });

    it('should validate message payload structure', () => {
      const validUpdateMessage: ConfigUpdateMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'CONFIG_UPDATE',
        payload: {
          model: 'claude-3-haiku-20240307',
          approval_policy: 'never'
        },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      const validProfileMessage: ProfileSwitchMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'PROFILE_SWITCH',
        payload: { profileName: 'development' },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      expect(isConfigMessage(validUpdateMessage)).toBe(true);
      expect(isConfigMessage(validProfileMessage)).toBe(true);
    });

    it('should validate sync message payloads', () => {
      const syncRequest: ConfigSyncMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'SYNC_REQUEST',
        payload: { requestId: 'req-456' },
        timestamp: Date.now(),
        source: 'content'
      };

      const syncResponse: ConfigSyncMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'SYNC_RESPONSE',
        payload: {
          requestId: 'req-456',
          config: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request',
            sandbox_policy: { mode: 'read-only' }
          },
          activeProfile: 'default'
        },
        timestamp: Date.now(),
        source: 'background'
      };

      expect(isConfigMessage(syncRequest)).toBe(true);
      expect(isConfigMessage(syncResponse)).toBe(true);
    });
  });

  describe('Message Handling', () => {
    let mockHandler: {
      onConfigUpdate: ReturnType<typeof vi.fn>;
      onProfileSwitch: ReturnType<typeof vi.fn>;
      onSyncRequest: ReturnType<typeof vi.fn>;
      onSyncResponse: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      mockHandler = {
        onConfigUpdate: vi.fn(),
        onProfileSwitch: vi.fn(),
        onSyncRequest: vi.fn(),
        onSyncResponse: vi.fn()
      };
    });

    it('should route CONFIG_UPDATE messages', async () => {
      const message: ConfigUpdateMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'CONFIG_UPDATE',
        payload: { model: 'claude-3-haiku-20240307' },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      await handleConfigMessage(message, mockHandler);

      expect(mockHandler.onConfigUpdate).toHaveBeenCalledWith(message.payload, message);
      expect(mockHandler.onProfileSwitch).not.toHaveBeenCalled();
    });

    it('should route PROFILE_SWITCH messages', async () => {
      const message: ProfileSwitchMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'PROFILE_SWITCH',
        payload: { profileName: 'development' },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      await handleConfigMessage(message, mockHandler);

      expect(mockHandler.onProfileSwitch).toHaveBeenCalledWith(message.payload, message);
      expect(mockHandler.onConfigUpdate).not.toHaveBeenCalled();
    });

    it('should route SYNC_REQUEST messages', async () => {
      const message: ConfigSyncMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'SYNC_REQUEST',
        payload: { requestId: 'req-789' },
        timestamp: Date.now(),
        source: 'content'
      };

      await handleConfigMessage(message, mockHandler);

      expect(mockHandler.onSyncRequest).toHaveBeenCalledWith(message.payload, message);
    });

    it('should route SYNC_RESPONSE messages', async () => {
      const message: ConfigSyncMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'SYNC_RESPONSE',
        payload: {
          requestId: 'req-789',
          config: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request',
            sandbox_policy: { mode: 'read-only' }
          },
          activeProfile: 'default'
        },
        timestamp: Date.now(),
        source: 'background'
      };

      await handleConfigMessage(message, mockHandler);

      expect(mockHandler.onSyncResponse).toHaveBeenCalledWith(message.payload, message);
    });

    it('should handle unknown message subtypes gracefully', async () => {
      const unknownMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'UNKNOWN_SUBTYPE',
        payload: {},
        timestamp: Date.now(),
        source: 'unknown'
      } as any;

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await handleConfigMessage(unknownMessage, mockHandler);

      expect(consoleSpy).toHaveBeenCalledWith('Unknown config message subtype:', 'UNKNOWN_SUBTYPE');

      consoleSpy.mockRestore();
    });

    it('should handle message processing errors', async () => {
      const message: ConfigUpdateMessage = {
        type: 'CONFIG_MESSAGE',
        subtype: 'CONFIG_UPDATE',
        payload: { model: 'claude-3-haiku-20240307' },
        timestamp: Date.now(),
        source: 'sidepanel'
      };

      mockHandler.onConfigUpdate.mockRejectedValue(new Error('Processing failed'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await handleConfigMessage(message, mockHandler);

      expect(consoleSpy).toHaveBeenCalledWith(
        'Error handling config message:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Cross-Context Messaging', () => {
    it('should support background to content messaging', () => {
      const message = createConfigMessage(
        'CONFIG_UPDATE',
        { model: 'claude-3-haiku-20240307' },
        'background'
      );

      expect(message.source).toBe('background');
      expect(message.type).toBe('CONFIG_MESSAGE');
    });

    it('should support bidirectional sync messaging', () => {
      const requestMessage = createConfigMessage(
        'SYNC_REQUEST',
        { requestId: 'sync-001' },
        'content'
      );

      const responseMessage = createConfigMessage(
        'SYNC_RESPONSE',
        {
          requestId: 'sync-001',
          config: {
            model: 'claude-3-5-sonnet-20241022',
            approval_policy: 'on-request',
            sandbox_policy: { mode: 'read-only' }
          },
          activeProfile: 'default'
        },
        'background'
      );

      expect(requestMessage.source).toBe('content');
      expect(responseMessage.source).toBe('background');
      expect(responseMessage.payload.requestId).toBe(requestMessage.payload.requestId);
    });

    it('should handle message ordering with timestamps', () => {
      const timestamp = Date.now();

      const message1 = createConfigMessage('CONFIG_UPDATE', { model: 'claude-3-haiku-20240307' });
      const message2 = createConfigMessage('CONFIG_UPDATE', { model: 'claude-3-5-sonnet-20241022' });

      expect(message2.timestamp).toBeGreaterThanOrEqual(message1.timestamp);
    });

    it('should preserve message context across serialization', () => {
      const originalMessage = createConfigMessage(
        'PROFILE_SWITCH',
        { profileName: 'production' },
        'sidepanel'
      );

      const serialized = JSON.stringify(originalMessage);
      const deserialized = JSON.parse(serialized) as ConfigMessage;

      expect(deserialized).toEqual(originalMessage);
      expect(isConfigMessage(deserialized)).toBe(true);
    });
  });

  describe('Message Filtering and Routing', () => {
    it('should filter messages by source', () => {
      const messages = [
        createConfigMessage('CONFIG_UPDATE', {}, 'background'),
        createConfigMessage('CONFIG_UPDATE', {}, 'content'),
        createConfigMessage('CONFIG_UPDATE', {}, 'sidepanel')
      ];

      const backgroundMessages = messages.filter(msg => msg.source === 'background');
      const contentMessages = messages.filter(msg => msg.source === 'content');

      expect(backgroundMessages).toHaveLength(1);
      expect(contentMessages).toHaveLength(1);
      expect(backgroundMessages[0].source).toBe('background');
    });

    it('should filter messages by subtype', () => {
      const messages = [
        createConfigMessage('CONFIG_UPDATE', {}),
        createConfigMessage('PROFILE_SWITCH', { profileName: 'dev' }),
        createConfigMessage('SYNC_REQUEST', { requestId: 'req-1' })
      ];

      const updateMessages = messages.filter(msg => msg.subtype === 'CONFIG_UPDATE');
      const profileMessages = messages.filter(msg => msg.subtype === 'PROFILE_SWITCH');

      expect(updateMessages).toHaveLength(1);
      expect(profileMessages).toHaveLength(1);
    });

    it('should support message batching', () => {
      const batchMessage = createConfigMessage('CONFIG_BATCH', {
        operations: [
          { type: 'CONFIG_UPDATE', payload: { model: 'claude-3-haiku-20240307' } },
          { type: 'PROFILE_SWITCH', payload: { profileName: 'development' } }
        ]
      });

      expect(batchMessage.subtype).toBe('CONFIG_BATCH');
      expect(batchMessage.payload.operations).toHaveLength(2);
    });
  });
});