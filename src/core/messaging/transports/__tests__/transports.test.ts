/**
 * Transport implementations unit tests
 *
 * Tests sessionId routing and event dispatch for UI transports:
 * ChromeExtensionTransport and WebSocketTransport
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelEvent } from '@/core/channels/types';

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------
class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(url: string) {
    this.url = url;
  }

  _open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }

  _message(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  _error(err?: any): void {
    this.onerror?.(err ?? new Error('ws error'));
  }
}

(globalThis as any).WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Imports (after mocks are in place)
// ---------------------------------------------------------------------------
import { ChromeExtensionTransport } from '../ChromeExtensionTransport';
import { WebSocketTransport } from '../WebSocketTransport';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getChrome() {
  return (globalThis as any).chrome;
}

function getLastListener(): (msg: any) => void {
  const calls = getChrome().runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0];
}

const fakeEventMsg = (type = 'response.output_item.done') => ({
  type,
  item: { id: 'item-1' },
});

// =========================================================================
// ChromeExtensionTransport
// =========================================================================
describe('ChromeExtensionTransport', () => {
  let transport: ChromeExtensionTransport;

  beforeEach(() => {
    // Re-stub sendMessage to return a promise (mockReset clears it)
    getChrome().runtime.sendMessage.mockResolvedValue(undefined);
    getChrome().runtime.lastError = null;
    transport = new ChromeExtensionTransport();
  });

  it('sendOp sends message with op and context via chrome.runtime.sendMessage', async () => {
    const op = { type: 'conversation.item.create' } as any;
    const context = { sessionId: 'sess-1' };
    await transport.sendOp(op, context);

    expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith({
      type: 'submission',
      op,
      sessionId: 'sess-1',
    });
  });

  it('sendOp throws on chrome.runtime.lastError', async () => {
    getChrome().runtime.sendMessage.mockImplementation(async () => {
      getChrome().runtime.lastError = { message: 'port closed' };
    });

    await expect(transport.sendOp({ type: 'response.create' } as any)).rejects.toThrow(
      'sendOp failed: port closed',
    );
  });

  it('initialize adds message listener', async () => {
    await transport.initialize();
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it('onEvent handler receives events with sessionId (SidePanelChannel format)', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const listener = getLastListener();
    const eventMsg = fakeEventMsg();
    listener({ type: 'event', event: eventMsg, sessionId: 'abc' });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(eventMsg);
    expect(received.sessionId).toBe('abc');
  });

  it('onEvent handler receives legacy events without sessionId', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const listener = getLastListener();
    const eventMsg = fakeEventMsg();
    listener({ type: 'EVENT', payload: { msg: eventMsg } });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(eventMsg);
    expect(received.sessionId).toBeUndefined();
  });

  it('onEvent ignores non-event messages', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const listener = getLastListener();
    listener({ type: 'other', data: 123 });
    listener(null);
    listener(undefined);
    listener({ type: 'submission', op: {} });

    expect(handler).not.toHaveBeenCalled();
  });

  it('unlisten removes handler', async () => {
    await transport.initialize();
    const handler = vi.fn();
    const unlisten = transport.onEvent(handler);
    unlisten();

    const listener = getLastListener();
    listener({ type: 'event', event: fakeEventMsg(), sessionId: 'x' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy removes chrome listener and clears handlers', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    await transport.destroy();

    expect(getChrome().runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });

  it('handler errors do not propagate to other handlers', async () => {
    await transport.initialize();
    const errorHandler = vi.fn(() => { throw new Error('boom'); });
    const goodHandler = vi.fn();
    transport.onEvent(errorHandler);
    transport.onEvent(goodHandler);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const listener = getLastListener();
    listener({ type: 'event', event: fakeEventMsg(), sessionId: 's1' });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });
});

// =========================================================================
// WebSocketTransport
// =========================================================================
describe('WebSocketTransport', () => {
  let transport: WebSocketTransport;
  let mockWs: MockWebSocket;

  beforeEach(() => {
    transport = new WebSocketTransport({ url: 'ws://localhost:8080' });

    const OrigCtor = (globalThis as any).WebSocket;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    (globalThis as any).WebSocket = class extends MockWebSocket {
      constructor(url: string) {
        super(url);
        mockWs = this; // eslint-disable-line @typescript-eslint/no-this-alias
      }
    };
    Object.assign((globalThis as any).WebSocket, OrigCtor);
  });

  /**
   * Drive the server handshake: server sends `connect.challenge`, the client
   * replies with a `connect` request, server answers `hello-ok`. Resolves once
   * initialize() completes. Clears `send` mock so later assertions are clean.
   */
  async function completeHandshake(): Promise<void> {
    const initPromise = transport.initialize();
    mockWs._open(); // socket open — server only sends the challenge after this
    mockWs._message({
      type: 'event',
      event: 'connect.challenge',
      payload: { protocolVersion: 1, nonce: 'n1' },
    });
    // Client should have sent exactly one `connect` request.
    const calls = mockWs.send.mock.calls;
    const connectFrame = JSON.parse(calls[calls.length - 1][0]);
    expect(connectFrame.method).toBe('connect');
    expect(connectFrame.params.client.mode).toBe('operator');
    mockWs._message({
      type: 'res',
      id: connectFrame.id,
      ok: true,
      payload: { type: 'hello-ok', server: { connId: 'c1' } },
    });
    await initPromise;
    mockWs.send.mockClear();
  }

  const userTurnOp = () =>
    ({
      type: 'UserTurn',
      items: [{ type: 'text', text: 'hi' }],
      model: 'test-model',
      tabId: 0,
      approval_policy: 'untrusted',
      sandbox_policy: { mode: 'danger-full-access' },
    }) as any;

  it('sendOp throws when not connected', async () => {
    await expect(transport.sendOp({ type: 'Interrupt' } as any)).rejects.toThrow(
      'WebSocket not connected',
    );
  });

  it('initialize completes the connect handshake', async () => {
    const initPromise = transport.initialize();
    expect(mockWs.url).toBe('ws://localhost:8080');
    mockWs._open();
    mockWs._message({
      type: 'event',
      event: 'connect.challenge',
      payload: { protocolVersion: 1, nonce: 'n1' },
    });
    const calls = mockWs.send.mock.calls;
    const connectFrame = JSON.parse(calls[calls.length - 1][0]);
    expect(connectFrame).toMatchObject({ type: 'req', method: 'connect' });
    mockWs._message({
      type: 'res',
      id: connectFrame.id,
      ok: true,
      payload: { type: 'hello-ok', server: { connId: 'c1' } },
    });
    await expect(initPromise).resolves.toBeUndefined();
  });

  it('translates a UserTurn op into a chat.send request', async () => {
    await completeHandshake();

    await transport.sendOp(userTurnOp());

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.type).toBe('req');
    expect(sent.method).toBe('chat.send');
    expect(sent.params).toMatchObject({
      items: [{ type: 'text', text: 'hi' }],
      model: 'test-model',
      tabId: 0,
      approval_policy: 'untrusted',
      sandbox_policy: { mode: 'danger-full-access' },
    });
  });

  it('translates an Interrupt op into a chat.abort request', async () => {
    await completeHandshake();

    await transport.sendOp({ type: 'Interrupt' } as any);

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.method).toBe('chat.abort');
  });

  it('translates an ExecApproval op into exec.approval.resolve', async () => {
    await completeHandshake();

    await transport.sendOp({ type: 'ExecApproval', id: 'a1', decision: 'reject', alternativeText: 'no' } as any);

    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent.method).toBe('exec.approval.resolve');
    expect(sent.params).toMatchObject({ id: 'a1', decision: 'reject', reason: 'no' });
  });

  it('passes a chat EventMsg payload through, with sessionId', async () => {
    await completeHandshake();

    const handler = vi.fn();
    transport.onEvent(handler);

    // The server sends the raw EventMsg as the event payload (the `event` name
    // is only a scope category); sessionId is merged into the payload.
    mockWs._message({
      type: 'event',
      event: 'chat',
      payload: { type: 'AgentMessageDelta', data: { delta: 'Hello' }, sessionId: 'sess-1' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toMatchObject({ type: 'AgentMessageDelta', data: { delta: 'Hello' } });
    expect(received.sessionId).toBe('sess-1');
  });

  it('passes an agent EventMsg payload through', async () => {
    await completeHandshake();

    const handler = vi.fn();
    transport.onEvent(handler);

    const msg = { type: 'ToolExecutionStart', data: { tool_name: 'dom', call_id: 'c1', params: { a: 1 } } };
    mockWs._message({ type: 'event', event: 'agent', payload: msg });

    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(msg);
  });

  it('ignores unknown and malformed messages', async () => {
    await completeHandshake();

    const handler = vi.fn();
    transport.onEvent(handler);

    mockWs._message({ type: 'other', payload: {} });
    mockWs._message({ type: 'event', event: 'tick', payload: { ts: 1 } }); // not EventMsg-shaped
    mockWs._message({ type: 'event', event: 'agent', payload: {} }); // no `type`
    mockWs.onmessage?.({ data: 'not-json{{{' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy closes WebSocket and clears listeners', async () => {
    await completeHandshake();

    transport.onEvent(vi.fn());
    await transport.destroy();

    expect(mockWs.close).toHaveBeenCalledTimes(1);
    await expect(transport.sendOp({ type: 'Interrupt' } as any)).rejects.toThrow(
      'WebSocket not connected',
    );
  });

  it('unlisten from onEvent works', async () => {
    await completeHandshake();

    const handler = vi.fn();
    const unlisten = transport.onEvent(handler);
    unlisten();

    mockWs._message({ type: 'event', event: 'chat', payload: { type: 'AgentMessageDelta', data: { delta: 'x' } } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler errors do not break dispatch loop', async () => {
    await completeHandshake();

    const errorHandler = vi.fn(() => { throw new Error('handler boom'); });
    const goodHandler = vi.fn();
    transport.onEvent(errorHandler);
    transport.onEvent(goodHandler);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWs._message({ type: 'event', event: 'chat', payload: { type: 'AgentMessageDelta', data: { delta: 'x' } } });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
