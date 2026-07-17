import { afterEach, describe, expect, it, vi } from 'vitest';
import { RolloutRecorder } from '../../../storage/rollout/RolloutRecorder';
import {
  invalidateRolloutSnapshot,
  loadRolloutSnapshot,
} from '../loadRolloutSnapshot';

const touched = new Set<string>();

afterEach(() => {
  for (const sessionId of touched) invalidateRolloutSnapshot(sessionId);
  touched.clear();
  vi.restoreAllMocks();
});

describe('loadRolloutSnapshot', () => {
  it('bounds immutable snapshot caching with an LRU', async () => {
    const getMetadata = vi.fn().mockResolvedValue(null);
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({ getMetadata } as never);

    for (let index = 0; index < 33; index += 1) {
      const sessionId = `snapshot-lru-${index}`;
      touched.add(sessionId);
      await loadRolloutSnapshot(sessionId);
    }
    await loadRolloutSnapshot('snapshot-lru-0');
    expect(getMetadata).toHaveBeenCalledTimes(34);
  });

  it('does not let an invalidated in-flight read repopulate the cache', async () => {
    const sessionId = 'snapshot-invalidated-flight';
    touched.add(sessionId);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const getMetadata = vi.fn(async () => {
      await wait;
      return null;
    });
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({ getMetadata } as never);

    const first = loadRolloutSnapshot(sessionId);
    await vi.waitFor(() => expect(getMetadata).toHaveBeenCalledOnce());
    invalidateRolloutSnapshot(sessionId);
    release();
    await first;
    await loadRolloutSnapshot(sessionId);
    expect(getMetadata).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh read immediately after invalidating an in-flight snapshot', async () => {
    const sessionId = 'snapshot-invalidated-new-caller';
    touched.add(sessionId);
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const getMetadata = vi.fn()
      .mockImplementationOnce(async () => {
        await firstWait;
        return null;
      })
      .mockResolvedValueOnce(null);
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({ getMetadata } as never);

    const first = loadRolloutSnapshot(sessionId);
    await vi.waitFor(() => expect(getMetadata).toHaveBeenCalledOnce());
    invalidateRolloutSnapshot(sessionId);
    const second = loadRolloutSnapshot(sessionId);
    await expect(second).resolves.toMatchObject({ sessionId, revision: 0 });
    expect(getMetadata).toHaveBeenCalledTimes(2);

    releaseFirst();
    await first;
    await loadRolloutSnapshot(sessionId);
    expect(getMetadata).toHaveBeenCalledTimes(2);
  });
});
