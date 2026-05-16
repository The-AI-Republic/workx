/**
 * Diagnostics Service Handlers (Track 17)
 *
 * Platform-agnostic `diagnostics.*` service handlers. Auto-registered on
 * extension, desktop, and server by `registerAllServices`. Distinct from the
 * `@applepi/ws-server` `health` method — that stays a status probe; this
 * serves the full (redacted) `DoctorReport` to authenticated callers.
 *
 * @module core/services/diagnostics-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import type { DiagnosticContext } from '@/core/diagnostics';
import {
  buildDoctorReport,
  redactDoctorReport,
  registerCoreDiagnosticChecks,
} from '@/core/diagnostics';

export interface DiagnosticsServiceDeps {
  /** Assembles the platform's diagnostic context. May be async (e.g. the
   *  server resolves the MCP manager singleton lazily). */
  buildCtx: () => DiagnosticContext | Promise<DiagnosticContext>;
}

export function createDiagnosticsServices(
  deps: DiagnosticsServiceDeps,
): Record<string, ServiceHandler> {
  // Idempotent (guarded). Co-located with service wiring so a platform can
  // never register the service without its checks.
  registerCoreDiagnosticChecks();

  return {
    'diagnostics.report': async () => {
      const ctx = await deps.buildCtx();
      return redactDoctorReport(await buildDoctorReport(ctx));
    },
  };
}
