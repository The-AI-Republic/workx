/**
 * Unit tests for A2AClient
 *
 * Covers: constructor, connect lifecycle, disconnect, sendMessage,
 * sendMessageStream, abortStream, getters, auth fetch, error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IA2AAgentConfig, A2AConnectionStatus } from '../types';

// ---------------------------------------------------------------------------
// Mock external modules BEFORE importing the class under test
// ---------------------------------------------------------------------------

const mockGetAgentCard = vi.fn();
const mockSendMessage = vi.fn();
const mockSendMessageStream = vi.fn();
const mockCreateFromUrl = vi.fn();

vi.mock('@a2a-js/sdk/client', () => ({
  ClientFactory: vi.fn().mockImplementation(() => ({
    createFromUrl: (...args: any[]) => mockCreateFromUrl(...args),
  })),
  JsonRpcTransportFactory: vi.fn().mockImplementation(() => ({})),
  DefaultAgentCardResolver: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../A2AConfig', () => ({
  isDebugLoggingEnabled: vi.fn().mockResolvedValue(false),
}));

import { A2AClient, type A2AClientOptions } from '../A2AClient';
import { isDebugLoggingEnabled } from '../A2AConfig';
import { ClientFactory } from '@a2a-js/sdk/client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfig(overrides: Partial<IA2AAgentConfig> = {}): IA2AAgentConfig {
  return {
    id: 'agent-1',
    name: 'test-agent',
    url: 'https://agent.example.com',
    authType: 'none',
    enabled: true,
    trusted: false,
    timeout: 30000,
    platform: 'shared',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createOptions(overrides: Partial<A2AClientOptions> = {}): A2AClientOptions {
  return {
    config: createConfig(overrides.config as any),
    apiKey: overrides.apiKey,
    onStatusChange: overrides.onStatusChange,
    onSkillsChange: overrides.onSkillsChange,
  };
}

const sampleAgentCard = {
  name: 'Test Agent',
  version: '1.0.0',
  protocolVersion: '0.2',
  description: 'A test agent',
  url: 'https://agent.example.com',
  capabilities: { streaming: true, pushNotifications: false },
  skills: [
    {
      id: 'skill-1',
      name: 'summarize',
      description: 'Summarizes text',
      tags: ['nlp'],
      inputModes: ['text'],
      outputModes: ['text'],
    },
    {
      id: 'skill-2',
      name: 'translate',
      description: 'Translates text',
      tags: [],
      inputModes: ['text'],
      outputModes: ['text'],
    },
  ],
};

function makeSdkClient() {
  return {
    getAgentCard: mockGetAgentCard,
    sendMessage: mockSendMessage,
    sendMessageStream: mockSendMessageStream,
  };
}

/** Set up mocks so that connect() succeeds and return a connected-ready A2AClient. */
function setupForConnect(opts?: Partial<A2AClientOptions>) {
  const sdkClient = makeSdkClient();
  mockCreateFromUrl.mockResolvedValue(sdkClient);
  mockGetAgentCard.mockResolvedValue(sampleAgentCard);

  const options = createOptions(opts);
  return { client: new A2AClient(options), options, sdkClient };
}

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < items.length) return { value: items[i++], done: false };
          return { value: undefined as any, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2AClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Re-establish mock implementations after clearAllMocks
    (ClientFactory as any).mockImplementation(() => ({
      createFromUrl: (...args: any[]) => mockCreateFromUrl(...args),
    }));

    vi.mocked(isDebugLoggingEnabled).mockResolvedValue(false);

    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as `${string}-${string}-${string}-${string}-${string}`
    );
  });

  // ========================================================================
  // Constructor & initial state
  // ========================================================================

  describe('constructor', () => {
    it('should initialise with disconnected status', () => {
      const client = new A2AClient(createOptions());
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should initialise with null agent card', () => {
      const client = new A2AClient(createOptions());
      expect(client.getAgentCard()).toBeNull();
    });

    it('should initialise with empty skills array', () => {
      const client = new A2AClient(createOptions());
      expect(client.getSkills()).toEqual([]);
    });

    it('should initialise with undefined lastError', () => {
      const client = new A2AClient(createOptions());
      expect(client.getLastError()).toBeUndefined();
    });

    it('should expose the config ID', () => {
      const client = new A2AClient(createOptions({ config: { id: 'xyz' } as any }));
      expect(client.getConfigId()).toBe('xyz');
    });

    it('should initialise with null SDK client', () => {
      const client = new A2AClient(createOptions());
      expect(client.getClient()).toBeNull();
    });
  });

  // ========================================================================
  // connect()
  // ========================================================================

  describe('connect', () => {
    it('should transition status through connecting -> connected', async () => {
      const statuses: A2AConnectionStatus[] = [];
      const onStatusChange = vi.fn((s: A2AConnectionStatus) => statuses.push(s));
      const { client } = setupForConnect({ onStatusChange });

      await client.connect();

      expect(statuses).toEqual(['connecting', 'connected']);
    });

    it('should cache the agent card after connection', async () => {
      const { client } = setupForConnect();
      await client.connect();
      expect(client.getAgentCard()).toBe(sampleAgentCard);
    });

    it('should extract skills from the agent card', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const skills = client.getSkills();
      expect(skills).toHaveLength(2);
      expect(skills[0]).toEqual({
        id: 'skill-1',
        name: 'summarize',
        description: 'Summarizes text',
        tags: ['nlp'],
        inputModes: ['text'],
        outputModes: ['text'],
      });
    });

    it('should call onSkillsChange callback with extracted skills', async () => {
      const onSkillsChange = vi.fn();
      const { client } = setupForConnect({ onSkillsChange });

      await client.connect();

      expect(onSkillsChange).toHaveBeenCalledOnce();
      expect(onSkillsChange).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ name: 'summarize' }),
        ])
      );
    });

    it('should set status to connected after success', async () => {
      const { client } = setupForConnect();
      await client.connect();
      expect(client.getStatus()).toBe('connected');
    });

    it('should expose the SDK client after connection', async () => {
      const { client, sdkClient } = setupForConnect();
      await client.connect();
      expect(client.getClient()).toBe(sdkClient);
    });

    it('should short-circuit if already connected', async () => {
      const { client } = setupForConnect();
      await client.connect();
      mockCreateFromUrl.mockClear();

      await client.connect(); // second call
      expect(mockCreateFromUrl).not.toHaveBeenCalled();
    });

    it('should short-circuit if currently connecting', async () => {
      const { client } = setupForConnect();
      const first = client.connect();
      const second = client.connect(); // should be a no-op
      await first;
      await second;
      expect(mockCreateFromUrl).toHaveBeenCalledTimes(1);
    });

    it('should handle skills with missing tags gracefully', async () => {
      const card = {
        ...sampleAgentCard,
        skills: [{ id: 's1', name: 'foo', description: 'bar' }],
      };
      mockCreateFromUrl.mockResolvedValue(makeSdkClient());
      mockGetAgentCard.mockResolvedValue(card);

      const client = new A2AClient(createOptions());
      await client.connect();

      expect(client.getSkills()[0].tags).toEqual([]);
    });

    it('should set status to error on failure and throw', async () => {
      mockCreateFromUrl.mockRejectedValue(new Error('network fail'));
      const onStatusChange = vi.fn();
      const client = new A2AClient(createOptions({ onStatusChange }));

      await expect(client.connect()).rejects.toThrow('network fail');
      expect(client.getStatus()).toBe('error');
      expect(client.getLastError()).toBe('network fail');
    });

    it('should clean up state on connection failure', async () => {
      mockCreateFromUrl.mockRejectedValue(new Error('oops'));
      const client = new A2AClient(createOptions());

      await expect(client.connect()).rejects.toThrow();
      expect(client.getClient()).toBeNull();
      expect(client.getAgentCard()).toBeNull();
      expect(client.getSkills()).toEqual([]);
    });

    it('should handle non-Error thrown objects in connect', async () => {
      mockCreateFromUrl.mockRejectedValue('string error');
      const client = new A2AClient(createOptions());

      await expect(client.connect()).rejects.toThrow('string error');
    });

    it('should respect timeout from config', async () => {
      const slowCreate = new Promise(() => {
        // never resolves
      });
      mockCreateFromUrl.mockReturnValue(slowCreate);

      const config = createConfig({ timeout: 50 });
      const client = new A2AClient({ config });

      await expect(client.connect()).rejects.toThrow('Connection timeout after 50ms');
    });

    it('should fire onStatusChange with error status on failure', async () => {
      mockCreateFromUrl.mockRejectedValue(new Error('nope'));
      const onStatusChange = vi.fn();
      const client = new A2AClient(createOptions({ onStatusChange }));

      await expect(client.connect()).rejects.toThrow();

      expect(onStatusChange).toHaveBeenCalledWith('error', 'nope');
    });
  });

  // ========================================================================
  // disconnect()
  // ========================================================================

  describe('disconnect', () => {
    it('should transition to disconnected', async () => {
      const { client } = setupForConnect();
      await client.connect();
      await client.disconnect();
      expect(client.getStatus()).toBe('disconnected');
    });

    it('should clear cached state on disconnect', async () => {
      const { client } = setupForConnect();
      await client.connect();
      await client.disconnect();

      expect(client.getClient()).toBeNull();
      expect(client.getAgentCard()).toBeNull();
      expect(client.getSkills()).toEqual([]);
    });

    it('should be a no-op when already disconnected', async () => {
      const onStatusChange = vi.fn();
      const client = new A2AClient(createOptions({ onStatusChange }));
      await client.disconnect();
      expect(onStatusChange).not.toHaveBeenCalled();
    });

    it('should fire disconnecting then disconnected statuses', async () => {
      const statuses: A2AConnectionStatus[] = [];
      const onStatusChange = vi.fn((s: A2AConnectionStatus) => statuses.push(s));
      const { client } = setupForConnect({ onStatusChange });
      await client.connect();
      statuses.length = 0;

      await client.disconnect();

      expect(statuses).toEqual(['disconnecting', 'disconnected']);
    });

    it('should allow reconnection after disconnect', async () => {
      const { client } = setupForConnect();
      await client.connect();
      await client.disconnect();

      // Re-setup mocks for second connect
      mockCreateFromUrl.mockResolvedValue(makeSdkClient());
      mockGetAgentCard.mockResolvedValue(sampleAgentCard);

      await client.connect();
      expect(client.getStatus()).toBe('connected');
    });
  });

  // ========================================================================
  // ensureConnected()
  // ========================================================================

  describe('ensureConnected', () => {
    it('should throw when not connected', () => {
      const client = new A2AClient(createOptions());
      expect(() => client.ensureConnected()).toThrow('Not connected to A2A agent');
    });

    it('should not throw when connected', async () => {
      const { client } = setupForConnect();
      await client.connect();
      expect(() => client.ensureConnected()).not.toThrow();
    });
  });

  // ========================================================================
  // sendMessage()
  // ========================================================================

  describe('sendMessage', () => {
    it('should return error result when not connected', async () => {
      const client = new A2AClient(createOptions());
      const result = await client.sendMessage('hello');

      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'Not connected to A2A agent',
      });
    });

    it('should send a message with blocking configuration', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'text', text: 'Hello back' }],
      });

      await client.sendMessage('hello');

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: { blocking: true },
          message: expect.objectContaining({
            kind: 'message',
            role: 'user',
            parts: [{ kind: 'text', text: 'hello' }],
          }),
        })
      );
    });

    it('should return mapped content for message-kind results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'text', text: 'response text' }],
      });

      const result = await client.sendMessage('hello');
      expect(result.success).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'response text' }]);
    });

    it('should return success for completed task results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'task',
        id: 'task-123',
        status: { state: 'completed', message: null },
        artifacts: [{ parts: [{ kind: 'text', text: 'artifact output' }] }],
      });

      const result = await client.sendMessage('do something');
      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-123');
      expect(result.taskStatus).toBe('completed');
      expect(result.content).toEqual([{ type: 'text', text: 'artifact output' }]);
    });

    it('should return failure for failed task results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'task',
        id: 'task-999',
        status: {
          state: 'failed',
          message: { parts: [{ kind: 'text', text: 'something went wrong' }] },
        },
        artifacts: [],
      });

      const result = await client.sendMessage('fail me');
      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.taskStatus).toBe('failed');
    });

    it('should include status message content in task results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'task',
        id: 'task-1',
        status: {
          state: 'completed',
          message: { parts: [{ kind: 'text', text: 'status info' }] },
        },
        artifacts: [],
      });

      const result = await client.sendMessage('hi');
      expect(result.content).toEqual([{ type: 'text', text: 'status info' }]);
    });

    it('should pass contextId and taskId when provided', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'text', text: 'ok' }],
      });

      await client.sendMessage('hello', 'ctx-1', 'task-1');

      const call = mockSendMessage.mock.calls[0][0];
      expect(call.message.contextId).toBe('ctx-1');
      expect(call.message.taskId).toBe('task-1');
    });

    it('should not include contextId/taskId when not provided', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'text', text: 'ok' }],
      });

      await client.sendMessage('hello');

      const call = mockSendMessage.mock.calls[0][0];
      expect(call.message.contextId).toBeUndefined();
      expect(call.message.taskId).toBeUndefined();
    });

    it('should handle file parts in message results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [
          {
            kind: 'file',
            file: { uri: 'https://files.com/a.png', mimeType: 'image/png', name: 'a.png' },
          },
        ],
      });

      const result = await client.sendMessage('get file');
      expect(result.content[0]).toEqual({
        type: 'file',
        uri: 'https://files.com/a.png',
        mimeType: 'image/png',
        name: 'a.png',
      });
    });

    it('should handle data parts in message results', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'data', data: { foo: 'bar' } }],
      });

      const result = await client.sendMessage('get data');
      expect(result.content[0]).toEqual({
        type: 'data',
        data: { foo: 'bar' },
      });
    });

    it('should handle unknown part kinds by skipping them', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [
          { kind: 'unknown-type', value: 123 },
          { kind: 'text', text: 'real content' },
        ],
      });

      const result = await client.sendMessage('mixed');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({ type: 'text', text: 'real content' });
    });

    it('should catch sendMessage SDK errors and return error result', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockRejectedValue(new Error('SDK failure'));

      const result = await client.sendMessage('hello');
      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'SDK failure' });
    });

    it('should handle task with no artifacts and no status message', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'task',
        id: 'task-empty',
        status: { state: 'completed' },
        artifacts: [],
      });

      const result = await client.sendMessage('nothing');
      expect(result.success).toBe(true);
      expect(result.content).toEqual([]);
    });

    it('should handle task with multiple artifacts', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'task',
        id: 'task-multi',
        status: { state: 'completed' },
        artifacts: [
          { parts: [{ kind: 'text', text: 'first' }] },
          { parts: [{ kind: 'text', text: 'second' }] },
        ],
      });

      const result = await client.sendMessage('multi');
      expect(result.content).toEqual([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]);
    });

    it('should handle non-Error thrown in sendMessage', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockRejectedValue('plain string error');

      const result = await client.sendMessage('hello');
      expect(result.success).toBe(false);
      expect(result.content[0]).toEqual({ type: 'text', text: 'plain string error' });
    });
  });

  // ========================================================================
  // sendMessageStream()
  // ========================================================================

  describe('sendMessageStream', () => {
    it('should return error result when not connected', async () => {
      const client = new A2AClient(createOptions());
      const result = await client.sendMessageStream('hello');

      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
    });

    it('should process message-kind stream events', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'streamed' }] },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      const result = await client.sendMessageStream('hello', undefined, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          role: 'agent',
          content: [{ type: 'text', text: 'streamed' }],
        })
      );
      expect(result.content).toEqual([{ type: 'text', text: 'streamed' }]);
      expect(result.success).toBe(true); // no finalState but has content
    });

    it('should process task-kind stream events with completed state', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'task',
          id: 'task-s1',
          status: { state: 'completed', message: { parts: [{ kind: 'text', text: 'done' }] } },
          artifacts: [{ parts: [{ kind: 'text', text: 'output' }] }],
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      const result = await client.sendMessageStream('do it', undefined, onEvent);

      expect(result.success).toBe(true);
      expect(result.taskId).toBe('task-s1');
      expect(result.taskStatus).toBe('completed');
      expect(result.content).toEqual([
        { type: 'text', text: 'output' },
        { type: 'text', text: 'done' },
      ]);
    });

    it('should emit complete event for terminal task states', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'task',
          id: 'task-s2',
          status: { state: 'failed' },
          artifacts: [],
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      await client.sendMessageStream('fail', undefined, onEvent);

      const completeCall = onEvent.mock.calls.find(
        (c: any[]) => c[0].type === 'complete'
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![0].result.success).toBe(false);
      expect(completeCall![0].result.isError).toBe(true);
    });

    it('should emit complete event for canceled task state', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'task',
          id: 'task-canceled',
          status: { state: 'canceled' },
          artifacts: [],
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      await client.sendMessageStream('cancel', undefined, onEvent);

      const completeCall = onEvent.mock.calls.find(
        (c: any[]) => c[0].type === 'complete'
      );
      expect(completeCall).toBeDefined();
      expect(completeCall![0].result.success).toBe(false);
    });

    it('should process status-update events', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'status-update',
          taskId: 'task-su',
          status: { state: 'working', message: { parts: [{ kind: 'text', text: 'processing' }] } },
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      await client.sendMessageStream('work', undefined, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status-update',
          taskId: 'task-su',
          status: 'working',
        })
      );
    });

    it('should process artifact-update events', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'artifact-update',
          taskId: 'task-au',
          artifact: { parts: [{ kind: 'text', text: 'artifact data' }] },
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      const result = await client.sendMessageStream('get artifact', undefined, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'artifact-update',
          content: [{ type: 'text', text: 'artifact data' }],
        })
      );
      expect(result.content).toContainEqual({ type: 'text', text: 'artifact data' });
    });

    it('should pass contextId in message when provided', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessageStream.mockReturnValue(createAsyncIterable([]));

      await client.sendMessageStream('hello', 'ctx-42');

      const call = mockSendMessageStream.mock.calls[0][0];
      expect(call.message.contextId).toBe('ctx-42');
    });

    it('should handle AbortError by returning cancelled result', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      mockSendMessageStream.mockImplementation(() => {
        throw abortError;
      });

      const result = await client.sendMessageStream('cancel me');
      expect(result.success).toBe(false);
      expect(result.isError).toBe(false);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Stream was cancelled' });
    });

    it('should handle generic stream errors', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessageStream.mockImplementation(() => {
        throw new Error('stream broke');
      });

      const onEvent = vi.fn();
      const result = await client.sendMessageStream('oops', undefined, onEvent);

      expect(result.success).toBe(false);
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'stream broke' });
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', error: 'stream broke' })
      );
    });

    it('should clean up active stream after completion', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessageStream.mockReturnValue(createAsyncIterable([]));

      await client.sendMessageStream('test');

      // After completion, abortStream with the messageId should be a no-op
      await client.abortStream('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      // No error means it gracefully handled missing controller
    });

    it('should handle events with id instead of taskId', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        {
          kind: 'status-update',
          id: 'alt-task-id',
          status: { state: 'working' },
        },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      await client.sendMessageStream('test', undefined, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'status-update',
          taskId: 'alt-task-id',
        })
      );
    });

    it('should return success true when no final state but content collected', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'partial' }] },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const result = await client.sendMessageStream('hello');
      expect(result.success).toBe(true);
    });

    it('should return success false when no final state and no content', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessageStream.mockReturnValue(createAsyncIterable([]));

      const result = await client.sendMessageStream('empty');
      expect(result.success).toBe(false);
    });

    it('should not include contextId when not provided', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessageStream.mockReturnValue(createAsyncIterable([]));

      await client.sendMessageStream('hello');

      const call = mockSendMessageStream.mock.calls[0][0];
      expect(call.message.contextId).toBeUndefined();
    });

    it('should handle message events with missing role', async () => {
      const { client } = setupForConnect();
      await client.connect();

      const events = [
        { kind: 'message', parts: [{ kind: 'text', text: 'no role' }] },
      ];
      mockSendMessageStream.mockReturnValue(createAsyncIterable(events));

      const onEvent = vi.fn();
      await client.sendMessageStream('test', undefined, onEvent);

      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message',
          role: 'agent', // defaults to 'agent'
        })
      );
    });
  });

  // ========================================================================
  // abortStream()
  // ========================================================================

  describe('abortStream', () => {
    it('should be a no-op when no active stream for given messageId', async () => {
      const client = new A2AClient(createOptions());
      await expect(client.abortStream('nonexistent')).resolves.toBeUndefined();
    });

    it('should abort an active stream controller', async () => {
      const { client } = setupForConnect();
      await client.connect();

      let resolveWait: (() => void) | undefined;
      const waitPromise = new Promise<void>((r) => { resolveWait = r; });

      const stream = {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<any>> {
              await waitPromise;
              return { value: undefined, done: true };
            },
          };
        },
      };
      mockSendMessageStream.mockReturnValue(stream);

      const streamPromise = client.sendMessageStream('long running');

      await client.abortStream('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');

      resolveWait!();
      const result = await streamPromise;

      expect(result).toBeDefined();
    });
  });

  // ========================================================================
  // Auth fetch (via connect)
  // ========================================================================

  describe('auth fetch configuration', () => {
    it('should connect with bearer auth type', async () => {
      const config = createConfig({ authType: 'bearer' });
      mockCreateFromUrl.mockResolvedValue(makeSdkClient());
      mockGetAgentCard.mockResolvedValue(sampleAgentCard);

      const client = new A2AClient({ config, apiKey: 'my-secret-token' });
      await client.connect();

      expect(client.getStatus()).toBe('connected');
      expect(ClientFactory).toHaveBeenCalled();
    });

    it('should connect with apiKey auth type', async () => {
      const config = createConfig({ authType: 'apiKey' });
      mockCreateFromUrl.mockResolvedValue(makeSdkClient());
      mockGetAgentCard.mockResolvedValue(sampleAgentCard);

      const client = new A2AClient({ config, apiKey: 'api-key-123' });
      await client.connect();

      expect(client.getStatus()).toBe('connected');
    });

    it('should connect with none auth type and no apiKey', async () => {
      const config = createConfig({ authType: 'none' });
      mockCreateFromUrl.mockResolvedValue(makeSdkClient());
      mockGetAgentCard.mockResolvedValue(sampleAgentCard);

      const client = new A2AClient({ config });
      await client.connect();

      expect(client.getStatus()).toBe('connected');
    });
  });

  // ========================================================================
  // Debug logging
  // ========================================================================

  describe('debug logging', () => {
    it('should check debug logging status on first log call', async () => {
      const { client } = setupForConnect();
      await client.connect();
      expect(isDebugLoggingEnabled).toHaveBeenCalled();
    });

    it('should log when debug logging is enabled', async () => {
      vi.mocked(isDebugLoggingEnabled).mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { client } = setupForConnect();
      await client.connect();

      const a2aCalls = consoleSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[A2A:')
      );
      expect(a2aCalls.length).toBeGreaterThan(0);
    });

    it('should not log when debug logging is disabled', async () => {
      vi.mocked(isDebugLoggingEnabled).mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { client } = setupForConnect();
      await client.connect();

      const a2aCalls = consoleSpy.mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('[A2A:')
      );
      expect(a2aCalls).toHaveLength(0);
    });

    it('should handle isDebugLoggingEnabled throwing', async () => {
      vi.mocked(isDebugLoggingEnabled).mockRejectedValue(new Error('storage error'));

      const { client } = setupForConnect();
      // Should not throw despite debug logging failure
      await expect(client.connect()).resolves.toBeUndefined();
    });
  });

  // ========================================================================
  // mapPartsToContent edge cases (via sendMessage)
  // ========================================================================

  describe('mapPartsToContent edge cases', () => {
    it('should handle file parts with missing file fields', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'file', file: {} }],
      });

      const result = await client.sendMessage('get file');
      expect(result.content[0]).toEqual({
        type: 'file',
        uri: '',
        mimeType: undefined,
        name: undefined,
      });
    });

    it('should handle data parts with missing data', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [{ kind: 'data' }],
      });

      const result = await client.sendMessage('get data');
      expect(result.content[0]).toEqual({
        type: 'data',
        data: {},
      });
    });

    it('should handle multiple parts of different types', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [
          { kind: 'text', text: 'hello' },
          { kind: 'file', file: { uri: 'http://example.com/f.txt' } },
          { kind: 'data', data: { key: 'val' } },
        ],
      });

      const result = await client.sendMessage('multi');
      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({ type: 'text', text: 'hello' });
      expect(result.content[1]).toMatchObject({ type: 'file', uri: 'http://example.com/f.txt' });
      expect(result.content[2]).toEqual({ type: 'data', data: { key: 'val' } });
    });

    it('should handle empty parts array', async () => {
      const { client } = setupForConnect();
      await client.connect();

      mockSendMessage.mockResolvedValue({
        kind: 'message',
        parts: [],
      });

      const result = await client.sendMessage('empty parts');
      expect(result.content).toEqual([]);
    });
  });
});
