/**
 * Health Monitor
 *
 * Periodically refreshes health status and broadcasts to subscribers.
 *
 * @module server/health/health-monitor
 */

import { getHealthStatus, setHealthChannels, type HealthStatus } from '../handlers/health';
import { getChannelManager } from '@/core/channels/ChannelManager';
import { makeEvent } from '../protocol/frames';
import { getTrackedConnections } from '../connection/watchdog';
import { shouldReceiveEvent } from '../auth/authorize';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const HEALTH_CHECK_INTERVAL_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────
// Monitor
// ─────────────────────────────────────────────────────────────────────────

export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start periodic health checks.
   */
  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.refresh();
    }, HEALTH_CHECK_INTERVAL_MS);

    // Initial refresh
    this.refresh();
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Refresh health status and broadcast to subscribers.
   */
  private refresh(): void {
    try {
      // Update channel health info as Record<string, state>
      const channelManager = getChannelManager();
      const channelEntries: Record<string, 'connected' | 'disconnected' | 'reconnecting'> = {};
      for (const ch of channelManager.getChannelInfo()) {
        channelEntries[ch.channelId] = 'connected';
      }
      setHealthChannels(channelEntries);

      // Broadcast health event to admin connections
      const status = getHealthStatus();
      const frame = JSON.stringify(makeEvent('health', status));

      for (const conn of getTrackedConnections()) {
        if (!conn.authenticated) continue;
        if (!shouldReceiveEvent(conn.connectionId, 'health')) continue;

        try {
          conn.ws.send(frame);
        } catch {
          // Connection may be closed
        }
      }
    } catch (err) {
      console.error('[HealthMonitor] Refresh error:', err);
    }
  }
}
