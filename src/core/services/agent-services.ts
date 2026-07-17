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
import type { IAuthManager } from '@/core/models/types/Auth';
import {
  accessStateFromReadyState,
  type AgentAccessState,
  type RuntimeStateController,
} from './runtime-state';
import { stripLockedWrites } from '@/core/config/policy/guards';
import type { ApprovalMode } from '@/core/approval/types';

const APPROVAL_MODES = new Set<ApprovalMode>(['balanced', 'high_speed', 'yolo']);
const APPROVAL_CONFIG_KEYS = new Set([
  'version',
  'mode',
  'userRules',
  'trustedDomains',
  'blockedDomains',
  'timeouts',
]);

function validateApprovalConfigPatch(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Approval config must be an object');
  }
  const config = value as Record<string, unknown>;
  const unknownKeys = Object.keys(config).filter((key) => !APPROVAL_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unknown approval config field(s): ${unknownKeys.join(', ')}`);
  }
  if (config.version !== undefined && config.version !== '1.0.0') {
    throw new Error('Unsupported approval config version');
  }
  if (config.mode !== undefined && !APPROVAL_MODES.has(config.mode as ApprovalMode)) {
    throw new Error(`Invalid approval mode: ${String(config.mode)}`);
  }
  for (const field of ['trustedDomains', 'blockedDomains'] as const) {
    const domains = config[field];
    if (domains !== undefined && (
      !Array.isArray(domains) || domains.some((domain) => typeof domain !== 'string')
    )) {
      throw new Error(`${field} must be an array of strings`);
    }
  }
  if (config.userRules !== undefined && !Array.isArray(config.userRules)) {
    throw new Error('userRules must be an array');
  }
  if (config.timeouts !== undefined) {
    if (!config.timeouts || typeof config.timeouts !== 'object' || Array.isArray(config.timeouts)) {
      throw new Error('timeouts must be an object');
    }
    for (const [level, timeout] of Object.entries(config.timeouts)) {
      if (!['low', 'medium', 'high', 'critical'].includes(level)) {
        throw new Error(`Unknown approval timeout: ${level}`);
      }
      if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
        throw new Error(`Invalid approval timeout for ${level}`);
      }
    }
  }
  return config;
}

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
  createAuthManager?: (shouldUseBackend: boolean, backendBaseUrl: string | null) => IAuthManager;

  /** Preserve auth manager for agent recreation */
  setAuthManager?: (authManager: IAuthManager | null) => void;

  /** Runtime-owned desktop access state contract (Track 44). */
  runtimeState?: RuntimeStateController;

  /** Update approval config in storage and in-memory ApprovalGate */
  updateApprovalConfig?: (config: Record<string, unknown>) => Promise<void>;
}

export function createAgentServices(deps: AgentServiceDeps): Record<string, ServiceHandler> {
  const { registry } = deps;

  function isPrimarySessionId(sessionId: string): boolean {
    const sessions = registry.listSessions() as Array<{
      sessionId: string;
      state: string;
      sessionType?: string;
      type?: string;
    }>;
    const activeSessions = sessions.filter((s) => s.state !== 'terminated');
    const explicitlyPrimary = activeSessions.find((s) => s.sessionType === 'primary' || s.type === 'primary');
    if (explicitlyPrimary) {
      return explicitlyPrimary.sessionId === sessionId;
    }
    return activeSessions[0]?.sessionId === sessionId;
  }

  async function computeAccessState(fallback?: Partial<AgentAccessState>): Promise<AgentAccessState> {
    const sessions = registry.listSessions() as Array<{ sessionId: string; state: string; sessionType?: string; type?: string }>;
    const active = sessions.find((s) => s.state !== 'terminated' && (s.sessionType === 'primary' || s.type === 'primary'))
      ?? sessions.find((s) => s.state !== 'terminated');
    if (active) {
      const agentSession = registry.getSession(active.sessionId);
      if (agentSession?.agent) {
        const status = await agentSession.agent.isReady();
        return accessStateFromReadyState(status);
      }
    }
    return {
      status: fallback?.status ?? 'initializing',
      mode: fallback?.mode ?? 'none',
      ready: fallback?.ready ?? false,
      provider: fallback?.provider,
      model: fallback?.model,
      reason: fallback?.reason ?? 'Agent session is initializing.',
      updatedAt: Date.now(),
    };
  }

  async function publishAccessState(fallback?: Partial<AgentAccessState>): Promise<AgentAccessState> {
    const access = await computeAccessState(fallback);
    if (deps.runtimeState) {
      return deps.runtimeState.setAccessState(access);
    }
    return access;
  }

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
      if (deps.runtimeState && isPrimarySessionId(sessionId)) {
        await deps.runtimeState.setAccessFromReadyState(status);
      }
      return { ...status as object, timestamp: Date.now() };
    },

    /**
     * Global access state for UI banners and startup hydration. Unlike
     * `agent.healthCheck`, this is not tied to a specific chat session.
     */
    'agent.getAccessState': async () => {
      return publishAccessState(deps.runtimeState?.getAccessState());
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
      // Track 04: user-initiated interrupt narrows to the foreground task;
      // background sub-agents survive. interruptTask() encapsulates the
      // foreground-only logic.
      await session.interruptTask();
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

      const access = await publishAccessState({
        status: shouldUseBackend ? 'ready' : 'needs_api_key',
        mode: shouldUseBackend ? 'login' : 'api_key',
        ready: shouldUseBackend,
        reason: shouldUseBackend ? undefined : 'Configure an API key in Settings.',
      });

      return { success: true, isBackendRouting: shouldUseBackend, access };
    },

    /**
     * Update approval config — global, applies to all sessions.
     */
    'approval.updateConfig': async (params) => {
      const validated = validateApprovalConfigPatch(params);
      const { patch: config, stripped } = stripLockedWrites('agent', validated, 'approval');
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
            if (config.mode) gate.setMode(config.mode as ApprovalMode);
            if (config.trustedDomains) gate.setTrustedDomains(config.trustedDomains as string[]);
            if (config.blockedDomains) gate.setBlockedDomains(config.blockedDomains as string[]);
          }
        }
      }
      return {
        success: true,
        ...(stripped.length > 0 && { ignoredLockedKeys: stripped }),
      };
    },
  };
}
