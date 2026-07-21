import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentView } from '@/core/components';
import ComponentsSettings from '../ComponentsSettings.svelte';

const client = vi.hoisted(() => ({
  status: vi.fn(),
  list: vi.fn(),
  install: vi.fn(),
  verify: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock('@/webfront/components-runtime/client', () => ({
  componentsClient: client,
  componentUiError: (error: unknown) => (error instanceof Error ? error.message : 'failed'),
}));

function duckdb(state: ComponentView['state'] = 'not_installed'): ComponentView {
  return {
    id: 'duckdb',
    displayName: 'DuckDB',
    description: 'Local analytical SQL engine',
    version: '1.5.4',
    platform: 'linux-x64',
    capabilities: ['local-sql', 'parquet'],
    state,
    downloadSizeBytes: 21_247_976,
    ...(state === 'installed' ? { installedSizeBytes: 60_000_000 } : {}),
    license: { name: 'MIT', url: 'https://example.test/license' },
    homepage: 'https://duckdb.org',
  };
}

describe('ComponentsSettings', () => {
  beforeEach(() => {
    client.status.mockResolvedValue({
      state: 'ready',
      available: true,
      rootPath: '/home/alice/.workx',
      componentsPath: '/home/alice/.workx/components',
      workspacesPath: '/home/alice/.workx/workspaces',
    });
    client.list.mockResolvedValue([duckdb()]);
    client.install.mockResolvedValue(duckdb('installed'));
    client.verify.mockResolvedValue(duckdb('installed'));
    client.uninstall.mockResolvedValue(undefined);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('shows private installation location, download size, and component metadata', async () => {
    render(ComponentsSettings);
    expect(await screen.findByText('DuckDB')).toBeTruthy();
    expect(screen.getByText('/home/alice/.workx/components')).toBeTruthy();
    expect(screen.getByText('20.3 MiB')).toBeTruthy();
    expect(screen.getByText('local-sql, parquet')).toBeTruthy();
  });

  it('requires confirmation before installing and updates the component state', async () => {
    render(ComponentsSettings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('system PATH'));
    await waitFor(() => expect(client.install).toHaveBeenCalledWith('duckdb'));
    expect(await screen.findByText(/DuckDB 1.5.4 is ready/)).toBeTruthy();
    expect(screen.getByText('Installed')).toBeTruthy();
  });

  it('does not install when confirmation is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(ComponentsSettings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expect(client.install).not.toHaveBeenCalled();
  });

  it('keeps Settings usable when the component runtime is unavailable', async () => {
    client.status.mockResolvedValue({
      state: 'unavailable',
      available: false,
      errorCode: 'COMPONENTS_UNAVAILABLE',
    });
    render(ComponentsSettings);
    expect(await screen.findByText(/Managed components are unavailable/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry initialization check' })).toBeTruthy();
  });
});
