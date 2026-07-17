import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DataSourcesSettings from '../DataSourcesSettings.svelte';
import { createEmptyDataSourceContext, type DataSourcePublicView } from '@/core/data-sources';
import { sourceFixture } from '@/core/data-sources/__tests__/fixtures';

const client = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  test: vi.fn(),
  testCandidate: vi.fn(),
  getContext: vi.fn(),
  updateContext: vi.fn(),
  listContextRevisions: vi.fn(),
  revertContext: vi.fn(),
  refreshSchema: vi.fn(),
}));

vi.mock('@/webfront/data-sources/client', () => ({
  dataSourcesClient: client,
  dataSourceUiError: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

function publicSource(): DataSourcePublicView {
  const { secretVersion: _secretVersion, ...source } = sourceFixture();
  void _secretVersion;
  return { source, passwordConfigured: true };
}

function context(sourceId = sourceFixture().id) {
  return createEmptyDataSourceContext(sourceId, '2026-07-17T00:00:00.000Z');
}

describe('DataSourcesSettings', () => {
  beforeEach(() => {
    const saved = publicSource();
    client.status.mockResolvedValue({
      state: 'ready',
      available: true,
      toolsEnabled: true,
      connectorIds: ['postgres-native', 'mysql-native'],
    });
    client.list.mockResolvedValue([saved]);
    client.getContext.mockResolvedValue(context());
    client.listContextRevisions.mockResolvedValue([]);
    client.test.mockResolvedValue({
      test: { ...saved.source.lastTest, connectorId: 'postgres-native', warnings: [] },
      source: saved,
    });
    client.delete.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows the privacy disclosure and keeps a saved password out of UI state', async () => {
    render(DataSourcesSettings);
    expect(await screen.findByText('Production Sales')).toBeTruthy();
    expect(screen.getByText(/Query results are sent to your selected AI model/)).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    await fireEvent.click(screen.getByRole('radio', { name: /Replace password/ }));
    const password = screen.getByLabelText(/^Password/) as HTMLInputElement;
    expect(password.value).toBe('');
    expect(password.autocomplete).toBe('new-password');
    expect(
      screen.getByRole('tab', { name: /Connection & policy/ }).getAttribute('aria-selected')
    ).toBe('true');
  });

  it('tests and deletes a selected source through direct service DTOs', async () => {
    render(DataSourcesSettings);
    expect(await screen.findByText('Production Sales')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(client.test).toHaveBeenCalledWith(sourceFixture().id, 1));
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.delete).toHaveBeenCalledWith(sourceFixture().id, 1));
    expect(window.confirm).toHaveBeenCalled();
  });

  it('loads schema-aware context, marks stale facts, and restores revisions safely', async () => {
    const saved = publicSource();
    const staleContext = {
      ...context(),
      revision: 2,
      facts: [
        {
          id: 'fact-1',
          kind: 'field_meaning' as const,
          subject: { namespace: 'public', object: 'orders', field: 'legacy_status' },
          assertion: 'Legacy status meaning',
          status: 'active' as const,
          provenance: {
            source: 'user_chat' as const,
            createdAt: '2026-07-17T00:00:00.000Z',
            evidenceQuote: 'legacy_status stores the former status',
          },
          confidence: 'user_asserted' as const,
          stale: true,
          staleReason: 'Referenced schema field public.orders.legacy_status is no longer visible.',
        },
      ],
    };
    client.getContext
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(staleContext)
      .mockResolvedValue(staleContext);
    client.listContextRevisions.mockResolvedValue([
      {
        revision: 1,
        createdAt: '2026-07-17T00:00:00.000Z',
        createdBy: 'settings',
        activeFactCount: 0,
      },
    ]);
    client.revertContext.mockResolvedValue({ ...staleContext, revision: 3 });

    render(DataSourcesSettings);
    expect(await screen.findByText('Production Sales')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Context' }));
    expect(await screen.findByText(/Stale: Referenced schema field/)).toBeTruthy();
    expect(client.getContext).toHaveBeenLastCalledWith(saved.source.id, true);
    await fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(client.revertContext).toHaveBeenCalledWith(saved.source.id, 1, 2));
  });

  it('keeps WorkX usable when data-source initialization is unavailable', async () => {
    client.status.mockResolvedValue({
      state: 'unavailable',
      available: false,
      toolsEnabled: false,
      connectorIds: [],
      errorCode: 'DATA_SOURCES_UNAVAILABLE',
    });
    render(DataSourcesSettings);
    expect(await screen.findByText(/Data Sources is unavailable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry initialization check' })).toBeTruthy();
  });
});
