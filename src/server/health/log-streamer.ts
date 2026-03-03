/**
 * Structured Log Streamer
 *
 * Wraps console methods to produce structured JSON log entries
 * that are both printed to stdout and forwarded to logs.tail subscribers.
 *
 * @module server/health/log-streamer
 */

import { emitLog, type LogLevel } from '../handlers/logs';

/**
 * Install structured logging.
 * Wraps console.log/warn/error to emit structured entries.
 */
export function installStructuredLogging(): void {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origDebug = console.debug;

  console.log = (...args: unknown[]) => {
    origLog(...args);
    emitLog('info', formatArgs(args));
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    emitLog('warn', formatArgs(args));
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    emitLog('error', formatArgs(args));
  };

  console.debug = (...args: unknown[]) => {
    origDebug(...args);
    emitLog('debug', formatArgs(args));
  };
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}
