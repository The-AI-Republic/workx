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

describe('ChatHistorySection paging', () => {
  beforeEach(() => {
    threadStore.clear();
    mocks.serviceRequest.mockReset();
    mocks.push.mockReset();
  });

  it('loads ten rows at a time inside a fixed-height scroll container', async () => {
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
    expect(container.querySelector('[data-thread-history-list]')?.className).toContain('max-h-80');
    expect(container.querySelector('[data-thread-history-list]')?.className).toContain('overflow-y-auto');

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
});
