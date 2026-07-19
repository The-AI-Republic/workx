import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const mocks = vi.hoisted(() => ({ serviceRequest: vi.fn() }));

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(async () => ({ serviceRequest: mocks.serviceRequest })),
}));

vi.mock('@/webfront/stores/platformStore', () => ({
  platform: { platformName: 'desktop' },
}));

vi.mock('@/core/storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: vi.fn(() => false),
  getConfigStorage: vi.fn(),
}));

import SessionModeSwitch from '../SessionModeSwitch.svelte';
import { threadStore } from '../../../stores/threadStore';

describe('SessionModeSwitch', () => {
  beforeEach(() => {
    threadStore.clear();
    mocks.serviceRequest.mockReset();
    threadStore.mergeThread({
      sessionId: 'active-session',
      title: 'Active',
      searchTitle: 'active',
      titleSource: null,
      titleUpdatedAt: 1,
      createdAt: 1,
      lastActiveAt: 1,
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
    });
    threadStore.setActiveThread('active-session');
  });

  it('renders the active session modes and requests a backend-owned switch', async () => {
    mocks.serviceRequest.mockResolvedValue({
      entry: { ...threadStore.getThread('active-session'), agentMode: 'code' },
    });
    render(SessionModeSwitch);

    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(screen.getByRole('button', { name: 'Code' }));

    await waitFor(() => {
      expect(mocks.serviceRequest).toHaveBeenCalledWith('session.setMode', {
        sessionId: 'active-session',
        mode: 'code',
      });
    });
    expect(threadStore.getThread('active-session')).toMatchObject({
      agentMode: 'code',
      pendingMode: null,
    });
  });
});
