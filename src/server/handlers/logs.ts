/**
 * Logs Method Handler
 *
 * Handles logs.tail — streams structured JSON log lines to the client.
 *
 * @module server/handlers/logs
 */

import { registerMethodHandler, type MethodContext } from '@pi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Log level
// ─────────────────────────────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ─────────────────────────────────────────────────────────────────────────
// Log subscribers
// ─────────────────────────────────────────────────────────────────────────

interface LogSubscriber {
  connectionId: string;
  minLevel: LogLevel;
  sendEvent: (event: string, payload?: unknown) => void;
}

const _subscribers: Map<string, LogSubscriber> = new Map();

/**
 * Emit a log entry to all subscribers with sufficient level.
 */
export function emitLog(level: LogLevel, message: string, data?: unknown): void {
  const entry = {
    level,
    message,
    data,
    timestamp: Date.now(),
  };

  const levelOrder = LOG_LEVEL_ORDER[level];
  for (const sub of _subscribers.values()) {
    if (LOG_LEVEL_ORDER[sub.minLevel] <= levelOrder) {
      try {
        sub.sendEvent('log', entry);
      } catch {
        // Subscriber may have disconnected
      }
    }
  }
}

/**
 * Remove a log subscriber (on disconnect).
 */
export function removeLogSubscriber(connectionId: string): void {
  _subscribers.delete(connectionId);
}

// ─────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────

export function registerLogsHandlers(): void {
  registerMethodHandler('logs.tail', handleLogsTail);
}

async function handleLogsTail(
  params: Record<string, unknown> | undefined,
  ctx: MethodContext
): Promise<unknown> {
  const minLevel = (params?.level as LogLevel) ?? 'info';

  // Register this connection as a log subscriber
  _subscribers.set(ctx.connectionId, {
    connectionId: ctx.connectionId,
    minLevel,
    sendEvent: ctx.sendEvent,
  });

  return { status: 'streaming', level: minLevel };
}
