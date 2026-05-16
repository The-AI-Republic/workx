/**
 * Heap dump happy path + diagnostics capture (Track 17).
 */

import { describe, it, expect, vi } from 'vitest';
import { readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { TMP } = vi.hoisted(() => {
  const p = require('path');
  const os = require('os');
  return {
    TMP: p.join(
      os.tmpdir(),
      `bx-heapdump-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ),
  };
});

vi.mock('@/server/config/server-config', () => ({
  getDataDir: () => TMP,
}));
vi.mock('../../handlers/logs', () => ({
  emitLog: vi.fn(),
}));

import { captureMemoryDiagnostics, performHeapDump } from '../heapdump';

describe('captureMemoryDiagnostics', () => {
  it('returns a populated diagnostics shape with a recommendation', async () => {
    const d = await captureMemoryDiagnostics();
    expect(d.memoryUsage.rss).toBeGreaterThan(0);
    expect(d.v8HeapStats.heapSizeLimit).toBeGreaterThan(0);
    expect(typeof d.analysis.recommendation).toBe('string');
    expect(Array.isArray(d.analysis.potentialLeaks)).toBe(true);
    expect(d.nodeVersion).toMatch(/^v/);
  });
});

describe('performHeapDump', () => {
  it('writes both the snapshot and the diagnostics JSON under dataDir', async () => {
    const result = await performHeapDump();
    expect(result.success).toBe(true);
    expect(result.heapPath?.startsWith(join(TMP, 'diagnostics'))).toBe(true);
    expect(result.diagPath?.endsWith('-diagnostics.json')).toBe(true);

    const diag = JSON.parse(await readFile(result.diagPath!, 'utf8'));
    expect(diag.analysis).toBeDefined();
    expect(diag.memoryUsage).toBeDefined();

    const snap = await readFile(result.heapPath!, 'utf8');
    expect(snap.length).toBeGreaterThan(0);

    await rm(TMP, { recursive: true, force: true });
  });

  it('does not write outside the configured dataDir', async () => {
    expect(TMP.startsWith(tmpdir())).toBe(true);
  });
});
