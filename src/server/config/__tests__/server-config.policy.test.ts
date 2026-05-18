/**
 * Track 20 — the server config is the second config system. A locked
 * `server.*` key must survive `loadServerConfig()` and beat the env override
 * (env stays an admin lever, but `lockedKeys` pins the resolved value).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ResolvedPolicy } from '@/core/config/policy';

const ENV_KEYS = ['APPLEPI_CONFIG_PATH', 'APPLEPI_DATA_DIR', 'APPLEPI_SERVER_PORT'];
const saved: Record<string, string | undefined> = {};

let loadServerConfig: typeof import('../server-config').loadServerConfig;
let registerPolicySources: typeof import('@/core/config/policy').registerPolicySources;
let resolveActivePolicy: typeof import('@/core/config/policy').resolveActivePolicy;

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  vi.resetModules();
  // Import both from the SAME fresh module graph so the resolver singleton
  // server-config reads is the one we register sources on.
  const policy = await import('@/core/config/policy');
  registerPolicySources = policy.registerPolicySources;
  resolveActivePolicy = policy.resolveActivePolicy;
  policy.__resetPolicyResolverForTests();
  loadServerConfig = (await import('../server-config')).loadServerConfig;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
});

describe('Track 20 — server-config policy pin', () => {
  it('no policy → env override wins as before', async () => {
    process.env.APPLEPI_SERVER_PORT = '1234';
    const cfg = loadServerConfig();
    expect(cfg.server.port).toBe(1234);
  });

  it('locked server.port beats the env override', async () => {
    registerPolicySources([
      {
        origin: 'file',
        load: async () => ({
          values: { 'server.server.port': 9999 },
          lockedKeys: ['server.server.port'],
          origin: 'file',
        }),
      },
    ]);
    await resolveActivePolicy();
    process.env.APPLEPI_SERVER_PORT = '1234';
    const cfg = loadServerConfig();
    expect(cfg.server.port).toBe(9999); // policy > env > file > defaults
  });

  it('a post-boot policy change is re-pinned by a second loadServerConfig()', async () => {
    // Mirrors the ServerAgentBootstrap onPolicyChanged handler, which now
    // re-runs loadServerConfig() so the server.* tier re-pins without a
    // restart (AgentConfig.reload() only re-hydrates the agent.* tier).
    let current: ResolvedPolicy | null = null;
    registerPolicySources([{ origin: 'file', load: async () => current }]);
    await resolveActivePolicy();
    expect(loadServerConfig().server.port).toBe(18100); // no policy yet

    current = {
      values: { 'server.server.port': 7777 },
      lockedKeys: ['server.server.port'],
      origin: 'file',
    };
    await resolveActivePolicy();
    expect(loadServerConfig().server.port).toBe(7777); // re-pinned
  });

  it('agent-namespaced policy does not leak into server config', async () => {
    registerPolicySources([
      {
        origin: 'file',
        load: async () => ({
          values: { 'agent.selectedModelKey': 'x:y' },
          lockedKeys: ['agent.selectedModelKey'],
          origin: 'file',
        }),
      },
    ]);
    await resolveActivePolicy();
    const cfg = loadServerConfig() as Record<string, unknown>;
    expect('selectedModelKey' in cfg).toBe(false);
    expect((cfg as any).server.port).toBe(18100); // untouched default
  });
});
