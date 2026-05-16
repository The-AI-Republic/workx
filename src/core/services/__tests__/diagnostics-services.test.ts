/**
 * diagnostics.report service — redaction at the emission boundary (Track 17).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDiagnosticsServices } from '../diagnostics-services';
import {
  clearDiagnosticChecks,
  registerDiagnosticCheck,
} from '@/core/diagnostics';
import type { SubmissionContext } from '@/core/channels/types';

describe('createDiagnosticsServices', () => {
  beforeEach(() => clearDiagnosticChecks());

  it('diagnostics.report returns a redacted DoctorReport', async () => {
    // The factory registers the core checks (idempotent); clear them so this
    // test is hermetic, then add one leaking check.
    const handlers = createDiagnosticsServices({
      buildCtx: () => ({ platformId: 'server' }),
    });
    clearDiagnosticChecks();
    registerDiagnosticCheck({
      id: 'leak',
      title: 'leak',
      platforms: ['server'],
      run: async () => ({
        id: 'leak',
        title: 'leak',
        status: 'fail',
        detail: 'leaked key sk-abcdefABCDEF1234567890 here',
        data: { token: 'deadbeefdeadbeef' },
      }),
    });

    const report = (await handlers['diagnostics.report'](
      {},
      {} as SubmissionContext,
    )) as {
      overall: string;
      checks: Array<{ id: string; detail: string; data?: Record<string, unknown> }>;
    };

    const leak = report.checks.find((c) => c.id === 'leak')!;
    expect(leak.detail).not.toMatch(/sk-abcdefABCDEF1234567890/);
    expect(leak.detail).toMatch(/\*\*\*/);
    expect(leak.data?.token).toBe('***');
    expect(report.overall).toBe('fail');
  });
});
