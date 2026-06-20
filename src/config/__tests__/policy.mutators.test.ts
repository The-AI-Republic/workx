/**
 * Track 20 — regression: a locked key must survive the DEDICATED domain
 * mutators, not just updateConfig. Before the fix these guarded a coarse
 * ancestor path (e.g. 'tools') and never re-pinned, so a lock on any leaf
 * below it (e.g. tools.sandboxPolicy.network_access) was silently bypassable
 * through the settings UI and only self-healed on reload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentConfig } from '@/config/AgentConfig';
import { getDefaultAgentConfig } from '@/config/defaults';
import { PolicyLockedError } from '@/core/config/policy';
import {
  registerPolicySources,
  resolveActivePolicy,
  __resetPolicyResolverForTests,
} from '@/core/config/policy';
import type { PolicySource, ResolvedPolicy } from '@/core/config/policy';

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

function srcOf(policy: ResolvedPolicy): PolicySource {
  return { origin: policy.origin, load: async () => policy };
}

async function managedWith(policy: ResolvedPolicy): Promise<AgentConfig> {
  (AgentConfig as any).instance = null;
  __resetPolicyResolverForTests();
  registerPolicySources([srcOf(policy)]);
  await resolveActivePolicy();
  return AgentConfig.getInstance();
}

const firstProviderId = Object.keys(getDefaultAgentConfig().providers)[0];

describe('Track 20 — domain mutators enforce leaf-level locks', () => {
  beforeEach(() => {
    for (const k of Object.keys(_memStore)) delete _memStore[k];
  });
  afterEach(() => {
    (AgentConfig as any).instance = null;
    __resetPolicyResolverForTests();
  });

  it('updateToolsConfig cannot override a pinned, locked sandbox leaf', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await managedWith({
      values: { 'agent.tools.sandboxPolicy.network_access': false },
      lockedKeys: ['agent.tools.sandboxPolicy.network_access'],
      origin: 'file',
    });
    expect(cfg.getConfig().tools?.sandboxPolicy?.network_access).toBe(false);

    cfg.updateToolsConfig({ sandboxPolicy: { network_access: true } as any });

    expect(cfg.getToolSandboxPolicy().network_access).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('tools.sandboxPolicy.network_access')
    );
    // A non-locked tools sibling still applies.
    cfg.updateToolsConfig({ dom_tool: false } as any);
    expect(cfg.getToolsConfig().dom_tool).toBe(false);
    warn.mockRestore();
  });

  it('updateToolsConfig honors a lock-only key (no pinned value)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await managedWith({
      values: {}, // lock with NO value → pin can't restore; strip must hold
      lockedKeys: ['agent.tools.execCommand'],
      origin: 'file',
    });
    cfg.updateToolsConfig({ execCommand: true } as any);
    expect(cfg.getToolsConfig().execCommand).not.toBe(true);
    warn.mockRestore();
  });

  it('updateProvider: locked apiKey leaf is stripped + re-pinned, sibling applies', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = await managedWith({
      values: { [`agent.providers.${firstProviderId}.apiKey`]: 'PINNED' },
      lockedKeys: [`agent.providers.${firstProviderId}.apiKey`],
      origin: 'file',
    });
    cfg.updateProvider(firstProviderId, { apiKey: 'attacker-key' } as any);
    expect(cfg.getProvider(firstProviderId)?.apiKey).toBe('PINNED');
    warn.mockRestore();
  });

  it('updateProvider: a whole-provider lock hard-rejects', async () => {
    const cfg = await managedWith({
      values: {},
      lockedKeys: [`agent.providers.${firstProviderId}`],
      origin: 'file',
    });
    expect(() =>
      cfg.updateProvider(firstProviderId, { baseUrl: 'http://x' } as any)
    ).toThrow(PolicyLockedError);
  });

  it('updateModelConfig: a locked provider.models subtree hard-rejects', async () => {
    // Pick a provider/model that definitely exists, select it (unmanaged),
    // then lock that provider's models on a fresh managed instance.
    (AgentConfig as any).instance = null;
    __resetPolicyResolverForTests();
    const unmanaged = await AgentConfig.getInstance();
    const m = unmanaged.getAllModels()[0];
    await unmanaged.setSelectedModel(`${m.providerId}:${m.model.modelKey}`);

    const cfg = await managedWith({
      values: {},
      lockedKeys: [`agent.providers.${m.providerId}.models`],
      origin: 'file',
    });
    expect(() => cfg.updateModelConfig({})).toThrow(PolicyLockedError);
  });

  it('enableTool/disableTool reject a specific tools.enabled lock and a whole-tools lock', async () => {
    const a = await managedWith({
      values: {},
      lockedKeys: ['agent.tools.enabled'],
      origin: 'file',
    });
    expect(() => a.enableTool('dom_tool')).toThrow(PolicyLockedError);
    expect(() => a.disableTool('dom_tool')).toThrow(PolicyLockedError);

    const b = await managedWith({
      values: {},
      lockedKeys: ['agent.tools'],
      origin: 'file',
    });
    expect(() => b.enableTool('dom_tool')).toThrow(PolicyLockedError);
  });

  it('createProfile is rejected when profiles are locked', async () => {
    const cfg = await managedWith({
      values: {},
      lockedKeys: ['agent.profiles'],
      origin: 'file',
    });
    expect(() =>
      cfg.createProfile({ name: 'p1', settings: {} } as any)
    ).toThrow(PolicyLockedError);
  });

  it('no active policy → mutators behave exactly as before', async () => {
    (AgentConfig as any).instance = null;
    __resetPolicyResolverForTests();
    const cfg = await AgentConfig.getInstance();
    expect(() =>
      cfg.updateToolsConfig({ sandboxPolicy: { network_access: false } as any })
    ).not.toThrow();
    expect(cfg.getToolSandboxPolicy().network_access).toBe(false);
  });
});
