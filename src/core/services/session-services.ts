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
import { RolloutRecorder, type Cursor } from '@/storage/rollout';
import { RolloutForkWriter } from '@/core/thread/RolloutForkWriter';
import { SessionServiceError } from './SessionServiceError';

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
    setMaxConcurrent(limit: number): void;
    openSession?(options?: Record<string, unknown>): Promise<any>;
    hydrateSession?(sessionId: string): Promise<any>;
    submitToSession?(sessionId: string, op: any): Promise<string>;
    enqueueSubmission?(input: {
      sessionId: string;
      clientMessageId: string;
      op: Extract<import('@/core/protocol/types').Op, { type: 'UserInput' }>;
      tabId?: number;
    }): Promise<any>;
    listThreads?(request?: Record<string, unknown>): Promise<any>;
    getThread?(sessionId: string, includeDeleted?: boolean): Promise<any>;
    renameThread?(sessionId: string, title: string): Promise<any>;
    pinThread?(sessionId: string, pinned: boolean): Promise<any>;
    deleteThread?(sessionId: string, abortRunning?: boolean): Promise<any>;
    undeleteThread?(sessionId: string): Promise<any>;
    setThreadMode?(sessionId: string, mode: 'general' | 'code'): Promise<any>;
    suspendSession?(sessionId: string): Promise<boolean>;
    compatCloseSession?(sessionId: string): Promise<boolean>;
    setViewed?(surfaceId: string, sessionId: string): Promise<any>;
    heartbeatSurface?(surfaceId: string, leaseId: string): Promise<any>;
    releaseSurface?(surfaceId: string, leaseId: string): Promise<boolean>;
    resolveAttention?(surfaceId: string, requestId: string): Promise<any>;
    attachSession?(sessionId: string, after?: { runtimeEpoch: string; eventSeq: number }): Promise<any>;
  };

  /** Load rollout history for a session ID (platform-specific storage) */
  loadRolloutHistory?: (sessionId: string) => Promise<{ sessionId: string; rolloutItems: unknown[] } | null>;

  /**
   * Track 15 (D9): summarize response items for `summarize_up_to` rewind.
   * Platform-injected so the model client is sourced from the platform's
   * existing per-agent ModelClientFactory, never constructed in core.
   * Returns undefined on failure → caller falls back to a plain slice.
   */
  summarizeForRewind?: (sessionId: string, items: ResponseItem[]) => Promise<string | undefined>;
}

/**
 * Helper: look up session by ID, throw if missing.
 */
function requireSession(deps: SessionServiceDeps, sessionId: string | undefined) {
  if (!sessionId) {
    throw new SessionServiceError('INVALID_ARGUMENT', 'sessionId is required');
  }
  const agentSession = deps.registry.getSession(sessionId);
  if (!agentSession?.agent) {
    throw new SessionServiceError('SESSION_NOT_LIVE', `Session not live: ${sessionId}`, true);
  }
  return agentSession;
}

