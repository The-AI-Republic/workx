/**
 * Diagnostic check registry + report aggregator (Track 17).
 *
 * Module-singleton registry (same pattern as `@workx/ws-server`'s method
 * map and the other `core/*` registries). `buildDoctorReport` filters checks
 * by the runtime `platformId`, runs each under a hard per-check timeout with
 * full isolation (one throwing/hung check cannot break the report), and rolls
 * the results up to a worst-severity verdict.
 *
 * @module core/diagnostics/DiagnosticRegistry
 */

import type {
  DiagnosticCheck,
  DiagnosticContext,
  DiagnosticResult,
  DiagnosticStatus,
  DoctorReport,
} from './types';
import { withTimeout } from './withTimeout';

const PER_CHECK_TIMEOUT_MS = 3000;

const _checks = new Map<string, DiagnosticCheck>();

export function registerDiagnosticCheck(check: DiagnosticCheck): void {
  _checks.set(check.id, check);
}

export function getDiagnosticChecks(): DiagnosticCheck[] {
  return [..._checks.values()];
}

/** Test seam — drop all registered checks. */
export function clearDiagnosticChecks(): void {
  _checks.clear();
}

function rollup(results: DiagnosticResult[]): DiagnosticStatus {
  if (results.some((r) => r.status === 'fail')) return 'fail';
  if (results.some((r) => r.status === 'warn')) return 'warn';
  return 'pass';
}

export async function buildDoctorReport(
  ctx: DiagnosticContext,
): Promise<DoctorReport> {
  const start = Date.now();
  const applicable = getDiagnosticChecks().filter((c) =>
    c.platforms.includes(ctx.platformId),
  );

  const checks = await Promise.all(
    applicable.map(async (check): Promise<DiagnosticResult> => {
      try {
        return await withTimeout(
          check.run(ctx),
          PER_CHECK_TIMEOUT_MS,
          check.id,
        );
      } catch (err) {
        return {
          id: check.id,
          title: check.title,
          status: 'fail',
          detail: `check threw: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }),
  );

  return {
    overall: rollup(checks),
    platformId: ctx.platformId,
    generatedAt: Date.now(),
    durationMs: Date.now() - start,
    checks,
  };
}
