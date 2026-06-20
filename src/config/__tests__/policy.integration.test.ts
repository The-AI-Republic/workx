/**
 * Track 20 — the crux end-to-end invariant: a locked key must survive ALL
 * four agent-config write surfaces plus reload, and the runtime marker must
 * never round-trip to storage.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentConfig } from '@/config/AgentConfig';
import { extractStoredConfig } from '@/config/defaults';
import { resolve as resolveConfigPath } from '@/config/configSchema';
import { PolicyLockedError } from '@/core/config/policy';
import {
  registerPolicySources,
  resolveActivePolicy,
  __resetPolicyResolverForTests,
} from '@/core/config/policy';
import type { PolicySource } from '@/core/config/policy';
import type { IConfigChangeEvent } from '@/config/types';

vi.mock('@/core/storage/CredentialStore', () => ({
  isCredentialStoreInitialized: vi.fn(() => false),
  getCredentialStore: vi.fn(() => null),
}));

const _memStore: Record<string, unknown> = {};
vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => true),
  getConfigStorage: vi.fn(() => ({
    get: async (k: string) => _memStore[k] ?? null,
    set: async (k: string, v: unknown) => { _memStore[k] = v; },
    remove: async (k: string) => { delete _memStore[k]; },
    getMany: async (ks: string[]) => {
      const r: Record<string, unknown> = {};
      for (const k of ks) if (k in _memStore) r[k] = _memStore[k];
      return r;
    },
    setMany: async (i: Record<string, unknown>) => { Object.assign(_memStore, i); },
    removeMany: async (ks: string[]) => { for (const k of ks) delete _memStore[k]; },
    getAll: async () => ({ ..._memStore }),
    clear: async () => { for (const k of Object.keys(_memStore)) delete _memStore[k]; },
    getBytesInUse: async () => null,
  })),
}));

const lockingSource: PolicySource = {
  origin: 'file',
  load: async () => ({
    values: { 'agent.approval.mode': 'yolo' },
    lockedKeys: ['agent.approval.mode', 'agent.providers.openai.apiKey'],
    origin: 'file',
  }),
};

describe('Track 20 — locked key survives all four write surfaces', () => {
  let config: AgentConfig;

  beforeEach(async () => {
    (AgentConfig as any).instance = null;
    for (const k of Object.keys(_memStore)) delete _memStore[k];
    __resetPolicyResolverForTests();
    registerPolicySources([lockingSource]);
    await resolveActivePolicy(); // BEFORE getInstance → first buildRuntimeConfig sees policy
    config = await AgentConfig.getInstance();
  });

  afterEach(() => {
    (AgentConfig as any).instance = null;
    __resetPolicyResolverForTests();
  });

  it('(a) buildRuntimeConfig/reload: policy value wins', async () => {
    expect(config.getConfig().approval?.mode).toBe('yolo');
    await config.reload();
    expect(config.getConfig().approval?.mode).toBe('yolo');
  });

  it('(b) updateConfig: locked write is stripped + re-pinned, non-locked passes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    config.updateConfig({ approval: { mode: 'high_speed' } as any });
    expect(config.getConfig().approval?.mode).toBe('yolo');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('approval.mode')
    );
    config.updateConfig({ preferences: { ...config.getConfig().preferences, language: 'es' } });
    expect(config.getConfig().preferences.language).toBe('es'); // non-locked applied
    warn.mockRestore();
  });

  it('(c) domain mutator: locked provider apiKey write throws', async () => {
    await expect(config.setProviderApiKey('openai', 'sk-x')).rejects.toBeInstanceOf(
      PolicyLockedError
    );
  });

  it('(d) LLM setting_tool: configSchema.resolve denies write, allows read', () => {
    const w = resolveConfigPath('approval.mode', 'write');
    expect('denied' in w && w.denied).toBe(true);
    const r = resolveConfigPath('approval.mode', 'read');
    expect('denied' in r).toBe(false);
  });

  it('runtime marker populated; never persisted to storage', () => {
    const cfg = config.getConfig();
    expect(cfg.policy).toEqual({
      lockedKeys: ['approval.mode', 'providers.openai.apiKey'],
      origin: 'file',
    });
    const stored = extractStoredConfig(cfg) as unknown as Record<string, unknown>;
    expect('policy' in stored).toBe(false);
  });

  it('reload() emits a policy config-changed event', async () => {
    const events: IConfigChangeEvent[] = [];
    config.on('config-changed', (e) => events.push(e));
    await config.reload();
    expect(events.some((e) => e.section === 'policy')).toBe(true);
  });

  it('no active policy → no enforcement, marker cleared', async () => {
    __resetPolicyResolverForTests();
    (AgentConfig as any).instance = null;
    const unmanaged = await AgentConfig.getInstance();
    expect(unmanaged.getConfig().policy).toBeUndefined();
    expect(() => unmanaged.updateConfig({ approval: { mode: 'high_speed' } as any })).not.toThrow();
    expect(unmanaged.getConfig().approval?.mode).toBe('high_speed');
  });
});
