/**
 * Unit tests for SidePanelChannel and TabPageChannel
 *
 * Covers sessionId routing, Chrome message listener lifecycle,
 * and submission/event message handling for both channel adapters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SidePanelChannel } from '../SidePanelChannel';
import { TabPageChannel } from '../TabPageChannel';
import type { ChannelEvent } from '@/core/channels/types';
import type { Op } from '@/core/protocol/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the chrome mock from globalThis (installed by test setup) */
function getChrome() {
  return (globalThis as any).chrome;
}

/** Extract the message listener registered via chrome.runtime.onMessage.addListener */
function getLastListener(): (
  message: any,
  sender: any,
  sendResponse: (response?: any) => void,
) => boolean | undefined {
  const calls = getChrome().runtime.onMessage.addListener.mock.calls;
  return calls[calls.length - 1][0];
}

/** Create a minimal Op for testing */
function makeOp(): Op {
  return { type: 'user_turn', content: 'hello' } as unknown as Op;
}

/** Create a minimal ChannelEvent for testing */
function makeEvent(sessionId?: string): ChannelEvent {
  return {
    msg: { type: 'text_delta', delta: 'hi' } as any,
    sessionId,
  };
}

// ---------------------------------------------------------------------------
// SidePanelChannel
// ---------------------------------------------------------------------------

