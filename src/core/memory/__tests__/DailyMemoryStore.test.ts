import { describe, it, expect, vi } from 'vitest';
import { DailyMemoryStore, formatLocalDateStamp } from '../DailyMemoryStore';

function createMockFS() {
  const store = new Map<string, string>();
  return {
    readFile: vi.fn().mockImplementation(async (path: string) => store.get(path) ?? ''),
    writeFile: vi.fn().mockImplementation(async (path: string, content: string) => {
      store.set(path, content);
    }),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockImplementation(async (path: string) => store.has(path)),
    _store: store,
  };
}

describe('formatLocalDateStamp', () => {
  it('uses local date components instead of UTC serialization', () => {
    const date = new Date(2026, 2, 19, 23, 45, 0);

    expect(formatLocalDateStamp(date)).toBe('2026-03-19');
  });
});

describe('DailyMemoryStore.appendFact', () => {
  it('writes the daily file using the local date stamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 19, 23, 45, 0));

    const fs = createMockFS();
    const store = new DailyMemoryStore(fs as any, '/memory');

    await store.appendFact('User likes tea', 'general');

    expect(fs.writeFile).toHaveBeenCalledWith(
      '/memory/2026-03-19.md',
      expect.stringContaining('# 2026-03-19')
    );

    vi.useRealTimers();
  });
});
