import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MessageType } from '@/core/MessageRouter';

// Mock tryGetMessageService before importing sendMessage
vi.mock('@/core/messaging', () => ({
  tryGetMessageService: vi.fn(() => null),
}));

import { sendMessage } from '../messaging';
import { tryGetMessageService } from '@/core/messaging';

const mockedTryGetMessageService = vi.mocked(tryGetMessageService);

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTryGetMessageService.mockReturnValue(null);
    // Reset chrome.runtime.lastError
    (globalThis as any).chrome.runtime.lastError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('IMessageService path', () => {
    it('should delegate to IMessageService.send() when service is available', async () => {
      const mockService = {
        send: vi.fn().mockResolvedValue([{ name: 'test-skill' }]),
        subscribe: vi.fn(),
        destroy: vi.fn(),
      };
      mockedTryGetMessageService.mockReturnValue(mockService as any);

      const result = await sendMessage(MessageType.SKILLS_LIST);

      expect(mockService.send).toHaveBeenCalledWith(MessageType.SKILLS_LIST, undefined);
      expect(result).toEqual([{ name: 'test-skill' }]);
    });

    it('should forward payload to IMessageService.send()', async () => {
      const mockService = {
        send: vi.fn().mockResolvedValue({ success: true }),
        subscribe: vi.fn(),
        destroy: vi.fn(),
      };
      mockedTryGetMessageService.mockReturnValue(mockService as any);

      const payload = { name: 'my-skill' };
      await sendMessage(MessageType.SKILLS_DELETE, payload);

      expect(mockService.send).toHaveBeenCalledWith(MessageType.SKILLS_DELETE, payload);
    });
  });

  describe('chrome.runtime fallback path', () => {
    it('should unwrap ResponseEnvelope and return data', async () => {
      const skillsData = [{ name: 'skill-1' }, { name: 'skill-2' }];
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: true, data: skillsData });
      });

      const result = await sendMessage<any[]>(MessageType.SKILLS_LIST);

      expect(result).toEqual(skillsData);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return unwrapped data even when data is empty array', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: true, data: [] });
      });

      const result = await sendMessage<any[]>(MessageType.SKILLS_LIST);

      expect(result).toEqual([]);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return undefined when envelope has no data field', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: true });
      });

      const result = await sendMessage(MessageType.SKILLS_LIST);

      expect(result).toBeUndefined();
    });

    it('should reject with error message when envelope indicates failure', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: false, error: 'Skill not found' });
      });

      await expect(sendMessage(MessageType.SKILLS_LIST)).rejects.toThrow('Skill not found');
    });

    it('should reject with default message when envelope has no error string', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: false });
      });

      await expect(sendMessage(MessageType.SKILLS_LIST)).rejects.toThrow('Request failed');
    });

    it('should reject when chrome.runtime.lastError is set', async () => {
      (globalThis as any).chrome.runtime.lastError = { message: 'Extension context invalidated' };
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback(undefined);
      });

      await expect(sendMessage(MessageType.SKILLS_LIST)).rejects.toThrow('Extension context invalidated');
    });

    it('should pass through non-envelope responses as-is', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback('raw-string-response');
      });

      const result = await sendMessage<string>(MessageType.CONFIG_UPDATE);

      expect(result).toBe('raw-string-response');
    });

    it('should pass through null responses', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback(null);
      });

      const result = await sendMessage(MessageType.CONFIG_UPDATE);

      expect(result).toBeNull();
    });

    it('should send correct message shape with type and payload', async () => {
      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((msg: any, callback: (resp: any) => void) => {
        callback({ success: true, data: null });
      });

      const payload = { name: 'test', mode: 'manual' };
      await sendMessage(MessageType.SKILLS_SAVE, payload);

      expect(mockSendMessage).toHaveBeenCalledWith(
        { type: MessageType.SKILLS_SAVE, payload },
        expect.any(Function)
      );
    });
  });

  describe('no messaging available', () => {
    it('should throw when neither IMessageService nor chrome.runtime is available', async () => {
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = undefined;

      await expect(sendMessage(MessageType.SKILLS_LIST)).rejects.toThrow('No messaging service available');

      (globalThis as any).chrome = originalChrome;
    });
  });
});
