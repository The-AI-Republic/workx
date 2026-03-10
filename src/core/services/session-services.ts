/**
 * Session Service Handlers
 *
 * Platform-agnostic service handlers for session management.
 * All per-session services require a sessionId parameter — there is no
 * concept of a "primary" or "default" session.  The registry is the
 * single source of truth for active sessions.
 *
 * @module core/services/session-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface SessionServiceDeps {
  /** Registry for multi-session management (required). */
  registry: {
    listSessions(): unknown[];
    getMaxConcurrent(): number;
    getActiveCount(): number;
    canCreateSession(): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession(config: any): Promise<{ sessionId: string; sessionLetter: string; agent: unknown }>;
    removeSession(sessionId: string): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSession(sessionId: string): any;
    setMaxConcurrent(limit: number): void;
  };

  /** Callback for platform-specific tab reset (extension-only) */
  resetTabs?: () => Promise<void>;

  /** Resume a session from stored history */
  resumeSession?: (sessionId: string) => Promise<{ sessionId: string; history: unknown[] }>;
}

/**
 * Helper: look up session by ID, throw if missing.
 */
function requireSession(deps: SessionServiceDeps, sessionId: string | undefined) {
  if (!sessionId) {
    throw new Error('sessionId is required');
  }
  const agentSession = deps.registry.getSession(sessionId);
  if (!agentSession?.agent) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return agentSession;
}

export function createSessionServices(deps: SessionServiceDeps): Record<string, ServiceHandler> {
  const { registry, resetTabs } = deps;

  return {
    /**
     * Get state for a specific session.
     * Requires: { sessionId: string }
     */
    'session.getState': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      const agentSession = requireSession(deps, sessionId);

      return {
        ...agentSession.getState(),
        activeSessionCount: registry.getActiveCount(),
        maxConcurrentSessions: registry.getMaxConcurrent(),
      };
    },

    /**
     * Reset a specific session.
     * Requires: { sessionId: string }
     */
    'session.reset': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      const agentSession = requireSession(deps, sessionId);

      await agentSession.reset();

      if (resetTabs) {
        await resetTabs();
      }

      return { timestamp: Date.now() };
    },

    /**
     * Resume a session from stored history.
     * Requires: { sessionId: string }
     */
    'session.resume': async (params) => {
      if (!deps.resumeSession) {
        throw new Error('Session resume not supported on this platform');
      }
      const { sessionId } = params as { sessionId: string };
      if (!sessionId) {
        throw new Error('sessionId is required');
      }
      return deps.resumeSession(sessionId);
    },

    /**
     * List all active sessions (no sessionId needed — registry-level query).
     */
    'session.list': async () => {
      return {
        sessions: registry.listSessions(),
        maxConcurrent: registry.getMaxConcurrent(),
        activeCount: registry.getActiveCount(),
      };
    },

    /**
     * Get active session count (registry-level query).
     */
    'session.getActiveCount': async () => {
      return {
        activeCount: registry.getActiveCount(),
        maxConcurrent: registry.getMaxConcurrent(),
        canCreateSession: registry.canCreateSession(),
      };
    },

    /**
     * Create a new session.
     */
    'session.create': async () => {
      if (!registry.canCreateSession()) {
        return { success: false, error: 'Maximum concurrent sessions reached' };
      }

      const session = await registry.createSession({ type: 'primary' });

      // Ensure backend routing configured properly for this new session
      if (session?.agent) {
        const agentSession = registry.getSession(session.sessionId);
        if (agentSession?.agent) {
          await agentSession.agent.refreshModelClient();
        }
      }

      return {
        success: true,
        sessionId: session.sessionId,
        sessionLetter: session.sessionLetter,
      };
    },

    /**
     * Set max concurrent session limit (registry-level).
     */
    'session.setMaxConcurrent': async (params) => {
      const { maxConcurrent } = params as { maxConcurrent: number };
      if (typeof maxConcurrent !== 'number') {
        throw new Error('maxConcurrent must be a number');
      }
      registry.setMaxConcurrent(maxConcurrent);
      return { success: true };
    },

    /**
     * Close/terminate a specific session.
     * Requires: { sessionId: string }
     */
    'session.close': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) {
        return { success: false, error: 'sessionId is required' };
      }

      await registry.removeSession(sessionId);
      return { success: true };
    },
  };
}
