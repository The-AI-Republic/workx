/**
 * Thread Event Router
 *
 * Routes ChannelEvents to thread-specific or channel-level handlers
 * based on the event's scope classification and sessionId.
 *
 * @module webfront/routing/ThreadEventRouter
 */

import { getEventScope } from '@/core/protocol/event-scope';
import type { ChannelEvent } from '@/core/channels/types';

type ThreadEventHandler = (event: ChannelEvent) => void;
type ChannelEventHandler = (event: ChannelEvent) => void;

export class ThreadEventRouter {
  private activeSessionId: string | null = null;
  private activeThreadHandler: ThreadEventHandler | null = null;
  private backgroundThreadHandler: ThreadEventHandler | null = null;
  private channelHandler: ChannelEventHandler | null = null;

  setActiveSession(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  /**
   * Handler for events targeting the currently active/visible thread.
   */
  onActiveThread(handler: ThreadEventHandler): void {
    this.activeThreadHandler = handler;
  }

  /**
   * Handler for events targeting a background (non-visible) thread.
   * Typically buffers these for later display.
   */
  onBackgroundThread(handler: ThreadEventHandler): void {
    this.backgroundThreadHandler = handler;
  }

  /**
   * Handler for channel-level events (not tied to a thread).
   */
  onChannel(handler: ChannelEventHandler): void {
    this.channelHandler = handler;
  }

  /**
   * Route an incoming ChannelEvent to the appropriate handler.
   */
  route(channelEvent: ChannelEvent): void {
    const scope = getEventScope(channelEvent.msg.type);

    if (scope === 'channel') {
      this.channelHandler?.(channelEvent);
      return;
    }

    // Thread-scoped event
    const sessionId = channelEvent.sessionId;
    if (!sessionId) {
      console.warn(`[ThreadEventRouter] Thread event ${channelEvent.msg.type} missing sessionId, dropping`);
      return;
    }

    if (sessionId === this.activeSessionId) {
      this.activeThreadHandler?.(channelEvent);
    } else {
      this.backgroundThreadHandler?.(channelEvent);
    }
  }
}
