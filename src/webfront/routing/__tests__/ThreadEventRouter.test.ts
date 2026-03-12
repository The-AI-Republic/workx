import { describe, it, expect, vi } from 'vitest';
import { ThreadEventRouter } from '../ThreadEventRouter';
import type { ChannelEvent } from '@/core/channels/types';

function makeChannelEvent(type: string, sessionId?: string): ChannelEvent {
  return {
    msg: { type, data: { test: true } } as any,
    sessionId,
  };
}

describe('ThreadEventRouter', () => {
  it('routes thread-scoped events to active thread handler', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();
    const bgHandler = vi.fn();
    const channelHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);
    router.onBackgroundThread(bgHandler);
    router.onChannel(channelHandler);

    router.route(makeChannelEvent('AgentMessageDelta', 'session-a'));

    expect(activeHandler).toHaveBeenCalledOnce();
    expect(bgHandler).not.toHaveBeenCalled();
    expect(channelHandler).not.toHaveBeenCalled();
  });

  it('routes thread-scoped events to background handler for non-active session', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();
    const bgHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);
    router.onBackgroundThread(bgHandler);

    router.route(makeChannelEvent('AgentMessageDelta', 'session-b'));

    expect(activeHandler).not.toHaveBeenCalled();
    expect(bgHandler).toHaveBeenCalledOnce();
  });

  it('routes channel-scoped events to channel handler', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();
    const channelHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);
    router.onChannel(channelHandler);

    router.route(makeChannelEvent('BackgroundEvent', 'session-a'));

    expect(channelHandler).toHaveBeenCalledOnce();
    expect(activeHandler).not.toHaveBeenCalled();
  });

  it('routes channel-scoped events without sessionId to channel handler', () => {
    const router = new ThreadEventRouter();
    const channelHandler = vi.fn();

    router.onChannel(channelHandler);

    router.route(makeChannelEvent('StateUpdate'));

    expect(channelHandler).toHaveBeenCalledOnce();
  });

  it('drops thread-scoped events without sessionId', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();
    const bgHandler = vi.fn();
    const channelHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);
    router.onBackgroundThread(bgHandler);
    router.onChannel(channelHandler);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    router.route(makeChannelEvent('AgentMessageDelta'));
    warn.mockRestore();

    expect(activeHandler).not.toHaveBeenCalled();
    expect(bgHandler).not.toHaveBeenCalled();
    expect(channelHandler).not.toHaveBeenCalled();
  });

  it('updates routing when active session changes', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();
    const bgHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);
    router.onBackgroundThread(bgHandler);

    router.route(makeChannelEvent('TaskStarted', 'session-b'));
    expect(bgHandler).toHaveBeenCalledOnce();
    expect(activeHandler).not.toHaveBeenCalled();

    // Switch active session
    router.setActiveSession('session-b');

    router.route(makeChannelEvent('TaskComplete', 'session-b'));
    expect(activeHandler).toHaveBeenCalledOnce();
  });

  it('defaults unknown event types to channel scope', () => {
    const router = new ThreadEventRouter();
    const channelHandler = vi.fn();
    const activeHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onChannel(channelHandler);
    router.onActiveThread(activeHandler);

    router.route(makeChannelEvent('SomeUnknownEventType', 'session-a'));

    expect(channelHandler).toHaveBeenCalledOnce();
    expect(activeHandler).not.toHaveBeenCalled();
  });

  it('passes full ChannelEvent to handlers', () => {
    const router = new ThreadEventRouter();
    const activeHandler = vi.fn();

    router.setActiveSession('session-a');
    router.onActiveThread(activeHandler);

    const event = makeChannelEvent('AgentMessage', 'session-a');
    router.route(event);

    expect(activeHandler).toHaveBeenCalledWith(event);
    expect(activeHandler.mock.calls[0][0].sessionId).toBe('session-a');
    expect(activeHandler.mock.calls[0][0].msg.type).toBe('AgentMessage');
  });
});
