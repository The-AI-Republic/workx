/**
 * Diagnostics Service Handlers (Track 17)
 *
 * Platform-agnostic `diagnostics.*` service handlers. Auto-registered on
 * extension, desktop, and server by `registerAllServices`. Distinct from the
 * `@workx/ws-server` `health` method — that stays a status probe; this
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
  /** Server-only: capture a heap dump. Injected by the server bootstrap so
   *  `core/` never imports node `v8`/`fs`; absent ⇒ the handler is not
   *  registered (extension/desktop). */
  heapdump?: () => Promise<{
    success: boolean;
    heapPath?: string;
    diagPath?: string;
    error?: string;
  }>;
}

export function createDiagnosticsServices(
  deps: DiagnosticsServiceDeps,
): Record<string, ServiceHandler> {
  // Idempotent (guarded). Co-located with service wiring so a platform can
  // never register the service without its checks.
  registerCoreDiagnosticChecks();

  const handlers: Record<string, ServiceHandler> = {
    'diagnostics.report': async () => {
      const ctx = await deps.buildCtx();
      return redactDoctorReport(await buildDoctorReport(ctx));
    },
  };

  if (deps.heapdump) {
    const heapdump = deps.heapdump;
    handlers['diagnostics.heapdump'] = async () => heapdump();
  }

  return handlers;
}
