/**
 * Health status derivation upgrade (Track 17).
 *
 * Verifies the shape-compatible enum is now *truthful* and back-compat keys
 * are unchanged.
 */

import { describe, it, expect } from 'vitest';
import {
  getHealthStatus,
  setHealthDiagnostics,
  setHealthAgentStatus,
} from '../health';

describe('health status derivation (Track 17)', () => {
  it("fail verdict → 'error' (depool/restart signal)", () => {
    setHealthAgentStatus(true);
    setHealthDiagnostics('fail');
    expect(getHealthStatus().status).toBe('error');
  });

  it("warn verdict → 'degraded' even when agent ready", () => {
    setHealthAgentStatus(true);
    setHealthDiagnostics('warn');
    expect(getHealthStatus().status).toBe('degraded');
  });

  it("pass + agent ready → 'ok'", () => {
    setHealthAgentStatus(true);
    setHealthDiagnostics('pass');
    expect(getHealthStatus().status).toBe('ok');
  });

  it("pass + agent NOT ready → 'degraded'", () => {
    setHealthAgentStatus(false);
    setHealthDiagnostics('pass');
    expect(getHealthStatus().status).toBe('degraded');
  });

  it('HealthStatus shape is unchanged (back-compat)', () => {
    setHealthAgentStatus(true);
    setHealthDiagnostics('pass');
    const s = getHealthStatus();
    for (const key of [
      'status',
      'uptime',
      'version',
      'connections',
      'sessions',
      'channels',
      'agent',
      'memory',
      'timestamp',
    ]) {
      expect(s).toHaveProperty(key);
    }
    expect(['ok', 'degraded', 'error']).toContain(s.status);
  });
});
