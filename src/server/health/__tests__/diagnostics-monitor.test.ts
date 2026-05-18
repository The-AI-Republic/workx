/**
 * DiagnosticsMonitor (Track 17) — verdict propagation + crash-safety.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildDoctorReport = vi.fn();
vi.mock('@/core/diagnostics', () => ({
  buildDoctorReport: (...a: unknown[]) => buildDoctorReport(...a),
}));

import { DiagnosticsMonitor } from '../diagnostics-monitor';
import {
  getHealthStatus,
  setHealthAgentStatus,
  setHealthDiagnostics,
} from '../../handlers/health';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('DiagnosticsMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHealthAgentStatus(true);
    setHealthDiagnostics('pass');
  });

  it('propagates the worst verdict into the health probe', async () => {
    buildDoctorReport.mockResolvedValue({ overall: 'fail' });
    const m = new DiagnosticsMonitor(() => ({ platformId: 'server' }));
    m.start();
    await tick();
    m.stop();
    expect(getHealthStatus().status).toBe('error');
  });

  it('never throws and keeps the last verdict if buildCtx throws', async () => {
    setHealthDiagnostics('pass');
    const m = new DiagnosticsMonitor(() => {
      throw new Error('ctx boom');
    });
    expect(() => m.start()).not.toThrow();
    await tick();
    m.stop();
    // verdict unchanged → ok (agent ready, pass)
    expect(getHealthStatus().status).toBe('ok');
    expect(buildDoctorReport).not.toHaveBeenCalled();
  });
});