export function createSessionServices(deps: SessionServiceDeps): Record<string, ServiceHandler> {
  const { registry } = deps;

  return {
    'session.open': async (params) => {
      if (!registry.openSession) throw new Error('Index-only session open is unavailable');
      return registry.openSession((params ?? {}) as Record<string, unknown>);
    },

    'session.hydrate': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) throw new Error('sessionId is required');
      if (!registry.hydrateSession) throw new Error('Managed session hydration is unavailable');
      await registry.hydrateSession(sessionId);
      return { success: true, sessionId };
    },

    'session.get': async (params) => {
      const { sessionId, includeDeleted } = (params ?? {}) as {
        sessionId?: string;
        includeDeleted?: boolean;
      };
      if (!sessionId) throw new Error('sessionId is required');
      if (!registry.getThread) throw new Error('Thread index is unavailable');
      return { entry: await registry.getThread(sessionId, includeDeleted) };
    },

    'session.getRollout': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) throw new Error('sessionId is required');
      const provider = await RolloutRecorder.getProvider();
      const metadata = await provider.getMetadata(sessionId);
      const records = metadata ? await provider.getItemsByRolloutId(sessionId) : [];
      return {
        sessionId,
        revision: metadata?.itemCount ?? 0,
        items: records.map((record) => ({ type: record.type, payload: record.payload })),
      };
    },

    'session.submit': async (params) => {
      const { sessionId, clientMessageId, items, tabId } = (params ?? {}) as {
        sessionId?: string;
        clientMessageId?: string;
        items?: Extract<import('@/core/protocol/types').Op, { type: 'UserInput' }>['items'];
        tabId?: number;
      };
      if (!sessionId) throw new Error('sessionId is required');
      if (!clientMessageId) throw new Error('clientMessageId is required');
      if (!items) throw new Error('items are required');
      if (registry.enqueueSubmission) {
        return registry.enqueueSubmission({
          sessionId,
          clientMessageId,
          op: { type: 'UserInput', items },
          tabId,
        });
      }
      if (!registry.submitToSession) throw new Error('Managed session submit is unavailable');
      const submissionId = await registry.submitToSession(sessionId, { type: 'UserInput', items });
      return { status: 'accepted', clientMessageId, submissionId };
    },

    'session.attach': async (params) => {
      const { sessionId, surfaceId, after, cursor } = (params ?? {}) as {
        sessionId?: string;
        surfaceId?: string;
        after?: { runtimeEpoch: string; eventSeq: number };
        cursor?: { runtimeEpoch: string; eventSeq: number };
      };
      if (!sessionId) throw new Error('sessionId is required');
      if (surfaceId && registry.setViewed) await registry.setViewed(surfaceId, sessionId);
      if (!registry.attachSession) throw new Error('Session attach is unavailable');
      return registry.attachSession(sessionId, after ?? cursor);
    },

    /**
     * Track 29: list typed background task states for a session.
     */
    'session.listTaskStates': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      const agentSession = requireSession(deps, sessionId);
      return { tasks: agentSession.agent.getSession().listTaskStates() };
    },

    /**
     * Track 29: read append-only background task output chunks.
     */
    'session.getTaskOutput': async (params) => {
      const { sessionId, taskId, fromSeq } = (params ?? {}) as {
        sessionId?: string;
        taskId?: string;
        fromSeq?: number;
      };
      if (!taskId) throw new Error('taskId is required');
      const agentSession = requireSession(deps, sessionId);
      const chunks = await agentSession.agent.getEngine()?.getTaskOutput(taskId, fromSeq ?? 0) ?? [];
      return { chunks };
    },

    /**
     * Track 29: retain/release terminal task output while a panel is mounted.
     */
    'session.retainTask': async (params) => {
      const { sessionId, taskId, retain } = (params ?? {}) as {
        sessionId?: string;
        taskId?: string;
        retain?: boolean;
      };
      if (!taskId) throw new Error('taskId is required');
      const agentSession = requireSession(deps, sessionId);
      agentSession.agent.getEngine()?.retainTask(taskId, retain !== false);
      return { success: true };
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

      if (registry.openSession && registry.hydrateSession) {
        await registry.openSession({ sessionId: rolloutData.sessionId });
        const hydrated = await registry.hydrateSession(rolloutData.sessionId);
        const history = hydrated.agent?.getSession().getConversationHistory();
        return { sessionId: rolloutData.sessionId, history: history?.items ?? [] };
      }

      // Eager compatibility path preserves all other sessions.
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
     * List persisted conversations (rollouts) with cursor-based pagination.
     * Rollout storage resolves per platform where this service runs: the
     * extension service worker uses IndexedDB, the desktop runtime sidecar
     * and server use SQLite. The desktop WebView cannot read rollout storage
     * directly (it is owned by the runtime sidecar), so its chat-history UI
     * reaches the data through this service.
     * Params: { pageSize?: number; cursor?: { timestamp: number; id: string } }
     */
    'session.listConversations': async (params) => {
      const { pageSize = 20, cursor } = (params ?? {}) as {
        pageSize?: number;
        cursor?: Cursor;
      };
      return await RolloutRecorder.listConversations(pageSize, cursor);
    },

    /**
     * Track 15: list the current primary conversation's user turns so the
     * rewind selector can pick a target. Flushes the live source session
     * first (D13) so the newest in-flight turns are visible.
     */
    'session.turns': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) throw new Error('sessionId is required');
      await registry.getSession(sessionId)?.agent?.getSession()?.flushRollout?.();
      const turns = await listUserTurns(sessionId);
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
      const { sessionId, targetSequence, mode } = (params ?? {}) as {
        sessionId?: string;
        targetSequence?: number;
        mode?: 'conversation' | 'summarize_up_to';
      };
      if (typeof targetSequence !== 'number') {
        throw new Error('targetSequence is required');
      }
      if (!sessionId) throw new Error('sessionId is required');
      const sourceConvId = sessionId;

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
          (items) => deps.summarizeForRewind!(sourceConvId, items),
        );
      } else {
        forked = await computeRewindSlice(sourceConvId, targetSequence);
      }

      const reservedSessionId = crypto.randomUUID();
      if (registry.openSession) {
        await RolloutForkWriter.write({
          sessionId: reservedSessionId,
          sourceSessionId: forked.sourceConversationId,
          items: forked.rolloutItems,
        });
        await registry.openSession({
          sessionId: reservedSessionId,
          origin: { kind: 'fork', sourceSessionId: forked.sourceConversationId },
        });
        return {
          sessionId: reservedSessionId,
          history: forked.rolloutItems,
          rewoundText,
        };
      }

      // Eager compatibility path still preserves the source runtime.
      const newSession = await registry.createSession({
        type: 'primary',
        sessionId: reservedSessionId,
        fork: {
          sessionId: reservedSessionId,
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
    'session.list': async (params) => {
      if (registry.listThreads) {
        const page = await registry.listThreads((params ?? {}) as Record<string, unknown>);
        return {
          ...page,
          sessions: registry.listSessions(),
          maxConcurrent: registry.getMaxConcurrent(),
          activeCount: registry.getActiveCount(),
        };
      }
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
      if (registry.openSession) {
        const opened = await registry.openSession();
        return { success: true, sessionId: opened.sessionId, state: opened.state };
      }
      if (!registry.canCreateSession()) {
        return { success: false, error: 'Maximum concurrent sessions reached' };
      }

      const session = await registry.createSession({ type: 'primary' });

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

      if (registry.compatCloseSession) {
        await registry.compatCloseSession(sessionId);
      } else if (registry.suspendSession) {
        await registry.suspendSession(sessionId);
      } else {
        await registry.removeSession(sessionId);
      }
      return { success: true };
    },

    'session.pin': async (params) => {
      const { sessionId, pinned } = (params ?? {}) as { sessionId?: string; pinned?: boolean };
      if (!sessionId || typeof pinned !== 'boolean') throw new Error('sessionId and pinned are required');
      if (!registry.pinThread) throw new Error('Thread index is unavailable');
      return registry.pinThread(sessionId, pinned);
    },

    'session.rename': async (params) => {
      const { sessionId, title } = (params ?? {}) as { sessionId?: string; title?: string };
      if (!sessionId || typeof title !== 'string') throw new Error('sessionId and title are required');
      if (!registry.renameThread) throw new Error('Thread index is unavailable');
      return registry.renameThread(sessionId, title);
    },

    'session.delete': async (params) => {
      const { sessionId, abortRunning } = (params ?? {}) as {
        sessionId?: string;
        abortRunning?: boolean;
      };
      if (!sessionId) throw new Error('sessionId is required');
      if (!registry.deleteThread) throw new Error('Thread index is unavailable');
      return registry.deleteThread(sessionId, abortRunning);
    },

    'session.undelete': async (params) => {
      const { sessionId } = (params ?? {}) as { sessionId?: string };
      if (!sessionId) throw new Error('sessionId is required');
      if (!registry.undeleteThread) throw new Error('Thread index is unavailable');
      return registry.undeleteThread(sessionId);
    },

    'session.setMode': async (params) => {
      const { sessionId, mode } = (params ?? {}) as {
        sessionId?: string;
        mode?: 'general' | 'code';
      };
      if (!sessionId || (mode !== 'general' && mode !== 'code')) {
        throw new Error('sessionId and a valid mode are required');
      }
      if (!registry.setThreadMode) throw new Error('Thread index is unavailable');
      return { entry: await registry.setThreadMode(sessionId, mode) };
    },

    'session.setViewed': async (params) => {
      const { surfaceId, sessionId } = (params ?? {}) as {
        surfaceId?: string;
        sessionId?: string;
      };
      if (!surfaceId || !sessionId) throw new Error('surfaceId and sessionId are required');
      if (!registry.setViewed) throw new Error('Surface leases are unavailable');
      await registry.getThread?.(sessionId);
      return { lease: await registry.setViewed(surfaceId, sessionId) };
    },

    'session.heartbeat': async (params) => {
      const { surfaceId, leaseId } = (params ?? {}) as { surfaceId?: string; leaseId?: string };
      if (!surfaceId || !leaseId) throw new Error('surfaceId and leaseId are required');
      if (!registry.heartbeatSurface) throw new Error('Surface leases are unavailable');
      return { lease: await registry.heartbeatSurface(surfaceId, leaseId) };
    },

    'session.releaseSurface': async (params) => {
      const { surfaceId, leaseId } = (params ?? {}) as { surfaceId?: string; leaseId?: string };
      if (!surfaceId || !leaseId) throw new Error('surfaceId and leaseId are required');
      if (!registry.releaseSurface) throw new Error('Surface leases are unavailable');
      return { released: await registry.releaseSurface(surfaceId, leaseId) };
    },

    'session.resolveAttention': async (params) => {
      const { surfaceId, requestId } = (params ?? {}) as {
        surfaceId?: string;
        requestId?: string;
      };
      if (!surfaceId || !requestId) throw new Error('surfaceId and requestId are required');
      if (!registry.resolveAttention) throw new Error('Foreground attention is unavailable');
      return registry.resolveAttention(surfaceId, requestId);
    },
  };
}
