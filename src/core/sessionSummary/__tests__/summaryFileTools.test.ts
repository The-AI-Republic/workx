import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { createSummaryFileCanUseTool } from '../summaryFileTools';

describe('createSummaryFileCanUseTool', () => {
  const summaryPath = '/tmp/.airepublic-pi/memory/sessions/s1/summary.md';

  it('allows file_edit on the exact summary path (via `path` field)', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    const decision = gate('file_edit', { path: summaryPath });
    expect(decision).toEqual({ behavior: 'allow' });
  });

  it('allows file_edit on the exact summary path (via `file_path` field)', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    const decision = gate('file_edit', { file_path: summaryPath });
    expect(decision).toEqual({ behavior: 'allow' });
  });

  it('denies any tool that is not file_edit', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    const decision = gate('shell_exec', { path: summaryPath });
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') {
      expect(decision.decisionReason).toContain('file_edit');
    }
  });

  it('denies file_edit on a different path', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    const other = '/tmp/.airepublic-pi/memory/sessions/s1/other.md';
    const decision = gate('file_edit', { path: other });
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') {
      expect(decision.decisionReason).toContain('restricted');
    }
  });

  it('denies when input is missing a path', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    const decision = gate('file_edit', { something_else: 'oops' });
    expect(decision.behavior).toBe('deny');
    if (decision.behavior === 'deny') {
      expect(decision.decisionReason).toContain('missing');
    }
  });

  it('normalizes paths before comparing', () => {
    const gate = createSummaryFileCanUseTool(summaryPath);
    // Equivalent path with redundant `.` segments.
    const equivalent = path.join('/tmp/.airepublic-pi/memory/sessions/./s1/summary.md');
    const decision = gate('file_edit', { path: equivalent });
    expect(decision).toEqual({ behavior: 'allow' });
  });
});
