import { describe, it, expect, vi, beforeEach } from 'vitest';

const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/path', () => ({
  join: (...p: string[]) => Promise.resolve(p.join('/')),
}));
vi.mock('@/desktop/platform/paths', () => ({
  getLogPath: () => Promise.resolve('/logs'),
}));

import { FileSink } from '../FileSink';

describe('Desktop FileSink — size-capped rotation (Test 3.c)', () => {
  beforeEach(() => {
    invoke.mockClear();
    vi.useFakeTimers();
  });

  it('caps the in-memory ring and rewrites a bounded file (no append API)', async () => {
    for (let i = 0; i < 2100; i++) {
      FileSink.write({ name: 'e', metadata: { i } });
    }
    await vi.advanceTimersByTimeAsync(5000); // debounce flush

    const writeCall = invoke.mock.calls.find(
      (c) => c[0] === 'skills_write_file',
    );
    expect(writeCall).toBeTruthy();
    const { path, content } = writeCall![1] as {
      path: string;
      content: string;
    };
    expect(path).toBe('/logs/telemetry.jsonl');
    const lines = content.trimEnd().split('\n');
    // ring is capped at MAX_LINES (2000); oldest dropped
    expect(lines).toHaveLength(2000);
    expect(JSON.parse(lines[0]!).m.i).toBe(100); // first 100 rotated out
    expect(JSON.parse(lines[1999]!).m.i).toBe(2099);
  });

  it('write() never throws even if invoke rejects', async () => {
    invoke.mockRejectedValue(new Error('tauri boom'));
    expect(() => FileSink.write({ name: 'x', metadata: {} })).not.toThrow();
    await vi.advanceTimersByTimeAsync(5000);
  });
});
