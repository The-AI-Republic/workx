/**
 * Unit tests for A2AServer (FR-6, server decoupling).
 *
 * Covers: agent-card generation, message/send routing into the bridge,
 * empty-message handling, and tasks/cancel — all via a mock A2AAgentBridge
 * (no real agent runtime required).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  A2AServer,
  DEFAULT_PROTOCOL_VERSION,
  type A2AAgentBridge,
  type A2ATurnResult,
} from '../A2AServer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBridge(overrides: Partial<A2AAgentBridge> = {}): A2AAgentBridge {
  return {
    runTurn: vi.fn(
      async (): Promise<A2ATurnResult> => ({ text: 'hello from agent', success: true })
    ),
    listToolNames: vi.fn(() => ['shell', 'browser']),
    ...overrides,
  };
}

function makeServer(bridge: A2AAgentBridge): A2AServer {
  return new A2AServer({
    bridge,
    identity: {
      name: 'Test Agent',
      description: 'A test agent',
      version: '9.9.9',
      url: 'http://localhost:18100/a2a',
    },
  });
}

function messageSendRequest(text: string, id = 'req-1') {
  return {
    jsonrpc: '2.0',
    id,
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        role: 'user',
        messageId: 'msg-1',
        parts: [{ kind: 'text', text }],
      },
      configuration: { blocking: true },
    },
  };
}

/** Pull the JSON-RPC result payload (a Message or Task) out of a response. */
function resultOf(response: unknown): any {
  const r = response as { result?: unknown; error?: unknown };
  expect(r.error).toBeUndefined();
  return r.result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2AServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('agent card', () => {
    it('builds a card from the identity with a general skill', () => {
      const server = makeServer(makeBridge());
      const card = server.getAgentCard();

      expect(card.name).toBe('Test Agent');
      expect(card.description).toBe('A test agent');
      expect(card.version).toBe('9.9.9');
      expect(card.url).toBe('http://localhost:18100/a2a');
      expect(card.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
      expect(card.preferredTransport).toBe('JSONRPC');
      expect(card.capabilities.streaming).toBe(false);
      expect(card.capabilities.pushNotifications).toBe(false);
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe('general');
    });

    it('surfaces tool names as skill tags', () => {
      const server = makeServer(makeBridge({ listToolNames: () => ['shell', 'browser'] }));
      const tags = server.getAgentCard().skills[0].tags;
      expect(tags).toContain('shell');
      expect(tags).toContain('browser');
    });

    it('tolerates a throwing listToolNames', () => {
      const server = makeServer(
        makeBridge({
          listToolNames: () => {
            throw new Error('boom');
          },
        })
      );
      // Card still builds; tags just omit tool names.
      expect(server.getAgentCard().skills[0].tags).toEqual(
        expect.arrayContaining(['general', 'delegation'])
      );
    });
  });

  describe('message/send', () => {
    it('routes the message text into the bridge and returns the result', async () => {
      const bridge = makeBridge({
        runTurn: vi.fn(async () => ({ text: 'the answer is 42', success: true })),
      });
      const server = makeServer(bridge);

      const response = await server.handleRpc(messageSendRequest('what is the answer?'));
      const result = resultOf(response);

      expect(bridge.runTurn).toHaveBeenCalledTimes(1);
      expect((bridge.runTurn as any).mock.calls[0][0].text).toBe('what is the answer?');

      // Blocking message/send resolves to a terminal Task with the answer.
      expect(result.kind).toBe('task');
      expect(result.status.state).toBe('completed');
      const text = result.artifacts?.[0]?.parts?.[0]?.text;
      expect(text).toBe('the answer is 42');
    });

    it('marks the task failed when the bridge reports failure', async () => {
      const bridge = makeBridge({
        runTurn: vi.fn(async () => ({ text: '', success: false, error: 'model exploded' })),
      });
      const server = makeServer(bridge);

      const result = resultOf(await server.handleRpc(messageSendRequest('do a thing')));
      expect(result.kind).toBe('task');
      expect(result.status.state).toBe('failed');
    });

    it('fails fast on an empty message without calling the bridge', async () => {
      const bridge = makeBridge();
      const server = makeServer(bridge);

      const result = resultOf(await server.handleRpc(messageSendRequest('   ')));
      expect(bridge.runTurn).not.toHaveBeenCalled();
      expect(result.status.state).toBe('failed');
    });
  });

  describe('in-flight task is observable (working task published)', () => {
    it('non-blocking send returns a working task that tasks/get can resolve mid-run', async () => {
      let resolveTurn!: (r: A2ATurnResult) => void;
      const bridge = makeBridge({
        runTurn: vi.fn(() => new Promise<A2ATurnResult>((res) => (resolveTurn = res))),
      });
      const server = makeServer(bridge);

      const req = messageSendRequest('a long task', 'nb-1');
      (req.params as any).configuration = { blocking: false };

      const first = resultOf(await server.handleRpc(req));
      expect(first.kind).toBe('task');
      expect(first.status.state).toBe('working');
      const taskId = first.id as string;

      // Mid-run: the task exists in the store, so tasks/get resolves it.
      const got = resultOf(
        await server.handleRpc({ jsonrpc: '2.0', id: 'g1', method: 'tasks/get', params: { id: taskId } })
      );
      expect(got.id).toBe(taskId);
      expect(got.status.state).toBe('working');

      resolveTurn({ text: 'done', success: true });
    });

    it('tasks/cancel finds the running task instead of taskNotFound', async () => {
      // The real bridge resolves a turn when it is aborted (via TurnAborted);
      // mirror that so cancel can drive the executor to a terminal state.
      const bridge = makeBridge({
        runTurn: vi.fn(
          (p: { signal: AbortSignal }) =>
            new Promise<A2ATurnResult>((res) => {
              p.signal.addEventListener('abort', () =>
                res({ text: '', success: false, error: 'aborted' })
              );
            })
        ),
      });
      const server = makeServer(bridge);

      const req = messageSendRequest('cancel me', 'nb-2');
      (req.params as any).configuration = { blocking: false };
      const first = resultOf(await server.handleRpc(req));
      const taskId = first.id as string;

      const cancelResponse = (await server.handleRpc({
        jsonrpc: '2.0',
        id: 'c1',
        method: 'tasks/cancel',
        params: { id: taskId },
      })) as { error?: { code: number; message: string } };

      // The fix: an intermediate task exists, so cancel does not 404 with
      // "Task not found" (the pre-fix behavior).
      expect(cancelResponse.error?.message ?? '').not.toMatch(/not found/i);
    });
  });

  describe('errors', () => {
    it('returns a JSON-RPC error for an unknown method', async () => {
      const server = makeServer(makeBridge());
      const response = (await server.handleRpc({
        jsonrpc: '2.0',
        id: 'x',
        method: 'bogus/method',
        params: {},
      })) as { error?: { code: number } };
      expect(response.error).toBeDefined();
    });
  });
});
