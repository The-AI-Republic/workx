/**
 * Transport implementations unit tests
 *
 * Tests sessionId routing and event dispatch for all three transports:
 * ChromeExtensionTransport, TauriTransport, WebSocketTransport
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelEvent } from '@/core/channels/types';

// ---------------------------------------------------------------------------
// Tauri mock
// ---------------------------------------------------------------------------
const mockTauriListen = vi.fn();
const mockTauriEmit = vi.fn().mockResolvedValue(undefined);

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockTauriListen,
  emit: mockTauriEmit,
}));

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
import { TauriTransport } from '../TauriTransport';
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
// TauriTransport
// =========================================================================
describe('TauriTransport', () => {
  let transport: TauriTransport;
  let capturedTauriCallback: (event: { payload: unknown }) => void;

  beforeEach(() => {
    transport = new TauriTransport();

    const mockUnlisten = vi.fn();
    mockTauriListen.mockImplementation(
      (_eventName: string, cb: (event: { payload: unknown }) => void) => {
        capturedTauriCallback = cb;
        return Promise.resolve(mockUnlisten);
      },
    );
    mockTauriEmit.mockResolvedValue(undefined);
  });

  it('sendOp throws when not initialized', async () => {
    await expect(transport.sendOp({ type: 'response.create' } as any)).rejects.toThrow(
      'TauriTransport not initialized',
    );
  });

  it('sendOp emits pi:submit with op and context', async () => {
    await transport.initialize();
    const op = { type: 'conversation.item.create' } as any;
    const context = { sessionId: 'sess-2' };
    await transport.sendOp(op, context);

    expect(mockTauriEmit).toHaveBeenCalledWith('pi:submit', { op, context });
  });

  it('initialize sets up pi:event listener', async () => {
    await transport.initialize();
    expect(mockTauriListen).toHaveBeenCalledWith('pi:event', expect.any(Function));
  });

  it('events with { msg, sessionId } envelope are dispatched correctly', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const eventMsg = fakeEventMsg();
    capturedTauriCallback({ payload: { msg: eventMsg, sessionId: 'sess-3' } });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(eventMsg);
    expect(received.sessionId).toBe('sess-3');
  });

  it('bare EventMsg (legacy) is wrapped in ChannelEvent', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const eventMsg = fakeEventMsg();
    capturedTauriCallback({ payload: eventMsg });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(eventMsg);
    expect(received.sessionId).toBeUndefined();
  });

  it('invalid payloads are ignored', async () => {
    await transport.initialize();
    const handler = vi.fn();
    transport.onEvent(handler);

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    capturedTauriCallback({ payload: null });
    capturedTauriCallback({ payload: 'string-payload' });
    capturedTauriCallback({ payload: { noMsgOrType: true } });

    expect(handler).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });

  it('destroy cleans up listener', async () => {
    await transport.initialize();
    transport.onEvent(vi.fn());
    await transport.destroy();

    await expect(transport.sendOp({ type: 'response.create' } as any)).rejects.toThrow(
      'TauriTransport not initialized',
    );
  });

  it('unlisten from onEvent works', async () => {
    await transport.initialize();
    const handler = vi.fn();
    const unlisten = transport.onEvent(handler);
    unlisten();

    capturedTauriCallback({ payload: { msg: fakeEventMsg(), sessionId: 's' } });
    expect(handler).not.toHaveBeenCalled();
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

  it('sendOp throws when not connected', async () => {
    await expect(transport.sendOp({ type: 'response.create' } as any)).rejects.toThrow(
      'WebSocket not connected',
    );
  });

  it('sendOp sends JSON message over WebSocket', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    const op = { type: 'conversation.item.create' } as any;
    const context = { sessionId: 'sess-4' };
    await transport.sendOp(op, context);

    expect(mockWs.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(mockWs.send.mock.calls[0][0]);
    expect(sent).toEqual({
      type: 'req',
      method: 'chat.send',
      params: { op, sessionId: 'sess-4' },
    });
  });

  it('initialize connects to WebSocket', async () => {
    const initPromise = transport.initialize();
    expect(mockWs.url).toBe('ws://localhost:8080');
    mockWs._open();
    await initPromise;
  });

  it('events with sessionId in payload are dispatched correctly', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    const handler = vi.fn();
    transport.onEvent(handler);

    const eventMsg = fakeEventMsg();
    mockWs._message({ type: 'event', payload: { msg: eventMsg, sessionId: 'sess-5' } });

    expect(handler).toHaveBeenCalledTimes(1);
    const received: ChannelEvent = handler.mock.calls[0][0];
    expect(received.msg).toEqual(eventMsg);
    expect(received.sessionId).toBe('sess-5');
  });

  it('malformed messages are ignored', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    const handler = vi.fn();
    transport.onEvent(handler);

    mockWs._message({ type: 'other', payload: {} });
    mockWs._message({ type: 'event', payload: {} });
    mockWs.onmessage?.({ data: 'not-json{{{' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('destroy closes WebSocket and clears listeners', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    transport.onEvent(vi.fn());
    await transport.destroy();

    expect(mockWs.close).toHaveBeenCalledTimes(1);
    await expect(transport.sendOp({ type: 'response.create' } as any)).rejects.toThrow(
      'WebSocket not connected',
    );
  });

  it('unlisten from onEvent works', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    const handler = vi.fn();
    const unlisten = transport.onEvent(handler);
    unlisten();

    mockWs._message({ type: 'event', payload: { msg: fakeEventMsg(), sessionId: 'x' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('handler errors do not break dispatch loop', async () => {
    const initPromise = transport.initialize();
    mockWs._open();
    await initPromise;

    const errorHandler = vi.fn(() => { throw new Error('handler boom'); });
    const goodHandler = vi.fn();
    transport.onEvent(errorHandler);
    transport.onEvent(goodHandler);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockWs._message({ type: 'event', payload: { msg: fakeEventMsg(), sessionId: 'err-test' } });

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
