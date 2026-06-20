/**
 * Health Method Handler
 *
 * Handles `health` method and provides the HTTP GET /health endpoint data.
 *
 * @module server/handlers/health
 */

import { registerMethodHandler, type MethodContext } from '@workx/ws-server';
import { getConnectionCount } from '../connection/watchdog';
import type { DiagnosticStatus } from '@/core/diagnostics';

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
let _channels: Record<string, 'connected' | 'disconnected' | 'reconnecting'> = {};
let _activeSessions = 0;
let _totalSessions = 0;
// Worst diagnostic verdict from the periodic DiagnosticsMonitor (Track 17).
// Defaults to 'pass' so that, before the first diagnostic refresh, `status`
// behaves exactly as it did historically (derived from `_agentReady` alone).
let _diagnostics: DiagnosticStatus = 'pass';

export function setHealthAgentStatus(ready: boolean, model?: string): void {
  _agentReady = ready;
  _agentModel = model;
}

export function setHealthAgentTools(tools: string[]): void {
  _agentTools = tools;
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

/**
 * Set the aggregate diagnostic verdict (Track 17). Called by the
 * `DiagnosticsMonitor` on each refresh so `GET /health` / the `health`
 * method report a *truthful* `status` for K8s/Docker probes.
 */
export function setHealthDiagnostics(verdict: DiagnosticStatus): void {
  _diagnostics = verdict;
}

const SERVER_VERSION = '1.0.0';

/**
 * Build current health status.
 */
export function getHealthStatus(): HealthStatus {
  const connections = getConnectionCount();
  const memUsage = process.memoryUsage();

  // Shape-compatible upgrade (Track 17): same 3-value enum, but the value is
  // now accurate. A critical check failure depools/restarts the container; a
  // warn or a not-ready agent is degraded.
  const status: HealthStatus['status'] =
    _diagnostics === 'fail'
      ? 'error'
      : !_agentReady || _diagnostics === 'warn'
        ? 'degraded'
        : 'ok';

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
      // Always 0: never tracked. Kept for HealthStatus shape back-compat
      // (the previous setter had zero callers — dead — and was removed).
      activeRuns: 0,
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
