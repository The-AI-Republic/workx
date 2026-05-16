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
import type { RepublicAgent } from '@/core/RepublicAgent';
import type { ResponseItem } from '@/core/protocol/types';
import {
  listUserTurns,
  computeRewindSlice,
  buildSummarizedFork,
} from '@/core/session/rewind';

export interface SessionServiceDeps {
  /** Registry for multi-session management (required). */
  registry: {
    listSessions(): unknown[];
    getMaxConcurrent(): number;
    getActiveCount(): number;
    canCreateSession(): boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSession(config: any): Promise<{ sessionId: string; sessionLetter: string; agent: RepublicAgent | null }>;
    removeSession(sessionId: string): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSession(sessionId: string): any;
    getPrimarySession(): { sessionId: string } | undefined;
    setMaxConcurrent(limit: number): void;
  };

  /** Callback for platform-specific tab reset (extension-only) */
  resetTabs?: () => Promise<void>;

  /** Load rollout history for a session ID (platform-specific storage) */
  loadRolloutHistory?: (sessionId: string) => Promise<{ sessionId: string; rolloutItems: unknown[] } | null>;

  /**
   * Track 15 (D9): summarize response items for `summarize_up_to` rewind.
   * Platform-injected so the model client is sourced from the platform's
   * existing per-agent ModelClientFactory, never constructed in core.
   * Returns undefined on failure → caller falls back to a plain slice.
   */
  summarizeForRewind?: (items: ResponseItem[]) => Promise<string | undefined>;
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
     * Loads rollout history, closes the current primary session if one exists,
     * and creates a new session via the registry.
     * Requires: { sessionId: string }
     */
    'session.resume': async (params) => {
      if (!deps.loadRolloutHistory) {
        throw new Error('Session resume not supported on this platform');
      }
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) {
        throw new Error('sessionId is required');
      }

      // Load rollout history from platform storage
      const rolloutData = await deps.loadRolloutHistory(sessionId);
      if (!rolloutData) {
        throw new Error('Conversation not found or has no history');
      }

      // Close existing primary session before creating the resumed one
      const primarySession = registry.getPrimarySession();
      if (primarySession) {
        await registry.removeSession(primarySession.sessionId);
      }

      // Create new session with resume data
      const newSession = await registry.createSession({
        type: 'primary',
        resume: {
          sessionId: rolloutData.sessionId,
          rolloutItems: rolloutData.rolloutItems,
        },
      });

      // Read history from the new session's agent
      if (!newSession.agent) {
        throw new Error('Failed to create agent for resumed session');
      }
      const history = newSession.agent.getSession().getConversationHistory();
      return { sessionId: rolloutData.sessionId, history: history?.items ?? [] };
    },

    /**
     * Track 15: list the current primary conversation's user turns so the
     * rewind selector can pick a target. Flushes the live source session
     * first (D13) so the newest in-flight turns are visible.
     */
    'session.turns': async () => {
      const primary = registry.getPrimarySession();
      if (!primary) {
        return { turns: [] };
      }
      await registry.getSession(primary.sessionId)?.agent?.getSession()?.flushRollout?.();
      const turns = await listUserTurns(primary.sessionId);
      return { turns };
    },

    /**
     * Track 15: rewind/fork the current primary conversation to an earlier
     * user turn. Forks a NEW conversation (source untouched); the in-flight
     * turn is aborted by removeSession (D7). Returns the NEW conversation id
     * — the UI must re-target it.
     * Requires: { targetSequence: number, mode?: 'conversation'|'summarize_up_to' }
     */
    'session.rewind': async (params) => {
      const { targetSequence, mode } = (params ?? {}) as {
        targetSequence?: number;
        mode?: 'conversation' | 'summarize_up_to';
      };
      if (typeof targetSequence !== 'number') {
        throw new Error('targetSequence is required');
      }
      const primary = registry.getPrimarySession();
      if (!primary) {
        throw new Error('No active conversation to rewind');
      }
      const sourceConvId = primary.sessionId;

      // D13: flush the live source session so the slice sees all turns.
      await registry.getSession(sourceConvId)?.agent?.getSession()?.flushRollout?.();

      // Capture the rewound-to user-turn text BEFORE re-seating (D8).
      const turns = await listUserTurns(sourceConvId);
      const rewoundText =
        mode === 'summarize_up_to'
          ? undefined
          : turns.find((tn) => tn.sequence === targetSequence)?.text;

      // Build the forked history (summarize before removeSession so the
      // source agent's model client is still alive — D9). If the caller asked
      // to summarize but no summarizer is wired, fail loudly rather than
      // silently producing a full conversation fork (design doc §103).
      let forked;
      if (mode === 'summarize_up_to') {
        if (!deps.summarizeForRewind) {
          throw new Error(
            'summarize_up_to is unavailable: no summarizer is configured for this platform',
          );
        }
        forked = await buildSummarizedFork(
          sourceConvId,
          targetSequence,
          deps.summarizeForRewind,
        );
      } else {
        forked = await computeRewindSlice(sourceConvId, targetSequence);
      }

      // Abort + close the source session (D7), then create the fork.
      await registry.removeSession(sourceConvId);
      const newSession = await registry.createSession({
        type: 'primary',
        fork: {
          sourceConversationId: forked.sourceConversationId,
          rolloutItems: forked.rolloutItems,
        },
      });
      if (!newSession.agent) {
        throw new Error('Failed to create agent for rewound session');
      }
      const history = newSession.agent.getSession().getConversationHistory();
      return {
        sessionId: newSession.sessionId,
        history: history?.items ?? [],
        rewoundText,
      };
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
