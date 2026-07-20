import { get, writable, type Writable } from 'svelte/store';
import type { Event } from '@/core/protocol/types';
import type {
  LocalFilePreviewItem,
  LocalFilePreviewView,
  ThreadPreviewState,
} from '@/types/ui';
import {
  defaultPreviewView,
  localFilePreviewItemFromEvent,
} from '../components/preview/model';

export const MAX_PREVIEW_ITEMS = 20;
export const MAX_RETAINED_DIFF_BYTES = 1024 * 1024;

export interface PreviewStoreState {
  bySession: Record<string, ThreadPreviewState>;
}

export interface PreviewProjectionContext {
  isActive: boolean;
  isWide: boolean;
  isReplay: boolean;
}

function emptyThreadPreviewState(): ThreadPreviewState {
  return {
    items: [],
    selectedItemId: null,
    selectedView: null,
    open: false,
    unread: false,
    autoOpenSuppressed: false,
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function enforceRetention(items: LocalFilePreviewItem[]): LocalFilePreviewItem[] {
  const retained: LocalFilePreviewItem[] = [];
  let diffBytes = 0;
  for (const item of items) {
    if (retained.length >= MAX_PREVIEW_ITEMS) break;
    const itemDiffBytes = item.unifiedDiff ? utf8Bytes(item.unifiedDiff) : 0;
    if (itemDiffBytes && diffBytes + itemDiffBytes > MAX_RETAINED_DIFF_BYTES) {
      if (retained.length === 0) {
        retained.push({
          ...item,
          unifiedDiff: undefined,
          availableViews: item.availableViews.filter((view) => view !== 'diff'),
        });
      }
      continue;
    }
    retained.push(item);
    diffBytes += itemDiffBytes;
  }
  return retained;
}

function createPreviewStore() {
  const initial: PreviewStoreState = { bySession: {} };
  const store: Writable<PreviewStoreState> = writable(initial);

  function mutateSession(
    sessionId: string,
    mutate: (state: ThreadPreviewState) => ThreadPreviewState,
  ): void {
    store.update((root) => ({
      bySession: {
        ...root.bySession,
        [sessionId]: mutate(root.bySession[sessionId] ?? emptyThreadPreviewState()),
      },
    }));
  }

  return {
    subscribe: store.subscribe,

    getSession(sessionId: string): ThreadPreviewState {
      return get(store).bySession[sessionId] ?? emptyThreadPreviewState();
    },

    projectEvent(sessionId: string, event: Event, context: PreviewProjectionContext): string | null {
      if (event.msg.type === 'TaskStarted') {
        mutateSession(sessionId, (state) => ({ ...state, autoOpenSuppressed: false }));
        return null;
      }
      const item = localFilePreviewItemFromEvent(sessionId, event);
      if (!item) return null;

      mutateSession(sessionId, (state) => {
        const existingIndex = state.items.findIndex((candidate) => candidate.id === item.id);
        const isNew = existingIndex < 0;
        const items = enforceRetention([
          item,
          ...state.items.filter((candidate) => candidate.id !== item.id),
        ]);
        const retainedItem = items.find((candidate) => candidate.id === item.id);
        if (!retainedItem) return state;
        const selectedView = state.selectedItemId === item.id
          && state.selectedView
          && retainedItem.availableViews.includes(state.selectedView)
          ? state.selectedView
          : defaultPreviewView(retainedItem);
        const canAutoOpen = isNew
          && context.isActive
          && context.isWide
          && !context.isReplay
          && !state.autoOpenSuppressed;
        return {
          ...state,
          items,
          selectedItemId: item.id,
          selectedView,
          open: canAutoOpen ? true : state.open,
          unread: isNew ? !canAutoOpen : state.unread,
        };
      });
      return item.id;
    },

    openSession(sessionId: string): void {
      mutateSession(sessionId, (state) => ({ ...state, open: true, unread: false }));
    },

    closeSession(sessionId: string): void {
      mutateSession(sessionId, (state) => ({
        ...state,
        open: false,
        unread: false,
        autoOpenSuppressed: true,
      }));
    },

    toggleSession(sessionId: string): void {
      const state = this.getSession(sessionId);
      if (state.open) this.closeSession(sessionId);
      else this.openSession(sessionId);
    },

    revealItem(sessionId: string, itemId: string): void {
      mutateSession(sessionId, (state) => {
        const item = state.items.find((candidate) => candidate.id === itemId);
        if (!item) return state;
        return {
          ...state,
          selectedItemId: item.id,
          selectedView: defaultPreviewView(item),
          open: true,
          unread: false,
        };
      });
    },

    selectItem(sessionId: string, itemId: string): void {
      mutateSession(sessionId, (state) => {
        const item = state.items.find((candidate) => candidate.id === itemId);
        if (!item) return state;
        return {
          ...state,
          selectedItemId: item.id,
          selectedView: defaultPreviewView(item),
          unread: false,
        };
      });
    },

    selectView(sessionId: string, view: LocalFilePreviewView): void {
      mutateSession(sessionId, (state) => {
        const item = state.items.find((candidate) => candidate.id === state.selectedItemId);
        if (!item?.availableViews.includes(view)) return state;
        return { ...state, selectedView: view };
      });
    },

    clearSession(sessionId: string): void {
      mutateSession(sessionId, () => emptyThreadPreviewState());
    },

    removeSession(sessionId: string): void {
      store.update((root) => {
        if (!(sessionId in root.bySession)) return root;
        const bySession = { ...root.bySession };
        delete bySession[sessionId];
        return { bySession };
      });
    },

    reset(): void {
      store.set(initial);
    },
  };
}

export const previewStore = createPreviewStore();
