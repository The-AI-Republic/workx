/**
 * Agent Service Handlers
 *
 * Platform-agnostic service handlers for agent lifecycle operations.
 * Per-session operations (e.g. interrupt) require a sessionId.
 * Global operations (e.g. configUpdate, initAuth) apply to all sessions
 * via the registry.
 *
 * @module core/services/agent-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface AgentServiceDeps {
  /** Registry for looking up sessions by ID */
  registry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSession(sessionId: string): any;
    listSessions(): unknown[];
  };

  /** Reload configuration and recreate agent */
  handleConfigUpdate?: () => Promise<unknown>;

  /** Create an auth manager from settings */
  createAuthManager?: (shouldUseBackend: boolean, backendBaseUrl: string | null) => unknown;

  /** Preserve auth manager for agent recreation */
  setAuthManager?: (authManager: unknown) => void;

  /** Update approval config in storage and in-memory ApprovalGate */
  updateApprovalConfig?: (config: Record<string, unknown>) => Promise<void>;
}

export function createAgentServices(deps: AgentServiceDeps): Record<string, ServiceHandler> {
  const { registry } = deps;

  return {
    /**
     * Health check for a specific session.
     * Requires: { sessionId: string }
     */
    'agent.healthCheck': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) {
        return { ready: false, message: 'sessionId is required', timestamp: Date.now() };
      }

      const agentSession = registry.getSession(sessionId);
      if (!agentSession?.agent) {
        return { ready: false, message: `Session not found: ${sessionId}`, timestamp: Date.now() };
      }

      const status = await agentSession.agent.isReady();
      return { ...status as object, timestamp: Date.now() };
    },

    /**
     * Trigger config reload — global, applies to all sessions.
     */
    'agent.configUpdate': async () => {
      if (!deps.handleConfigUpdate) {
        throw new Error('Config update not supported on this platform');
      }
      return deps.handleConfigUpdate();
    },

    /**
     * Interrupt/abort a specific session.
     * Requires: { sessionId: string }
     */
    'agent.interrupt': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      const agentSession = registry.getSession(sessionId);
      if (!agentSession?.agent) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      const session = agentSession.agent.getSession();
      await session.abortAllTasks('UserInterrupt');
      return { success: true };
    },

    /**
     * Keep-alive ping — no session needed.
     */
    'agent.ping': async () => {
      return { type: 'PONG', timestamp: Date.now() };
    },

    /**
     * Initialize auth — global, applies to all sessions.
     */
    'agent.initAuth': async (params) => {
      const { backendBaseUrl, useOwnApiKey } = params as {
        backendBaseUrl?: string | null;
        useOwnApiKey?: boolean;
      };

      if (!deps.createAuthManager || !deps.setAuthManager) {
        throw new Error('Auth initialization not supported on this platform');
      }

      const shouldUseBackend = useOwnApiKey === false;
      const authManager = deps.createAuthManager(shouldUseBackend, shouldUseBackend ? (backendBaseUrl ?? null) : null);

      deps.setAuthManager(authManager);

      // Apply auth manager to all active sessions
      const sessions = registry.listSessions() as Array<{ sessionId: string; state: string }>;
      for (const s of sessions) {
        if (s.state === 'terminated') continue;
        const agentSession = registry.getSession(s.sessionId);
        if (agentSession?.agent) {
          const factory = agentSession.agent.getModelClientFactory();
          factory.setAuthManager(authManager);
          await agentSession.agent.refreshModelClient();
        }
      }

      return { success: true, isBackendRouting: shouldUseBackend };
    },

    /**
     * Update approval config — global, applies to all sessions.
     */
    'approval.updateConfig': async (params) => {
      const config = params as Record<string, unknown>;
      // Platform-specific storage update (if provided)
      if (deps.updateApprovalConfig) {
        await deps.updateApprovalConfig(config);
      }
      // Update in-memory ApprovalGate for all sessions
      const sessions = registry.listSessions() as Array<{ sessionId: string; state: string }>;
      for (const s of sessions) {
        if (s.state === 'terminated') continue;
        const agentSession = registry.getSession(s.sessionId);
        if (agentSession?.agent) {
          const gate = agentSession.agent.getToolRegistry().getApprovalGate();
          if (gate) {
            if (config.mode) gate.setMode(config.mode as string);
            if (config.trustedDomains) gate.setTrustedDomains(config.trustedDomains as string[]);
            if (config.blockedDomains) gate.setBlockedDomains(config.blockedDomains as string[]);
          }
        }
      }
      return { success: true };
    },
  };
}
