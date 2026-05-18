/**
 * Diagnostics Monitor (Track 17)
 *
 * Periodically runs the diagnostic registry and pushes the worst verdict into
 * the health subsystem, so the synchronous `GET /health` probe stays O(1)
 * while reporting a *truthful* status. Mirrors `HealthMonitor`'s lifecycle
 * (idempotent start, swallow-and-log refresh, never throws).
 *
 * @module server/health/diagnostics-monitor
 */

import { buildDoctorReport, type DiagnosticContext } from '@/core/diagnostics';
import { setHealthDiagnostics } from '../handlers/health';

const DIAGNOSTICS_CHECK_INTERVAL_MS = 30_000;

export class DiagnosticsMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly buildCtx: () =>
      | DiagnosticContext
      | Promise<DiagnosticContext>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh();
    }, DIAGNOSTICS_CHECK_INTERVAL_MS);
    void this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(): Promise<void> {
    try {
      const ctx = await this.buildCtx();
      const report = await buildDoctorReport(ctx);
      setHealthDiagnostics(report.overall);
    } catch (err) {
      // Keep the last verdict; never flip to a false alarm on monitor error.
      console.error('[DiagnosticsMonitor] Refresh error:', err);
    }
  }
}
