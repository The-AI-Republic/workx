import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type { ThreadListItem } from '@/core/registry/types';

const mocks = vi.hoisted(() => ({
  serviceRequest: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(async () => ({ serviceRequest: mocks.serviceRequest })),
}));

vi.mock('svelte-spa-router', () => ({ push: mocks.push }));

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => false),
  getConfigStorage: vi.fn(),
}));

import ChatHistorySection from '../ChatHistorySection.svelte';
import { threadStore } from '../../../stores/threadStore';
import { themePreference } from '../../../stores/themeStore';

function item(index: number): ThreadListItem {
  return {
    sessionId: `session-${index}`,
    title: `Conversation ${index}`,
    searchTitle: `conversation ${index}`,
    titleSource: null,
    titleUpdatedAt: index,
    createdAt: index,
    lastActiveAt: 100 - index,
    pinned: false,
    deletedAt: null,
    purgeAfter: null,
    agentMode: 'general',
    origin: { kind: 'new' },
    schemaVersion: 1,
    runtime: {
      state: 'suspended',
      awaitingInputCount: 0,
      awaitingInputKinds: [],
      durability: 'ok',
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('ChatHistorySection paging', () => {
  beforeEach(() => {
    threadStore.clear();
    themePreference.setTheme('modern-light');
    mocks.serviceRequest.mockReset();
    mocks.push.mockReset();
  });

  it('applies modern and terminal theme colors to history controls', async () => {
    mocks.serviceRequest.mockResolvedValue({ entries: [item(0)], nextCursor: 'page-2' });

    render(ChatHistorySection);

    const search = await screen.findByRole('textbox', { name: 'Search chats' });
    await screen.findByText('Conversation 0');
    const loadMore = screen.getByRole('button', { name: 'Load More' });
    expect(search.classList.contains('text-chat-text')).toBe(true);
    expect(search.classList.contains('placeholder:text-chat-text-muted')).toBe(true);
    expect(loadMore.classList.contains('text-chat-text-secondary')).toBe(true);

    themePreference.setTheme('terminal');

    await waitFor(() => {
      expect(search.classList.contains('text-term-green')).toBe(true);
      expect(search.classList.contains('placeholder:text-term-dim-green')).toBe(true);
      expect(loadMore.classList.contains('text-term-dim-green')).toBe(true);
    });
  });

  it('loads ten rows at a time appended into the panel, with no inner scroll container', async () => {
    mocks.serviceRequest
      .mockResolvedValueOnce({ entries: Array.from({ length: 10 }, (_, index) => item(index)), nextCursor: 'page-2' })
      .mockResolvedValueOnce({ entries: Array.from({ length: 10 }, (_, index) => item(index + 10)), nextCursor: null });

    const { container } = render(ChatHistorySection);

    await screen.findByText('Conversation 0');
    expect(mocks.serviceRequest).toHaveBeenNthCalledWith(1, 'session.list', expect.objectContaining({
      limit: 10,
      cursor: undefined,
    }));
    expect(container.querySelectorAll('[data-thread-history-select]')).toHaveLength(10);
    // The chat-history list no longer owns a scrollbar; the whole left panel is
    // the sole scroll surface, so the list must not clamp height or scroll.
    expect(container.querySelector('[data-thread-history-list]')?.className).not.toContain('max-h-80');
    expect(container.querySelector('[data-thread-history-list]')?.className).not.toContain('overflow-y-auto');

    await fireEvent.click(screen.getByRole('button', { name: 'Load More' }));
    await waitFor(() => {
      expect(container.querySelectorAll('[data-thread-history-select]')).toHaveLength(20);
    });
    expect(mocks.serviceRequest).toHaveBeenNthCalledWith(2, 'session.list', expect.objectContaining({
      limit: 10,
      cursor: 'page-2',
    }));
    expect(screen.queryByRole('button', { name: 'Load More' })).toBeNull();
  });

  it('drops the header new-chat button and keeps per-row controls in the hover layer', async () => {
    mocks.serviceRequest.mockResolvedValue({ entries: [item(0)], nextCursor: null });

    render(ChatHistorySection);

    await screen.findByText('Conversation 0');
    expect(screen.queryByRole('button', { name: 'New Chat' })).toBeNull();
    // Row controls still exist (rendered in the hover overlay), so pin/rename/
    // delete remain reachable. They expose their label via `title`.
    expect(screen.getByTitle('Pin')).toBeTruthy();
    expect(screen.getByTitle('Rename')).toBeTruthy();
    expect(screen.getByTitle('Delete')).toBeTruthy();
  });

  it('lets a newer search replace an in-flight result and ignores the stale response', async () => {
    threadStore.mergePage([item(99)], null, { reset: true });
    const olderSearch = deferred<{ entries: ThreadListItem[]; nextCursor: null }>();
    const newerSearch = deferred<{ entries: ThreadListItem[]; nextCursor: null }>();
    mocks.serviceRequest.mockImplementation((_method, params: { query?: string }) => (
      params.query === 'older' ? olderSearch.promise : newerSearch.promise
    ));

    render(ChatHistorySection);
    const search = screen.getByRole('textbox', { name: 'Search chats' });
    await fireEvent.input(search, { target: { value: 'older' } });
    await waitFor(() => {
      expect(mocks.serviceRequest).toHaveBeenCalledWith('session.list', expect.objectContaining({
        query: 'older',
      }));
    });

    await fireEvent.input(search, { target: { value: 'newer' } });
    await waitFor(() => {
      expect(mocks.serviceRequest).toHaveBeenCalledWith('session.list', expect.objectContaining({
        query: 'newer',
      }));
    });

    newerSearch.resolve({ entries: [item(200)], nextCursor: null });
    await screen.findByText('Conversation 200');
    olderSearch.resolve({ entries: [item(100)], nextCursor: null });
    await waitFor(() => {
      expect(screen.queryByText('Conversation 100')).toBeNull();
      expect(screen.getByText('Conversation 200')).toBeTruthy();
    });
  });
});
