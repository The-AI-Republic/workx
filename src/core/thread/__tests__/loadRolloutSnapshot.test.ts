import { afterEach, describe, expect, it, vi } from 'vitest';
import { RolloutRecorder } from '../../../storage/rollout/RolloutRecorder';
import {
  invalidateRolloutSnapshot,
  loadModelContextSnapshot,
  loadRolloutRevision,
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

  it('reverse-scans to the latest replacement checkpoint and excludes display events', async () => {
    const records = [
      { sequence: 0, type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
      { sequence: 1, type: 'event_msg', payload: { type: 'BackgroundEvent' } },
      {
        sequence: 2,
        type: 'compacted',
        payload: {
          message: 'checkpoint',
          replacementHistory: [{ type: 'message', role: 'system', content: [] }],
        },
      },
      { sequence: 3, type: 'event_msg', payload: { type: 'AgentMessage' } },
      { sequence: 4, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
    ].map((item) => ({
      ...item,
      rolloutId: 'model-context',
      timestamp: new Date(item.sequence).toISOString(),
    }));
    const getItemsByRolloutIdRange = vi.fn(async (_sessionId, range) => records
      .filter((item) => range.beforeSequence === undefined || item.sequence < range.beforeSequence)
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, range.limit));
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({
      getMetadata: vi.fn().mockResolvedValue({ itemCount: 5 }),
      getLastSequenceNumber: vi.fn().mockResolvedValue(4),
      getItemsByRolloutIdRange,
    } as never);

    const snapshot = await loadModelContextSnapshot('model-context');
    expect(snapshot.revision).toBe(5);
    expect(snapshot.items.map((item) => item.type)).toEqual(['compacted', 'response_item']);
    expect(getItemsByRolloutIdRange).toHaveBeenCalledOnce();
  });

  it('excludes model-context appends newer than the captured sequence boundary', async () => {
    const records = [
      { sequence: 0, type: 'response_item', payload: { type: 'message', role: 'user', content: [] } },
      { sequence: 1, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
      { sequence: 2, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'racing' }] } },
    ];
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({
      getMetadata: vi.fn().mockResolvedValue({ itemCount: 2 }),
      getLastSequenceNumber: vi.fn().mockResolvedValue(1),
      getItemsByRolloutIdRange: vi.fn(async (_sessionId, range) => records
        .filter((item) => range.beforeSequence === undefined || item.sequence < range.beforeSequence)
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, range.limit)),
    } as never);

    const snapshot = await loadModelContextSnapshot('bounded-model-context');

    expect(snapshot.revision).toBe(2);
    expect(JSON.stringify(snapshot.items)).not.toContain('racing');
  });

  it('loads a committed revision without reading rollout items', async () => {
    const getItemsByRolloutId = vi.fn();
    vi.spyOn(RolloutRecorder, 'getProvider').mockResolvedValue({
      getMetadata: vi.fn().mockResolvedValue({ itemCount: 5000 }),
      getLastSequenceNumber: vi.fn().mockResolvedValue(4999),
      getItemsByRolloutId,
    } as never);

    await expect(loadRolloutRevision('revision-only')).resolves.toBe(5000);
    expect(getItemsByRolloutId).not.toHaveBeenCalled();
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
