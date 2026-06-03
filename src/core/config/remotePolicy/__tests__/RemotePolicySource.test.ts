import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemotePolicySource } from '../RemotePolicySource';

const _mem: Record<string, unknown> = {};
vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: () => true,
  getConfigStorage: () => ({
    get: async (k: string) => _mem[k] ?? null,
    set: async (k: string, v: unknown) => {
      _mem[k] = v;
    },
    remove: async (k: string) => {
      delete _mem[k];
    },
  }),
}));

const body = {
  values: { 'agent.approval.mode': 'yolo' },
  lockedKeys: ['agent.approval.mode'],
};
const res = (status: number, b?: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => b } as unknown as Response);

describe('RemotePolicySource', () => {
  beforeEach(() => {
    for (const k of Object.keys(_mem)) delete _mem[k];
  });

  it('no endpoint → not eligible, returns null', async () => {
    const src = new RemotePolicySource({});
    expect(await src.load()).toBeNull();
  });

  it('updated → caches policy + checksum and returns it', async () => {
    const src = new RemotePolicySource({
      endpoint: 'https://x',
      fetchImpl: async () => res(200, body),
    });
    const p = await src.load();
    expect(p).toEqual({ ...body, origin: 'remote' });
    expect((_mem['policy_cache'] as any).policy).toEqual({
      ...body,
      origin: 'remote',
    });
    expect((_mem['policy_cache'] as any).checksum).toMatch(/^sha256:/);
  });

  it('unchanged (304) → returns the cached policy', async () => {
    _mem['policy_cache'] = {
      policy: { ...body, origin: 'remote' },
      checksum: 'sha256:x',
    };
    const src = new RemotePolicySource({
      endpoint: 'https://x',
      fetchImpl: async () => res(304),
    });
    expect(await src.load()).toEqual({ ...body, origin: 'remote' });
  });

  it('error → fail-open with stale cache', async () => {
    _mem['policy_cache'] = {
      policy: { ...body, origin: 'remote' },
      checksum: 'sha256:x',
    };
    const src = new RemotePolicySource({
      endpoint: 'https://x',
      fetchImpl: async () => {
        throw new Error('down');
      },
    });
    expect(await src.load()).toEqual({ ...body, origin: 'remote' });
  });

  it('cleared (204) → drops cache and returns null', async () => {
    _mem['policy_cache'] = {
      policy: { ...body, origin: 'remote' },
      checksum: 'sha256:x',
    };
    const src = new RemotePolicySource({
      endpoint: 'https://x',
      fetchImpl: async () => res(204),
    });
    expect(await src.load()).toBeNull();
    expect(_mem['policy_cache']).toBeUndefined();
  });
});