describe('SidePanelChannel', () => {
  let channel: SidePanelChannel;

  beforeEach(() => {
    // The global chrome mock is installed by src/__test-utils__/setup.ts
    // and reset by mockReset: true. Re-stub sendMessage to return a promise.
    getChrome().runtime.sendMessage.mockResolvedValue(undefined);

    // Ensure tabs.sendMessage is available (not in default setup)
    if (!getChrome().tabs.sendMessage) {
      getChrome().tabs.sendMessage = vi.fn().mockResolvedValue(undefined);
    }

    channel = new SidePanelChannel();
  });

  it('initialize adds chrome message listener', async () => {
    await channel.initialize();
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('initialize is idempotent (calling twice does not add duplicate listeners)', async () => {
    await channel.initialize();
    await channel.initialize();
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });

  it('sendEvent sends { type, event, sessionId } via chrome.runtime.sendMessage', async () => {
    await channel.initialize();
    const event = makeEvent('sess-1');
    await channel.sendEvent(event);

    expect(getChrome().runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(getChrome().runtime.sendMessage).toHaveBeenCalledWith({
      type: 'event',
      event: event.msg,
      sessionId: 'sess-1',
    });
  });

  it('sendEvent includes sessionId in the message', async () => {
    await channel.initialize();
    await channel.sendEvent(makeEvent('abc-123'));

    const sentMessage = getChrome().runtime.sendMessage.mock.calls[0][0];
    expect(sentMessage.sessionId).toBe('abc-123');
  });

  it('sendEvent without sessionId omits it', async () => {
    await channel.initialize();
    await channel.sendEvent(makeEvent(undefined));

    const sentMessage = getChrome().runtime.sendMessage.mock.calls[0][0];
    expect(sentMessage.sessionId).toBeUndefined();
  });

  it('submission handler receives sessionId from message', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    const listener = getLastListener();
    const sendResponse = vi.fn();
    const op = makeOp();

    listener(
      { type: 'submission', op, sessionId: 'sess-42', tabId: 10 },
      { tab: { id: 5 } },
      sendResponse,
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const context = handler.mock.calls[0][1];
    expect(context.sessionId).toBe('sess-42');
    expect(context.channelId).toBe('sidepanel-main');
    expect(context.channelType).toBe('sidepanel');
  });

  it('submission handler uses sender.tab.id as fallback tabId', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    const listener = getLastListener();
    const sendResponse = vi.fn();

    // No tabId in message, should fall back to sender.tab.id
    listener(
      { type: 'submission', op: makeOp() },
      { tab: { id: 99 } },
      sendResponse,
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const context = handler.mock.calls[0][1];
    expect(context.tabId).toBe(99);
  });

  it('ping message gets pong response', async () => {
    await channel.initialize();
    const listener = getLastListener();
    const sendResponse = vi.fn();

    const result = listener({ type: 'ping' }, {}, sendResponse);

    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'pong' });
  });

  it('non-matching messages return false', async () => {
    await channel.initialize();
    const listener = getLastListener();
    const sendResponse = vi.fn();

    const result = listener({ type: 'unknown-type' }, {}, sendResponse);

    expect(result).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('shutdown removes listener and clears handler', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    await channel.shutdown();

    expect(getChrome().runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
    expect(getChrome().runtime.onMessage.removeListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('shutdown is idempotent', async () => {
    await channel.initialize();
    await channel.shutdown();
    await channel.shutdown();

    expect(getChrome().runtime.onMessage.removeListener).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// TabPageChannel
// ---------------------------------------------------------------------------

describe('TabPageChannel', () => {
  const TAB_ID = 42;
  let channel: TabPageChannel;

  beforeEach(() => {
    // Re-stub sendMessage to return a promise after mockReset
    getChrome().runtime.sendMessage.mockResolvedValue(undefined);

    // Add tabs.sendMessage (not in the default test setup)
    getChrome().tabs.sendMessage = vi.fn().mockResolvedValue(undefined);

    channel = new TabPageChannel(TAB_ID);
  });

  it('constructor sets channelId from tabId', () => {
    expect(channel.channelId).toBe(`tabpage-${TAB_ID}`);
    expect(channel.channelType).toBe('tabpage');
  });

  it('initialize adds chrome message listener', async () => {
    await channel.initialize();
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(getChrome().runtime.onMessage.addListener).toHaveBeenCalledWith(expect.any(Function));
  });

  it('sendEvent sends to chrome.tabs.sendMessage with tabId and sessionId', async () => {
    await channel.initialize();
    const event = makeEvent('sess-7');
    await channel.sendEvent(event);

    expect(getChrome().tabs.sendMessage).toHaveBeenCalledTimes(1);
    expect(getChrome().tabs.sendMessage).toHaveBeenCalledWith(TAB_ID, {
      type: 'tabpage-event',
      tabId: TAB_ID,
      event: event.msg,
      sessionId: 'sess-7',
    });
  });

  it('only handles messages for its own tabId (via message.tabId)', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    const listener = getLastListener();
    const sendResponse = vi.fn();

    // Message with matching tabId
    const result = listener(
      { type: 'tabpage-submission', tabId: TAB_ID, op: makeOp(), sessionId: 'sess-1' },
      {},
      sendResponse,
    );

    expect(result).toBe(true);
    await vi.waitFor(() => expect(handler).toHaveBeenCalled());
  });

  it('ignores messages from other tabs', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    const listener = getLastListener();
    const sendResponse = vi.fn();

    // Message from a different tab
    const result = listener(
      { type: 'tabpage-submission', tabId: 999, op: makeOp() },
      { tab: { id: 888 } },
      sendResponse,
    );

    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tabpage-submission passes sessionId to submission context', async () => {
    await channel.initialize();
    const handler = vi.fn().mockResolvedValue(undefined);
    channel.onSubmission(handler);

    const listener = getLastListener();
    const sendResponse = vi.fn();

    listener(
      { type: 'tabpage-submission', tabId: TAB_ID, op: makeOp(), sessionId: 'sess-abc' },
      {},
      sendResponse,
    );

    await vi.waitFor(() => expect(handler).toHaveBeenCalled());

    const context = handler.mock.calls[0][1];
    expect(context.sessionId).toBe('sess-abc');
    expect(context.channelId).toBe(`tabpage-${TAB_ID}`);
    expect(context.channelType).toBe('tabpage');
    expect(context.tabId).toBe(TAB_ID);
  });

  it('tabpage-connect responds with channelId', async () => {
    await channel.initialize();
    const listener = getLastListener();
    const sendResponse = vi.fn();

    const result = listener(
      { type: 'tabpage-connect', tabId: TAB_ID },
      {},
      sendResponse,
    );

    expect(result).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      channelId: `tabpage-${TAB_ID}`,
    });
  });

  it('getTabId() returns the tab ID', () => {
    expect(channel.getTabId()).toBe(TAB_ID);
  });
});
