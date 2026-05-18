/**
 * Built-in diagnostic check unit tests (Track 17).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const isConfigStorageInitialized = vi.fn();
const isCredentialStoreInitialized = vi.fn();
const validateConfig = vi.fn();
const getInstance = vi.fn();

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: () => isConfigStorageInitialized(),
}));
vi.mock('@/core/storage/CredentialStore', () => ({
  isCredentialStoreInitialized: () => isCredentialStoreInitialized(),
}));
vi.mock('@/config/validators', () => ({
  validateConfig: (c: unknown) => validateConfig(c),
}));
vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: { getInstance: () => getInstance() },
}));

import { configValidCheck } from '../checks/config-valid';
import { credentialsPresentCheck } from '../checks/credentials-present';
import { channelsReachableCheck } from '../checks/channels-reachable';
import { mcpConnectedCheck } from '../checks/mcp-connected';
import { skillsLoadedCheck } from '../checks/skills-loaded';
import { schedulerHealthCheck } from '../checks/scheduler-health';
import type { DiagnosticContext } from '../types';

const ctx = (over: Partial<DiagnosticContext> = {}): DiagnosticContext => ({
  platformId: 'server',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('config-valid', () => {
  it('warns when config storage uninitialized', async () => {
    isConfigStorageInitialized.mockReturnValue(false);
    expect((await configValidCheck.run(ctx())).status).toBe('warn');
  });

  it('fails on invalid config', async () => {
    isConfigStorageInitialized.mockReturnValue(true);
    getInstance.mockResolvedValue({ getConfig: () => ({}) });
    validateConfig.mockReturnValue({ valid: false, field: 'model', error: 'bad' });
    const r = await configValidCheck.run(ctx());
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/model/);
  });

  it('passes on valid config', async () => {
    isConfigStorageInitialized.mockReturnValue(true);
    getInstance.mockResolvedValue({ getConfig: () => ({}) });
    validateConfig.mockReturnValue({ valid: true });
    expect((await configValidCheck.run(ctx())).status).toBe('pass');
  });
});

describe('credentials-present', () => {
  it('fails on server without VITE_VAULT_SECRET', async () => {
    const prev = process.env.VITE_VAULT_SECRET;
    delete process.env.VITE_VAULT_SECRET;
    const r = await credentialsPresentCheck.run(ctx({ platformId: 'server' }));
    expect(r.status).toBe('fail');
    if (prev !== undefined) process.env.VITE_VAULT_SECRET = prev;
  });

  it('warns when store uninitialized (non-server)', async () => {
    isCredentialStoreInitialized.mockReturnValue(false);
    const r = await credentialsPresentCheck.run(ctx({ platformId: 'extension' }));
    expect(r.status).toBe('warn');
  });

  it('passes when all providers have a credential', async () => {
    isCredentialStoreInitialized.mockReturnValue(true);
    getInstance.mockResolvedValue({
      getConfig: () => ({ providers: { openai: { apiKey: '[SECURED]' } } }),
      getProviderApiKey: vi.fn().mockResolvedValue(null),
    });
    const r = await credentialsPresentCheck.run(ctx({ platformId: 'extension' }));
    expect(r.status).toBe('pass');
  });

  it('fails when no provider has a credential', async () => {
    isCredentialStoreInitialized.mockReturnValue(true);
    getInstance.mockResolvedValue({
      getConfig: () => ({ providers: { openai: { apiKey: '' } } }),
      getProviderApiKey: vi.fn().mockResolvedValue(null),
    });
    const r = await credentialsPresentCheck.run(ctx({ platformId: 'extension' }));
    expect(r.status).toBe('fail');
  });
});

describe('channels-reachable', () => {
  it('warns with no channel manager', async () => {
    expect((await channelsReachableCheck.run(ctx())).status).toBe('warn');
  });
  it('warns with zero channels', async () => {
    const r = await channelsReachableCheck.run(
      ctx({ channelManager: { getChannelInfo: () => [] } }),
    );
    expect(r.status).toBe('warn');
  });
  it('passes with channels', async () => {
    const r = await channelsReachableCheck.run(
      ctx({ channelManager: { getChannelInfo: () => [{ channelId: 'ws' }] } }),
    );
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/ws/);
  });
});

describe('mcp-connected', () => {
  it('passes when MCP not in use', async () => {
    expect((await mcpConnectedCheck.run(ctx())).status).toBe('pass');
  });
  it('fails on an errored server', async () => {
    const r = await mcpConnectedCheck.run(
      ctx({
        mcpManager: {
          getServers: () => [{}],
          getConnections: () => [
            { configId: 'fs', status: 'error', lastError: 'spawn ENOENT' },
          ],
        },
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/spawn ENOENT/);
  });
  it('passes when all connected', async () => {
    const r = await mcpConnectedCheck.run(
      ctx({
        mcpManager: {
          getServers: () => [{}],
          getConnections: () => [{ configId: 'fs', status: 'connected' }],
        },
      }),
    );
    expect(r.status).toBe('pass');
  });
});

describe('skills-loaded', () => {
  it('warns without a registry', async () => {
    expect((await skillsLoadedCheck.run(ctx())).status).toBe('warn');
  });
  it('warns on name collision', async () => {
    const r = await skillsLoadedCheck.run(
      ctx({
        skillRegistry: {
          getAllSkillMetas: () => [{ name: 'a' }, { name: 'a' }],
          getSkillMetas: () => [],
        },
      }),
    );
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/collision/);
  });
  it('passes with unique skills', async () => {
    const r = await skillsLoadedCheck.run(
      ctx({
        skillRegistry: {
          getAllSkillMetas: () => [{ name: 'a' }, { name: 'b' }],
          getSkillMetas: () => [],
        },
      }),
    );
    expect(r.status).toBe('pass');
  });
});

describe('scheduler-health', () => {
  it('warns without a scheduler', async () => {
    expect((await schedulerHealthCheck.run(ctx())).status).toBe('warn');
  });
  it('fails on missed instances', async () => {
    const r = await schedulerHealthCheck.run(
      ctx({
        scheduler: {
          getSchedulerState: async () => ({
            isPaused: false,
            missedCount: 2,
            jobQueueCount: 0,
          }),
        },
      }),
    );
    expect(r.status).toBe('fail');
  });
  it('warns when paused, passes when running', async () => {
    const paused = await schedulerHealthCheck.run(
      ctx({
        scheduler: {
          getSchedulerState: async () => ({
            isPaused: true,
            missedCount: 0,
            jobQueueCount: 0,
          }),
        },
      }),
    );
    expect(paused.status).toBe('warn');

    const ok = await schedulerHealthCheck.run(
      ctx({
        scheduler: {
          getSchedulerState: async () => ({
            isPaused: false,
            missedCount: 0,
            jobQueueCount: 3,
          }),
        },
      }),
    );
    expect(ok.status).toBe('pass');
  });
});
