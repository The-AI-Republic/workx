/**
 * Canonical webfront projection for multi-thread session management.
 *
 * Durable index/runtime data is supplied by the backend. Conversation buffers,
 * replay cursors and pending sends are surface-local. Only the selected session
 * id is persisted locally; the index is never duplicated into config storage.
 */

import { derived, get, writable, type Writable } from 'svelte/store';
import { getConfigStorage, isConfigStorageInitialized } from '@/core/storage/ConfigStorageProvider';
import type { AgentMode } from '@/prompts/PromptComposer';
import type { EventProcessor } from '../components/event_display/EventProcessor';
import type { ThreadIndexEntry } from '@/core/thread/ThreadIndexStore';
import type { SessionRuntimeView, SubmitAck } from '@/core/registry/types';
import {
  emptyTimeline,
  type ConversationTimeline,
} from '../lib/conversationTimeline';

export interface ThreadConversationState {
  timeline: ConversationTimeline;
  inputText: string;
  isProcessing: boolean;
  currentTabId: number;
  eventProcessor?: EventProcessor;
}

export interface ThreadAttachState {
  cursor: { runtimeEpoch: string; eventSeq: number } | null;
  snapshotRevision: number;
  historyCursor: number | null;
  replayTruncated: boolean;
  error: { message: string; retryable: boolean } | null;
  attaching: boolean;
}

export interface PendingSubmission {
  clientMessageId: string;
  status: 'sending' | 'queued' | 'accepted' | 'failed' | 'delivery-unknown';
  text: string;
  createdAt: number;
  submissionId?: string;
  position?: number;
  phase?: 'capacity' | 'hydration' | 'suspension';
  reason?: string;
}

/** One row contains every piece of UI state for a conversation. */
export interface SidePanelThread extends ThreadIndexEntry {
  runtime: SessionRuntimeView;
  conversation: ThreadConversationState;
  attach: ThreadAttachState;
  pendingSubmissions: PendingSubmission[];
  pendingMode?: AgentMode | null;
  attentionRequest?: {
    requestId: string;
    tabId: number;
    reason: 'login' | 'permission' | 'user-gesture';
    expiresAt: number;
  };
}

export interface ThreadStoreState {
  threads: SidePanelThread[];
  activeSessionId: string | null;
  nextCursor: string | null;
  query: string;
  loading: boolean;
  pageDirty: boolean;
}

const STORAGE_KEY = 'workx_sidepanel_threads';
/** Stable for this web document and shared by every component in the surface. */
export const documentSurfaceId = crypto.randomUUID();

const DEFAULT_RUNTIME: SessionRuntimeView = {
  state: 'suspended',
  awaitingInputCount: 0,
  awaitingInputKinds: [],
  durability: 'ok',
};

function emptyConversation(): ThreadConversationState {
  return {
    timeline: emptyTimeline(),
    inputText: '',
    isProcessing: false,
    currentTabId: -1,
  };
}

function emptyAttach(): ThreadAttachState {
  return {
    cursor: null,
    snapshotRevision: 0,
    historyCursor: null,
    replayTruncated: false,
    error: null,
    attaching: false,
  };
}

function placeholderEntry(sessionId: string, title = ''): ThreadIndexEntry {
  const now = Date.now();
  return {
    sessionId,
    title,
    searchTitle: title.trim().normalize('NFKC').toLowerCase(),
    titleSource: null,
    titleUpdatedAt: now,
    createdAt: now,
    lastActiveAt: now,
    pinned: false,
    deletedAt: null,
    purgeAfter: null,
    agentMode: 'general',
    origin: { kind: 'new' },
    schemaVersion: 1,
  };
}

function projectEntry(
  entry: ThreadIndexEntry,
  runtime: SessionRuntimeView = DEFAULT_RUNTIME,
  previous?: SidePanelThread,
): SidePanelThread {
  return {
    ...entry,
    runtime: { ...runtime, awaitingInputKinds: [...runtime.awaitingInputKinds] },
    conversation: previous?.conversation ?? emptyConversation(),
    attach: previous?.attach ?? emptyAttach(),
    pendingSubmissions: previous?.pendingSubmissions ?? [],
    pendingMode: previous?.pendingMode ?? null,
    ...(previous?.attentionRequest ? { attentionRequest: previous.attentionRequest } : {}),
  };
}

function compareThreads(a: SidePanelThread, b: SidePanelThread): number {
  return Number(b.pinned) - Number(a.pinned)
    || b.lastActiveAt - a.lastActiveAt
    || a.sessionId.localeCompare(b.sessionId);
}

