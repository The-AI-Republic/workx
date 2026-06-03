/**
 * Heap dump write ordering (Track 17): the diagnostics JSON must be written
 * BEFORE the snapshot, so a snapshot OOM/crash still leaves the numbers.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFile, rm, readdir } from 'fs/promises';
import { join } from 'path';

const { TMP } = vi.hoisted(() => {
  const p = require('path');
  const os = require('os');
  return {
    TMP: p.join(
      os.tmpdir(),
      `bx-heapdump-ord-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ),
  };
});

vi.mock('@/server/config/server-config', () => ({ getDataDir: () => TMP }));
vi.mock('../../handlers/logs', () => ({ emitLog: vi.fn() }));

import { performHeapDump } from '../heapdump';

describe('performHeapDump ordering / crash-safety', () => {
  it('still writes the diagnostics JSON when the snapshot writer throws', async () => {
    const result = await performHeapDump(async () => {
      throw new Error('snapshot OOM');
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/snapshot OOM/);

    // The diagnostics JSON was written before the failing snapshot.
    const files = await readdir(join(TMP, 'diagnostics'));
    const diag = files.find((f) => f.endsWith('-diagnostics.json'));
    expect(diag).toBeTruthy();
    const parsed = JSON.parse(
      await readFile(join(TMP, 'diagnostics', diag!), 'utf8'),
    );
    expect(parsed.analysis).toBeDefined();
    // The snapshot file must NOT exist (writer threw before writing).
    expect(files.some((f) => f.endsWith('.heapsnapshot'))).toBe(false);

    await rm(TMP, { recursive: true, force: true });
  });
});
