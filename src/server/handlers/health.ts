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
  status: 'ok' | 'degraded' | 'error';
  uptime: number;
  version: string;
  connections: number;
  sessions: {
    active: number;
    total: number;
  };
  channels: Record<string, 'connected' | 'disconnected' | 'reconnecting'>;
  agent: {
    ready: boolean;
    activeRuns: number;
    tools: string[];
    model?: string;
  };
  memory: {
    heapUsedMB: number;
    rss: number;
  };
  timestamp: number;
}

let _startTime = Date.now();
let _agentReady = false;
let _agentModel: string | undefined;
let _agentTools: string[] = [];
let _activeRuns = 0;
let _channels: Record<string, 'connected' | 'disconnected' | 'reconnecting'> = {};
let _activeSessions = 0;
let _totalSessions = 0;

export function setHealthAgentStatus(ready: boolean, model?: string): void {
  _agentReady = ready;
  _agentModel = model;
}

export function setHealthAgentTools(tools: string[]): void {
  _agentTools = tools;
}

export function setHealthActiveRuns(count: number): void {
  _activeRuns = count;
}

export function setHealthChannels(channels: Record<string, 'connected' | 'disconnected' | 'reconnecting'>): void {
  _channels = channels;
}

export function setHealthSessionCounts(active: number, total: number): void {
  _activeSessions = active;
  _totalSessions = total;
}

export function resetHealthStartTime(): void {
  _startTime = Date.now();
}

const SERVER_VERSION = '1.0.0';

/**
 * Build current health status.
 */
export function getHealthStatus(): HealthStatus {
  const connections = getConnectionCount();
  const memUsage = process.memoryUsage();

  const status: HealthStatus['status'] = _agentReady
    ? 'ok'
    : 'degraded';

  return {
    status,
    uptime: Math.floor((Date.now() - _startTime) / 1000),
    version: SERVER_VERSION,
    connections,
    sessions: {
      active: _activeSessions,
      total: _totalSessions,
    },
    channels: _channels,
    agent: {
      ready: _agentReady,
      activeRuns: _activeRuns,
      tools: _agentTools,
      model: _agentModel,
    },
    memory: {
      heapUsedMB: Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100,
      rss: memUsage.rss,
    },
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