function createThreadStore() {
  const initialState: ThreadStoreState = {
    threads: [],
    activeSessionId: null,
    nextCursor: null,
    query: '',
    loading: false,
    pageDirty: false,
  };
  const { subscribe, set, update }: Writable<ThreadStoreState> = writable(initialState);

  const mutateThread = (sessionId: string, mutate: (thread: SidePanelThread) => SidePanelThread): void => {
    update((state) => ({
      ...state,
      threads: state.threads.map((thread) => thread.sessionId === sessionId ? mutate(thread) : thread),
    }));
  };

  const persistSelection = async (): Promise<void> => {
    try {
      if (!isConfigStorageInitialized()) return;
      await getConfigStorage().set(STORAGE_KEY, { activeSessionId: get({ subscribe }).activeSessionId });
    } catch (error) {
      console.error('[ThreadStore] Failed to persist selection:', error);
    }
  };

  return {
    subscribe,

    mergePage(
      entries: Array<ThreadIndexEntry & { runtime?: SessionRuntimeView }>,
      nextCursor: string | null,
      options: { reset?: boolean; query?: string } = {},
    ): void {
      update((state) => {
        const previous = new Map(state.threads.map((thread) => [thread.sessionId, thread]));
        // A backend search/page reset must not discard the selected row's
        // surface-local buffers merely because the row is outside this page.
        const base = options.reset
          ? state.threads.filter((thread) => thread.sessionId === state.activeSessionId)
          : state.threads;
        const merged = new Map(base.map((thread) => [thread.sessionId, thread]));
        for (const entry of entries) {
          if (entry.deletedAt !== null) {
            merged.delete(entry.sessionId);
            continue;
          }
          const { runtime = DEFAULT_RUNTIME, ...indexEntry } = entry;
          merged.set(entry.sessionId, projectEntry(indexEntry, runtime, previous.get(entry.sessionId)));
        }
        return {
          ...state,
          threads: [...merged.values()].sort(compareThreads),
          nextCursor,
          query: options.query ?? state.query,
          loading: false,
          pageDirty: false,
        };
      });
    },

    mergeThread(entry: ThreadIndexEntry & { runtime?: SessionRuntimeView }): SidePanelThread {
      let result!: SidePanelThread;
      update((state) => {
        const previous = state.threads.find((thread) => thread.sessionId === entry.sessionId);
        const { runtime = previous?.runtime ?? DEFAULT_RUNTIME, ...indexEntry } = entry;
        result = projectEntry(indexEntry, runtime, previous);
        const threads = state.threads.filter((thread) => thread.sessionId !== entry.sessionId);
        if (result.deletedAt === null) threads.push(result);
        return { ...state, threads: threads.sort(compareThreads) };
      });
      return result;
    },

    createThread(sessionId: string, title = ''): SidePanelThread {
      const created = projectEntry(placeholderEntry(sessionId, title));
      update((state) => ({
        ...state,
        threads: [...state.threads.filter((thread) => thread.sessionId !== sessionId), created].sort(compareThreads),
        activeSessionId: sessionId,
      }));
      void persistSelection();
      return created;
    },

    getThread(sessionId: string): SidePanelThread | undefined {
      return get({ subscribe }).threads.find((thread) => thread.sessionId === sessionId);
    },

    getActiveThread(): SidePanelThread | undefined {
      const state = get({ subscribe });
      return state.threads.find((thread) => thread.sessionId === state.activeSessionId);
    },

    setActiveThread(sessionId: string): void {
      update((state) => ({ ...state, activeSessionId: sessionId }));
      void persistSelection();
    },

    setConversation(sessionId: string, conversation: ThreadConversationState): void {
      mutateThread(sessionId, (thread) => ({ ...thread, conversation }));
    },

    patchConversation(sessionId: string, patch: Partial<ThreadConversationState>): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        conversation: { ...thread.conversation, ...patch },
      }));
    },

    setAttach(sessionId: string, patch: Partial<ThreadAttachState>): void {
      mutateThread(sessionId, (thread) => ({ ...thread, attach: { ...thread.attach, ...patch } }));
    },

    setRuntime(sessionId: string, runtime: SessionRuntimeView): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        runtime: { ...runtime, awaitingInputKinds: [...runtime.awaitingInputKinds] },
      }));
    },

    ensureRuntimeStub(sessionId: string, runtime: SessionRuntimeView): void {
      if (!get({ subscribe }).threads.some((thread) => thread.sessionId === sessionId)) {
        this.mergeThread({ ...placeholderEntry(sessionId), runtime });
      } else {
        this.setRuntime(sessionId, runtime);
      }
    },

    setAttention(sessionId: string, attentionRequest?: SidePanelThread['attentionRequest']): void {
      mutateThread(sessionId, (thread) => ({ ...thread, attentionRequest }));
    },

    beginSubmission(sessionId: string, pending: PendingSubmission): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: [
          ...thread.pendingSubmissions.filter((item) => item.clientMessageId !== pending.clientMessageId),
          pending,
        ],
      }));
    },

    applySubmitAck(sessionId: string, ack: SubmitAck): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: thread.pendingSubmissions.map((item) => item.clientMessageId !== ack.clientMessageId
          ? item
          : ack.status === 'accepted'
            ? { ...item, status: 'accepted', submissionId: ack.submissionId, reason: undefined }
            : ack.status === 'queued'
              ? { ...item, status: 'queued', position: ack.position, phase: ack.phase, reason: undefined }
              : { ...item, status: 'failed', reason: ack.reason }),
      }));
    },

    settleSubmission(
      sessionId: string,
      clientMessageId: string,
      state: 'accepted' | 'failed',
      submissionId?: string,
      reason?: string,
    ): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: thread.pendingSubmissions.map((item) => item.clientMessageId === clientMessageId
          ? { ...item, status: state, submissionId, reason }
          : item),
      }));
    },

    markOrphansDeliveryUnknown(sessionId: string): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: thread.pendingSubmissions.map((item) =>
          item.status === 'sending' || item.status === 'queued'
            ? { ...item, status: 'delivery-unknown' }
            : item),
      }));
    },

    reconcileSubmissions(
      sessionId: string,
      acceptedClientMessageIds: ReadonlySet<string>,
      completedClientMessageIds: ReadonlySet<string>,
      markUnknown: boolean,
    ): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: thread.pendingSubmissions
          .filter((item) => !completedClientMessageIds.has(item.clientMessageId))
          .map((item) => {
            if (acceptedClientMessageIds.has(item.clientMessageId)) {
              return { ...item, status: 'accepted' as const, reason: undefined };
            }
            if (markUnknown && (item.status === 'sending' || item.status === 'queued')) {
              return { ...item, status: 'delivery-unknown' as const };
            }
            return item;
          }),
      }));
    },

    dismissSubmission(sessionId: string, clientMessageId: string): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        pendingSubmissions: thread.pendingSubmissions.filter(
          (item) => item.clientMessageId !== clientMessageId,
        ),
      }));
    },

    updateThreadTitle(sessionId: string, title: string): void {
      mutateThread(sessionId, (thread) => ({
        ...thread,
        title,
        searchTitle: title.trim().normalize('NFKC').toLowerCase(),
      }));
    },

    setThreadMode(sessionId: string, mode: AgentMode): void {
      mutateThread(sessionId, (thread) => ({ ...thread, agentMode: mode, pendingMode: null }));
    },

    setThreadPendingMode(sessionId: string, mode: AgentMode | null): void {
      mutateThread(sessionId, (thread) => ({ ...thread, pendingMode: mode }));
    },

    markPageDirty(): void {
      update((state) => ({ ...state, pageDirty: true }));
    },

    setLoading(loading: boolean): void {
      update((state) => ({ ...state, loading }));
    },

    closeThread(sessionId: string): void {
      update((state) => {
        const index = state.threads.findIndex((thread) => thread.sessionId === sessionId);
        if (index < 0) return state;
        const threads = state.threads.filter((thread) => thread.sessionId !== sessionId);
        const activeSessionId = state.activeSessionId === sessionId
          ? threads[Math.min(index, Math.max(0, threads.length - 1))]?.sessionId ?? null
          : state.activeSessionId;
        return { ...state, threads, activeSessionId };
      });
      void persistSelection();
    },

    removeThread(sessionId: string): void {
      this.closeThread(sessionId);
    },

    async restoreThreads(): Promise<ThreadStoreState> {
      try {
        if (!isConfigStorageInitialized()) return get({ subscribe });
        const stored = await getConfigStorage().get<{ activeSessionId?: string | null }>(STORAGE_KEY);
        if (stored && typeof stored.activeSessionId === 'string') {
          update((state) => ({ ...state, activeSessionId: stored.activeSessionId ?? null }));
        }
      } catch (error) {
        console.error('[ThreadStore] Failed to restore selection:', error);
      }
      return get({ subscribe });
    },

    clear(): void {
      set(initialState);
      void persistSelection();
    },

    setState(state: ThreadStoreState): void {
      set(state);
      void persistSelection();
    },
  };
}

export const threadStore = createThreadStore();
export const activeThread = derived(threadStore, ($store) =>
  $store.threads.find((thread) => thread.sessionId === $store.activeSessionId));
export const threadCount = derived(threadStore, ($store) => $store.threads.length);
export const attentionCount = derived(threadStore, ($store) =>
  $store.threads.reduce((count, thread) => count + Number(thread.runtime.awaitingInputCount > 0), 0));
