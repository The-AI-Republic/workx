/**
 * DiagnosticRegistry + withTimeout unit tests (Track 17).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerDiagnosticCheck,
  getDiagnosticChecks,
  clearDiagnosticChecks,
  buildDoctorReport,
} from '../DiagnosticRegistry';
import { withTimeout } from '../withTimeout';
import type { DiagnosticCheck, DiagnosticContext } from '../types';

const ctx = (platformId: DiagnosticContext['platformId']): DiagnosticContext => ({
  platformId,
});

const check = (
  id: string,
  status: 'pass' | 'warn' | 'fail',
  platforms: DiagnosticCheck['platforms'] = ['extension', 'desktop', 'server'],
): DiagnosticCheck => ({
  id,
  title: id,
  platforms,
  run: async () => ({ id, title: id, status, detail: id }),
});

describe('withTimeout', () => {
  it('resolves a fast promise', async () => {
    await expect(withTimeout(Promise.resolve(42), 50, 'x')).resolves.toBe(42);
  });

  it('rejects a slow promise with a labeled error', async () => {
    const never = new Promise<number>((r) => setTimeout(() => r(1), 100));
    await expect(withTimeout(never, 10, 'slow')).rejects.toThrow(
      /diagnostic check "slow" timed out after 10ms/,
    );
  });
});

describe('DiagnosticRegistry', () => {
  beforeEach(() => clearDiagnosticChecks());

  it('registers and lists checks', () => {
    registerDiagnosticCheck(check('a', 'pass'));
    expect(getDiagnosticChecks().map((c) => c.id)).toEqual(['a']);
  });

  it('filters by platformId', async () => {
    registerDiagnosticCheck(check('server-only', 'fail', ['server']));
    registerDiagnosticCheck(check('all', 'pass'));
    const report = await buildDoctorReport(ctx('extension'));
    expect(report.checks.map((c) => c.id)).toEqual(['all']);
    expect(report.overall).toBe('pass');
  });

  it('isolates a throwing check as fail without breaking others', async () => {
    registerDiagnosticCheck({
      id: 'boom',
      title: 'boom',
      platforms: ['server'],
      run: async () => {
        throw new Error('kaboom');
      },
    });
    registerDiagnosticCheck(check('ok', 'pass', ['server']));
    const report = await buildDoctorReport(ctx('server'));
    const boom = report.checks.find((c) => c.id === 'boom');
    expect(boom?.status).toBe('fail');
    expect(boom?.detail).toMatch(/check threw: kaboom/);
    expect(report.checks.find((c) => c.id === 'ok')?.status).toBe('pass');
    expect(report.overall).toBe('fail');
  });

  it('rolls up worst severity (warn beats pass, fail beats warn)', async () => {
    registerDiagnosticCheck(check('p', 'pass'));
    registerDiagnosticCheck(check('w', 'warn'));
    let report = await buildDoctorReport(ctx('server'));
    expect(report.overall).toBe('warn');

    registerDiagnosticCheck(check('f', 'fail'));
    report = await buildDoctorReport(ctx('server'));
    expect(report.overall).toBe('fail');
  });
});
