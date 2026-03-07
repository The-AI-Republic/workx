import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { MessageType } from '@/core/message-types';

// Mock getInitializedUIClient before importing sendMessage
const mockServiceRequest = vi.fn();
vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(() =>
    Promise.resolve({ serviceRequest: mockServiceRequest }),
  ),
}));

import { sendMessage } from '../messaging';
import { getInitializedUIClient } from '@/core/messaging';

const mockedGetInitializedUIClient = vi.mocked(getInitializedUIClient);

describe('sendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockServiceRequest.mockReset();
    // Reset chrome.runtime.lastError
    (globalThis as any).chrome.runtime.lastError = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('UIChannelClient path', () => {
    it('should delegate to serviceRequest when service path mapping exists', async () => {
      mockServiceRequest.mockResolvedValue([{ name: 'test-skill' }]);

      const result = await sendMessage(MessageType.SKILLS_LIST);

      expect(mockServiceRequest).toHaveBeenCalledWith('skills.list', {});
      expect(result).toEqual([{ name: 'test-skill' }]);
    });

    it('should forward object payload as params', async () => {
      mockServiceRequest.mockResolvedValue({ success: true });

      const payload = { name: 'my-skill' };
      await sendMessage(MessageType.SKILLS_DELETE, payload);

      expect(mockServiceRequest).toHaveBeenCalledWith('skills.delete', { name: 'my-skill' });
    });

    it('should wrap non-object payload in { payload }', async () => {
      mockServiceRequest.mockResolvedValue({ success: true });

      await sendMessage(MessageType.PING, 'hello');

      expect(mockServiceRequest).toHaveBeenCalledWith('agent.ping', { payload: 'hello' });
    });

    it('should fall through to chrome.runtime on UIChannelClient error', async () => {
      mockedGetInitializedUIClient.mockRejectedValue(new Error('No transport'));

      const mockSendMessage = (globalThis as any).chrome.runtime.sendMessage;
      mockSendMessage.mockImplementation((_msg: any, callback: (resp: any) => void) => {
        callback({ success: true, data: 'fallback' });
      });

      const result = await sendMessage(MessageType.SKILLS_LIST);
      expect(result).toBe('fallback');
    });
  });

  describe('chrome.runtime fallback path', () => {
    beforeEach(() => {
      // Make UIChannelClient unavailable so we hit the chrome fallback
      mockedGetInitializedUIClient.mockRejectedValue(new Error('No transport'));
    });

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
    it('should throw when neither UIChannelClient nor chrome.runtime is available', async () => {
      mockedGetInitializedUIClient.mockRejectedValue(new Error('No transport'));
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = undefined;

      await expect(sendMessage(MessageType.SKILLS_LIST)).rejects.toThrow('No messaging service available');

      (globalThis as any).chrome = originalChrome;
    });
  });
});
