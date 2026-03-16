/**
 * Tests for agent service handlers
 *
 * Verifies all agent.* and approval.* service handlers route correctly by sessionId,
 * enforce required parameters, handle missing deps, and delegate properly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentServices, type AgentServiceDeps } from '../agent-services';
import type { SubmissionContext } from '@/core/channels/types';

const ctx = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

function createMockAgent(overrides: Record<string, unknown> = {}) {
  return {
    isReady: vi.fn().mockResolvedValue({ ready: true, message: 'ok' }),
    getSession: vi.fn().mockReturnValue({
      abortAllTasks: vi.fn().mockResolvedValue(undefined),
    }),
    getModelClientFactory: vi.fn().mockReturnValue({
      setAuthManager: vi.fn(),
    }),
    refreshModelClient: vi.fn().mockResolvedValue(undefined),
    getToolRegistry: vi.fn().mockReturnValue({
      getApprovalGate: vi.fn().mockReturnValue({
        setMode: vi.fn(),
        setTrustedDomains: vi.fn(),
        setBlockedDomains: vi.fn(),
      }),
    }),
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<AgentServiceDeps> = {}): AgentServiceDeps {
  const sessionMocks: Record<string, any> = {
    s1: { agent: createMockAgent(), state: 'active' },
  };

  return {
    registry: {
      getSession: vi.fn((id: string) => sessionMocks[id] ?? undefined),
      listSessions: vi.fn(() =>
        Object.entries(sessionMocks).map(([sessionId, mock]) => ({
          sessionId,
          state: mock.state ?? 'active',
        })),
      ),
    },
    handleConfigUpdate: vi.fn().mockResolvedValue({ updated: true }),
    createAuthManager: vi.fn().mockReturnValue({ type: 'mock-auth' }),
    setAuthManager: vi.fn(),
    updateApprovalConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('createAgentServices', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let services: ReturnType<typeof createAgentServices>;

  beforeEach(() => {
    vi.restoreAllMocks();
    deps = createMockDeps();
    services = createAgentServices(deps);
  });

  // ─── agent.healthCheck ───────────────────────────────────────────────

  describe('agent.healthCheck', () => {
    it('returns ready status when session exists and agent is ready', async () => {
      const result = await services['agent.healthCheck']({ sessionId: 's1' }, ctx);
      expect(result).toMatchObject({ ready: true, message: 'ok' });
      expect(result).toHaveProperty('timestamp');
    });

    it('returns not ready when sessionId is missing', async () => {
      const result = await services['agent.healthCheck']({}, ctx);
      expect(result).toMatchObject({ ready: false, message: 'sessionId is required' });
      expect(result).toHaveProperty('timestamp');
    });

    it('returns not ready when params is undefined', async () => {
      const result = await services['agent.healthCheck'](undefined as any, ctx);
      expect(result).toMatchObject({ ready: false, message: 'sessionId is required' });
    });

    it('returns not ready when session is not found', async () => {
      const result = await services['agent.healthCheck']({ sessionId: 'unknown' }, ctx);
      expect(result).toMatchObject({ ready: false, message: 'Session not found: unknown' });
      expect(result).toHaveProperty('timestamp');
    });

    it('returns not ready when session exists but agent is null', async () => {
      (deps.registry.getSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({ agent: null });
      const result = await services['agent.healthCheck']({ sessionId: 's1' }, ctx);
      expect(result).toMatchObject({ ready: false, message: 'Session not found: s1' });
    });

    it('spreads the agent isReady result into the response', async () => {
      const agentSession = deps.registry.getSession('s1');
      agentSession.agent.isReady.mockResolvedValueOnce({ ready: false, message: 'not connected', detail: 'x' });
      const result = (await services['agent.healthCheck']({ sessionId: 's1' }, ctx)) as Record<string, unknown>;
      expect(result).toMatchObject({ ready: false, message: 'not connected', detail: 'x' });
      expect(typeof result.timestamp).toBe('number');
    });
  });

  // ─── agent.configUpdate ──────────────────────────────────────────────

  describe('agent.configUpdate', () => {
    it('delegates to handleConfigUpdate and returns its result', async () => {
      const result = await services['agent.configUpdate']({}, ctx);
      expect(result).toEqual({ updated: true });
      expect(deps.handleConfigUpdate).toHaveBeenCalledOnce();
    });

    it('throws when handleConfigUpdate dep is not provided', async () => {
      const noDep = createMockDeps({ handleConfigUpdate: undefined });
      const svc = createAgentServices(noDep);
      await expect(svc['agent.configUpdate']({}, ctx)).rejects.toThrow(
        'Config update not supported on this platform',
      );
    });
  });

  // ─── agent.interrupt ─────────────────────────────────────────────────

  describe('agent.interrupt', () => {
    it('aborts all tasks and returns success', async () => {
      const result = await services['agent.interrupt']({ sessionId: 's1' }, ctx);
      expect(result).toEqual({ success: true });
      const agentSession = deps.registry.getSession('s1');
      const session = agentSession.agent.getSession();
      expect(session.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
    });

    it('throws when sessionId is missing', async () => {
      await expect(services['agent.interrupt']({}, ctx)).rejects.toThrow('sessionId is required');
    });

    it('throws when params is undefined', async () => {
      await expect(services['agent.interrupt'](undefined as any, ctx)).rejects.toThrow(
        'sessionId is required',
      );
    });

    it('throws when session is not found', async () => {
      await expect(services['agent.interrupt']({ sessionId: 'nope' }, ctx)).rejects.toThrow(
        'Session not found: nope',
      );
    });

    it('throws when session exists but agent is null', async () => {
      (deps.registry.getSession as ReturnType<typeof vi.fn>).mockReturnValueOnce({ agent: null });
      await expect(services['agent.interrupt']({ sessionId: 's1' }, ctx)).rejects.toThrow(
        'Session not found: s1',
      );
    });
  });

  // ─── agent.ping ──────────────────────────────────────────────────────

  describe('agent.ping', () => {
    it('returns a PONG with a timestamp', async () => {
      const result = (await services['agent.ping']({}, ctx)) as Record<string, unknown>;
      expect(result.type).toBe('PONG');
      expect(typeof result.timestamp).toBe('number');
    });
  });

  // ─── agent.initAuth ──────────────────────────────────────────────────

  describe('agent.initAuth', () => {
    it('creates auth manager with backend routing when useOwnApiKey is false', async () => {
      const result = await services['agent.initAuth'](
        { backendBaseUrl: 'https://api.example.com', useOwnApiKey: false },
        ctx,
      );
      expect(result).toEqual({ success: true, isBackendRouting: true });
      expect(deps.createAuthManager).toHaveBeenCalledWith(true, 'https://api.example.com');
      expect(deps.setAuthManager).toHaveBeenCalledWith({ type: 'mock-auth' });
    });

    it('creates auth manager without backend routing when useOwnApiKey is true', async () => {
      const result = await services['agent.initAuth'](
        { backendBaseUrl: 'https://api.example.com', useOwnApiKey: true },
        ctx,
      );
      expect(result).toEqual({ success: true, isBackendRouting: false });
      expect(deps.createAuthManager).toHaveBeenCalledWith(false, null);
    });

    it('uses null backendBaseUrl when not provided and useOwnApiKey is false', async () => {
      const result = await services['agent.initAuth']({ useOwnApiKey: false }, ctx);
      expect(result).toEqual({ success: true, isBackendRouting: true });
      expect(deps.createAuthManager).toHaveBeenCalledWith(true, null);
    });

    it('throws when createAuthManager dep is missing', async () => {
      const noDep = createMockDeps({ createAuthManager: undefined });
      const svc = createAgentServices(noDep);
      await expect(
        svc['agent.initAuth']({ useOwnApiKey: false }, ctx),
      ).rejects.toThrow('Auth initialization not supported on this platform');
    });

    it('throws when setAuthManager dep is missing', async () => {
      const noDep = createMockDeps({ setAuthManager: undefined });
      const svc = createAgentServices(noDep);
      await expect(
        svc['agent.initAuth']({ useOwnApiKey: false }, ctx),
      ).rejects.toThrow('Auth initialization not supported on this platform');
    });

    it('updates auth on all active sessions', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn((id: string) => {
            if (id === 's1') return { agent: agent1 };
            if (id === 's2') return { agent: agent2 };
            return undefined;
          }),
          listSessions: vi.fn(() => [
            { sessionId: 's1', state: 'active' },
            { sessionId: 's2', state: 'active' },
          ]),
        },
      });
      const svc = createAgentServices(multiDeps);
      await svc['agent.initAuth']({ useOwnApiKey: false }, ctx);

      expect(agent1.getModelClientFactory().setAuthManager).toHaveBeenCalledWith({ type: 'mock-auth' });
      expect(agent1.refreshModelClient).toHaveBeenCalled();
      expect(agent2.getModelClientFactory().setAuthManager).toHaveBeenCalledWith({ type: 'mock-auth' });
      expect(agent2.refreshModelClient).toHaveBeenCalled();
    });

    it('skips terminated sessions', async () => {
      const activeAgent = createMockAgent();
      const terminatedAgent = createMockAgent();
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn((id: string) => {
            if (id === 's1') return { agent: activeAgent };
            if (id === 's2') return { agent: terminatedAgent };
            return undefined;
          }),
          listSessions: vi.fn(() => [
            { sessionId: 's1', state: 'active' },
            { sessionId: 's2', state: 'terminated' },
          ]),
        },
      });
      const svc = createAgentServices(multiDeps);
      await svc['agent.initAuth']({ useOwnApiKey: false }, ctx);

      expect(activeAgent.refreshModelClient).toHaveBeenCalled();
      expect(terminatedAgent.refreshModelClient).not.toHaveBeenCalled();
    });

    it('skips sessions without an agent', async () => {
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn(() => ({ agent: null })),
          listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
        },
      });
      const svc = createAgentServices(multiDeps);
      // Should not throw
      const result = await svc['agent.initAuth']({ useOwnApiKey: false }, ctx);
      expect(result).toEqual({ success: true, isBackendRouting: true });
    });
  });

  // ─── approval.updateConfig ───────────────────────────────────────────

  describe('approval.updateConfig', () => {
    it('calls updateApprovalConfig and updates active sessions', async () => {
      const config = { mode: 'strict', trustedDomains: ['a.com'], blockedDomains: ['b.com'] };
      const result = await services['approval.updateConfig'](config, ctx);
      expect(result).toEqual({ success: true });
      expect(deps.updateApprovalConfig).toHaveBeenCalledWith(config);

      const agentSession = deps.registry.getSession('s1');
      const gate = agentSession.agent.getToolRegistry().getApprovalGate();
      expect(gate.setMode).toHaveBeenCalledWith('strict');
      expect(gate.setTrustedDomains).toHaveBeenCalledWith(['a.com']);
      expect(gate.setBlockedDomains).toHaveBeenCalledWith(['b.com']);
    });

    it('works when updateApprovalConfig dep is not provided', async () => {
      const noDep = createMockDeps({ updateApprovalConfig: undefined });
      const svc = createAgentServices(noDep);
      const result = await svc['approval.updateConfig']({ mode: 'auto' }, ctx);
      expect(result).toEqual({ success: true });
    });

    it('only sets fields that are present in the config', async () => {
      const result = await services['approval.updateConfig']({ mode: 'permissive' }, ctx);
      expect(result).toEqual({ success: true });

      const agentSession = deps.registry.getSession('s1');
      const gate = agentSession.agent.getToolRegistry().getApprovalGate();
      expect(gate.setMode).toHaveBeenCalledWith('permissive');
      expect(gate.setTrustedDomains).not.toHaveBeenCalled();
      expect(gate.setBlockedDomains).not.toHaveBeenCalled();
    });

    it('skips terminated sessions', async () => {
      const activeAgent = createMockAgent();
      const terminatedAgent = createMockAgent();
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn((id: string) => {
            if (id === 's1') return { agent: activeAgent };
            if (id === 's2') return { agent: terminatedAgent };
            return undefined;
          }),
          listSessions: vi.fn(() => [
            { sessionId: 's1', state: 'active' },
            { sessionId: 's2', state: 'terminated' },
          ]),
        },
      });
      const svc = createAgentServices(multiDeps);
      await svc['approval.updateConfig']({ mode: 'strict' }, ctx);

      const gate1 = activeAgent.getToolRegistry().getApprovalGate();
      expect(gate1.setMode).toHaveBeenCalledWith('strict');
      expect(terminatedAgent.getToolRegistry().getApprovalGate().setMode).not.toHaveBeenCalled();
    });

    it('handles sessions without an agent gracefully', async () => {
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn(() => ({ agent: null })),
          listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
        },
      });
      const svc = createAgentServices(multiDeps);
      const result = await svc['approval.updateConfig']({ mode: 'strict' }, ctx);
      expect(result).toEqual({ success: true });
    });

    it('handles agent with no approval gate', async () => {
      const agentNoGate = createMockAgent({
        getToolRegistry: vi.fn().mockReturnValue({
          getApprovalGate: vi.fn().mockReturnValue(null),
        }),
      });
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn(() => ({ agent: agentNoGate })),
          listSessions: vi.fn(() => [{ sessionId: 's1', state: 'active' }]),
        },
      });
      const svc = createAgentServices(multiDeps);
      // Should not throw when gate is null
      const result = await svc['approval.updateConfig']({ mode: 'strict' }, ctx);
      expect(result).toEqual({ success: true });
    });

    it('updates multiple active sessions', async () => {
      const agent1 = createMockAgent();
      const agent2 = createMockAgent();
      const multiDeps = createMockDeps({
        registry: {
          getSession: vi.fn((id: string) => {
            if (id === 's1') return { agent: agent1 };
            if (id === 's2') return { agent: agent2 };
            return undefined;
          }),
          listSessions: vi.fn(() => [
            { sessionId: 's1', state: 'active' },
            { sessionId: 's2', state: 'active' },
          ]),
        },
      });
      const svc = createAgentServices(multiDeps);
      await svc['approval.updateConfig'](
        { mode: 'strict', trustedDomains: ['x.com'] },
        ctx,
      );

      const gate1 = agent1.getToolRegistry().getApprovalGate();
      const gate2 = agent2.getToolRegistry().getApprovalGate();
      expect(gate1.setMode).toHaveBeenCalledWith('strict');
      expect(gate1.setTrustedDomains).toHaveBeenCalledWith(['x.com']);
      expect(gate2.setMode).toHaveBeenCalledWith('strict');
      expect(gate2.setTrustedDomains).toHaveBeenCalledWith(['x.com']);
    });
  });
});
