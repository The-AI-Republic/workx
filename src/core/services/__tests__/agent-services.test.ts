import { describe, expect, it, vi } from 'vitest';
import { createAgentServices, type AgentServiceDeps } from '../agent-services';
import type { SubmissionContext } from '@/core/channels/types';

const ctx = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

function createDeps(): AgentServiceDeps {
  const gate = {
    setMode: vi.fn(),
    setTrustedDomains: vi.fn(),
    setBlockedDomains: vi.fn(),
  };
  const agent = {
    isReady: vi.fn().mockResolvedValue({ ready: true, message: 'ok' }),
    getSession: () => ({ interruptTask: vi.fn().mockResolvedValue(undefined) }),
    getToolRegistry: () => ({ getApprovalGate: () => gate }),
  };
  return {
    registry: {
      getSession: vi.fn((id: string) => id === 's1' ? { agent, state: 'active' } : undefined),
      listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
    },
    handleConfigUpdate: vi.fn().mockResolvedValue({ updated: true }),
    updateApprovalConfig: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createAgentServices', () => {
  it('exposes no product-account auth initializer', () => {
    expect(createAgentServices(createDeps())).not.toHaveProperty('agent.initAuth');
  });

  it('reports session health', async () => {
    const services = createAgentServices(createDeps());
    await expect(services['agent.healthCheck']({ sessionId: 's1' }, ctx))
      .resolves.toMatchObject({ ready: true, message: 'ok' });
  });

  it('reloads configuration', async () => {
    const services = createAgentServices(createDeps());
    await expect(services['agent.configUpdate']({}, ctx)).resolves.toEqual({ updated: true });
  });

  it('updates approval configuration', async () => {
    const deps = createDeps();
    const services = createAgentServices(deps);
    await expect(services['approval.updateConfig']({ mode: 'balanced' }, ctx))
      .resolves.toEqual({ success: true });
    expect(deps.updateApprovalConfig).toHaveBeenCalledWith({ mode: 'balanced' });
  });
});
