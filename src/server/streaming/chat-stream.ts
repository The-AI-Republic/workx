/**
 * Chat Stream
 *
 * Constructs ChatEvent frames from agent EventMsg, applies delta throttling
 * (150ms buffer), and manages the run state machine.
 *
 * @module server/streaming/chat-stream
 */

import type { EventMsg } from '@/core/protocol/events';
import { makeEvent, type EventFrame } from '@applepi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const DELTA_THROTTLE_MS = 150;

// ─────────────────────────────────────────────────────────────────────────
// Run state machine
// ─────────────────────────────────────────────────────────────────────────

export type RunState = 'idle' | 'started' | 'streaming' | 'final' | 'aborted' | 'error';

export interface ChatStream {
  runId: string;
  state: RunState;
  sessionKey: string;
  seq: number;
}

const _activeStreams = new Map<string, ChatStream>();

/**
 * Start a new chat stream for a run.
 */
export function startChatStream(runId: string, sessionKey: string): ChatStream {
  const stream: ChatStream = {
    runId,
    state: 'started',
    sessionKey,
    seq: 0,
  };
  _activeStreams.set(runId, stream);
  return stream;
}

/**
 * Get an active chat stream.
 */
export function getChatStream(runId: string): ChatStream | undefined {
  return _activeStreams.get(runId);
}

/**
 * End a chat stream.
 */
export function endChatStream(runId: string): void {
  _activeStreams.delete(runId);
}

// ─────────────────────────────────────────────────────────────────────────
// Delta throttling
// ─────────────────────────────────────────────────────────────────────────

interface ThrottleState {
  buffer: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
}

const _throttles = new Map<string, ThrottleState>();

/**
 * Buffer a delta and flush at most every DELTA_THROTTLE_MS.
 *
 * @returns EventFrame to send immediately, or null if buffered
 */
export function throttleDelta(
  runId: string,
  delta: string,
  flushCallback: (frame: EventFrame) => void
): void {
  let state = _throttles.get(runId);
  if (!state) {
    state = { buffer: '', timer: null, lastFlush: 0 };
    _throttles.set(runId, state);
  }

  state.buffer += delta;

  const now = Date.now();
  const elapsed = now - state.lastFlush;

  if (elapsed >= DELTA_THROTTLE_MS) {
    // Flush immediately
    flushDelta(runId, state, flushCallback);
  } else if (!state.timer) {
    // Schedule flush
    state.timer = setTimeout(() => {
      const s = _throttles.get(runId);
      if (s) {
        flushDelta(runId, s, flushCallback);
      }
    }, DELTA_THROTTLE_MS - elapsed);
  }
}

function flushDelta(
  runId: string,
  state: ThrottleState,
  flushCallback: (frame: EventFrame) => void
): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }

  if (state.buffer.length === 0) return;

  const stream = _activeStreams.get(runId);
  if (stream) {
    stream.seq++;
    stream.state = 'streaming';
  }

  const frame = makeEvent('chat', {
    state: 'delta',
    runId,
    delta: state.buffer,
  }, stream?.seq);

  state.buffer = '';
  state.lastFlush = Date.now();

  flushCallback(frame);
}

/**
 * Flush any remaining buffered delta for a run (e.g., on completion).
 */
export function flushRemainingDelta(
  runId: string,
  flushCallback: (frame: EventFrame) => void
): void {
  const state = _throttles.get(runId);
  if (state) {
    flushDelta(runId, state, flushCallback);
    _throttles.delete(runId);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// EventMsg → chat event conversion
// ─────────────────────────────────────────────────────────────────────────

/**
 * Convert a RepublicAgent EventMsg to a chat wire event.
 * Returns null if the event is not a chat-related event.
 */
export function toChatEvent(
  runId: string,
  event: EventMsg
): { state: string; payload: unknown } | null {
  switch (event.type) {
    case 'TaskStarted':
      return { state: 'started', payload: { runId, model: event.data.model } };

    case 'AgentMessage':
      return { state: 'final', payload: { runId, message: event.data.message } };

    case 'AgentMessageDelta':
      // Deltas are handled by throttleDelta, not returned here
      return null;

    case 'TaskComplete':
      return {
        state: 'final',
        payload: {
          runId,
          lastMessage: event.data.last_agent_message,
          tokenUsage: event.data.token_usage,
        },
      };

    case 'TurnAborted':
      return { state: 'aborted', payload: { runId, reason: event.data.reason } };

    case 'Error':
      return { state: 'error', payload: { runId, error: event.data.message } };

    case 'StreamError':
      return { state: 'error', payload: { runId, error: event.data.error, retrying: event.data.retrying } };

    default:
      return null;
  }
}
