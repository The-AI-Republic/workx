/**
 * Agent Service Handlers
 *
 * Platform-agnostic service handlers for agent lifecycle operations.
 * Extracted from extension service-worker setupMessageHandlers().
 *
 * @module core/services/agent-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface AgentServiceDeps {
  getAgent: () => {
    isReady(): Promise<unknown>;
    getModelClientFactory(): {
      setAuthManager(authManager: unknown): void;
      isBackendRouting(): boolean;
    };
    refreshModelClient(): Promise<void>;
    getSession(): {
      abortAllTasks(reason: string): Promise<void>;
    };
  } | null;

  /** Reload configuration and recreate agent */
  handleConfigUpdate?: () => Promise<unknown>;

  /** Create an auth manager from settings */
  createAuthManager?: (shouldUseBackend: boolean, backendBaseUrl: string | null) => unknown;

  /** Preserve auth manager for agent recreation */
  setAuthManager?: (authManager: unknown) => void;
}

export function createAgentServices(deps: AgentServiceDeps): Record<string, ServiceHandler> {
  const { getAgent } = deps;

  return {
    'agent.healthCheck': async () => {
      const agent = getAgent();
      if (!agent) {
        return { ready: false, message: 'Agent not initialized', timestamp: Date.now() };
      }
      const status = await agent.isReady();
      return { ...status as object, timestamp: Date.now() };
    },

    'agent.configUpdate': async () => {
      if (!deps.handleConfigUpdate) {
        throw new Error('Config update not supported on this platform');
      }
      return deps.handleConfigUpdate();
    },

    'agent.interrupt': async () => {
      const agent = getAgent();
      if (!agent) throw new Error('Agent not initialized');
      const session = agent.getSession();
      await session.abortAllTasks('UserInterrupt');
      return { success: true };
    },

    'agent.ping': async () => {
      return { type: 'PONG', timestamp: Date.now() };
    },

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

      const agent = getAgent();
      if (agent) {
        const factory = agent.getModelClientFactory();
        factory.setAuthManager(authManager);
        await agent.refreshModelClient();
      }

      return { success: true, isBackendRouting: shouldUseBackend };
    },
  };
}
