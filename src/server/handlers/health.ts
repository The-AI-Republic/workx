/**
 * Health Method Handler
 *
 * Handles `health` method and provides the HTTP GET /health endpoint data.
 *
 * @module server/handlers/health
 */

import { registerMethodHandler, type MethodContext } from '../protocol/methods';
import { getConnectionCount } from '../connection/watchdog';

// ─────────────────────────────────────────────────────────────────────────
// Health status
// ─────────────────────────────────────────────────────────────────────────

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  connections: number;
  agent: {
    ready: boolean;
    model?: string;
  };
  channels: Array<{
    id: string;
    type: string;
    state: string;
  }>;
  timestamp: number;
}

let _startTime = Date.now();
let _agentReady = false;
let _agentModel: string | undefined;
let _channels: HealthStatus['channels'] = [];

export function setHealthAgentStatus(ready: boolean, model?: string): void {
  _agentReady = ready;
  _agentModel = model;
}

export function setHealthChannels(channels: HealthStatus['channels']): void {
  _channels = channels;
}

export function resetHealthStartTime(): void {
  _startTime = Date.now();
}

/**
 * Build current health status.
 */
export function getHealthStatus(): HealthStatus {
  const connections = getConnectionCount();
  const status = _agentReady
    ? connections > 0
      ? 'healthy'
      : 'healthy'
    : 'degraded';

  return {
    status,
    uptime: Date.now() - _startTime,
    connections,
    agent: {
      ready: _agentReady,
      model: _agentModel,
    },
    channels: _channels,
    timestamp: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Method handler
// ─────────────────────────────────────────────────────────────────────────

export function registerHealthHandlers(): void {
  registerMethodHandler('health', handleHealth);
}

async function handleHealth(
  _params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  return getHealthStatus();
}
