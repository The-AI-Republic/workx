/**
 * Graceful Shutdown
 *
 * Orchestrates the shutdown sequence:
 *   1. Stop connectors
 *   2. Drain active runs
 *   3. Flush writes
 *   4. Close WebSocket connections
 *   5. Exit
 *
 * @module server/agent/shutdown
 */

import { getServerConfig } from '../config/server-config';
import { getServerAgentBootstrap } from './ServerAgentBootstrap';
import { getTrackedConnections, shutdownWatchdog } from '../connection/watchdog';
import { resetAllRateLimits } from '../connection/rate-limiter';
import { makeEvent } from '@workx/ws-server';
import { WS_CLOSE } from '@workx/ws-server';

let _shutdownInProgress = false;

/**
 * Initiate graceful shutdown.
 */
export async function gracefulShutdown(reason: string = 'shutdown'): Promise<void> {
  if (_shutdownInProgress) {
    console.log('[Shutdown] Already in progress');
    return;
  }
  _shutdownInProgress = true;

  const config = getServerConfig();
  const gracePeriodMs = config.server.shutdownGracePeriodMs;

  console.log(`[Shutdown] Starting graceful shutdown (reason: ${reason}, grace: ${gracePeriodMs}ms)`);

  // 1. Broadcast shutdown event to all connected clients
  const shutdownFrame = JSON.stringify(makeEvent('shutdown', { reason }));
  const connections = getTrackedConnections();
  for (const conn of connections) {
    try {
      conn.ws.send(shutdownFrame);
    } catch {
      // Ignore — connection may already be closed
    }
  }

  // 2. Stop accepting new connections (server.close() called by caller)

  // 3. Wait for grace period to drain active runs
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(gracePeriodMs, 10_000));
  });

  // 4. Shutdown the agent bootstrap (connectors, persistence, agent)
  const bootstrap = getServerAgentBootstrap();
  await bootstrap.shutdown();

  // 5. Close all WebSocket connections
  for (const conn of getTrackedConnections()) {
    try {
      conn.ws.close(WS_CLOSE.SERVICE_RESTART, reason);
    } catch {
      // Already closed
    }
  }

  // 6. Cleanup watchdog and rate limiter state
  shutdownWatchdog();
  resetAllRateLimits();

  console.log('[Shutdown] Graceful shutdown complete');
}

/**
 * Register process signal handlers for graceful shutdown.
 */
export function registerShutdownHandlers(
  onShutdownComplete?: () => void
): void {
  const handler = async (signal: string) => {
    console.log(`[Shutdown] Received ${signal}`);
    await gracefulShutdown(signal);
    onShutdownComplete?.();
    process.exit(0);
  };

  process.on('SIGTERM', () => handler('SIGTERM'));
  process.on('SIGINT', () => handler('SIGINT'));
}
