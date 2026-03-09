/**
 * Session Service Handlers
 *
 * Platform-agnostic service handlers for session management.
 * Extracted from extension service-worker setupMessageHandlers() and setupSessionMessageHandlers().
 *
 * @module core/services/session-services
 */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface SessionServiceDeps {
  getAgent: () => {
    getSession(): {
      conversationId: string;
      isActiveTurn(): boolean;
      getTabId(): number;
      getConversationHistory(): { items: unknown[] };
      abortAllTasks(reason: string): Promise<void>;
      reset(): Promise<void>;
      close(): Promise<void>;
      initialize(): Promise<void>;
    };
    isReady(): Promise<unknown>;
  } | null;

  /** Registry for multi-session management (Feature 015). Optional. */
  registry?: {
    listSessions(): unknown[];
    getMaxConcurrent(): number;
    getActiveCount(): number;
    canCreateSession(): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession(config: any): Promise<{ sessionId: string; sessionLetter: string; agent: unknown }>;
    removeSession(sessionId: string): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSession(sessionId: string): any;
  } | null;

  /** Callback for platform-specific tab reset (extension-only) */
  resetTabs?: () => Promise<void>;

  /** Resume a session from stored history */
  resumeSession?: (conversationId: string) => Promise<{ conversationId: string; history: unknown[] }>;
}

export function createSessionServices(deps: SessionServiceDeps): Record<string, ServiceHandler> {
  const { getAgent, registry, resetTabs } = deps;

  return {
    'session.getState': async () => {
      const agent = getAgent();
      if (!agent) return null;

      const session = agent.getSession();
      const tabId = session.getTabId();
      const conversationHistory = session.getConversationHistory();

      return {
        sessionId: session.conversationId,
        isActiveTurn: session.isActiveTurn(),
        tabId,
        history: conversationHistory.items,
        activeSessionCount: registry?.getActiveCount() ?? 0,
        maxConcurrentSessions: registry?.getMaxConcurrent() ?? 3,
      };
    },

    'session.reset': async () => {
      const agent = getAgent();
      if (!agent) throw new Error('Agent not initialized');

      const session = agent.getSession();
      await session.abortAllTasks('UserInterrupt');

      if (resetTabs) {
        await resetTabs();
      }

      await session.reset();
      return { timestamp: Date.now() };
    },

    'session.resume': async (params) => {
      if (!deps.resumeSession) {
        throw new Error('Session resume not supported on this platform');
      }
      const { conversationId } = params as { conversationId: string };
      return deps.resumeSession(conversationId);
    },

    'session.list': async () => {
      if (!registry) {
        return { sessions: [], maxConcurrent: 1, activeCount: 0 };
      }
      return {
        sessions: registry.listSessions(),
        maxConcurrent: registry.getMaxConcurrent(),
        activeCount: registry.getActiveCount(),
      };
    },

    'session.getActiveCount': async () => {
      if (!registry) {
        return { activeCount: 0, maxConcurrent: 1, canCreateSession: false };
      }
      return {
        activeCount: registry.getActiveCount(),
        maxConcurrent: registry.getMaxConcurrent(),
        canCreateSession: registry.canCreateSession(),
      };
    },

    'session.create': async () => {
      if (!registry) {
        return { success: false, error: 'Registry not initialized' };
      }

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

    'session.close': async (params) => {
      if (!registry) {
        return { success: false, error: 'Registry not initialized' };
      }

      const { sessionId } = params as { sessionId: string };
      if (!sessionId) {
        return { success: false, error: 'sessionId is required' };
      }

      await registry.removeSession(sessionId);
      return { success: true };
    },
  };
}
