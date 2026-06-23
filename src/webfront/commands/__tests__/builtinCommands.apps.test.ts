import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(),
}));

vi.mock('../../lib/gatewayCatalog', () => ({
  openGatewayCatalog: vi.fn(async () => ({ opened: true, url: 'https://hub.example.com/apps' })),
}));

import { commandRegistry } from '../CommandRegistry';
import { initBuiltinCommands, runAppsCommand } from '../builtinCommands';
import { openGatewayCatalog } from '../../lib/gatewayCatalog';

describe('builtin /apps', () => {
  beforeEach(() => {
    commandRegistry.reset();
    vi.clearAllMocks();
  });

  it('registers /apps and opens the configured Hub catalog', async () => {
    const onCommandOutput = vi.fn();
    initBuiltinCommands({
      onNewConversation: vi.fn(),
      onCommandOutput,
      onOpenSettings: vi.fn(),
      onSubmitText: vi.fn(),
      onOpenDoctor: vi.fn(),
      onOpenRewindSelector: vi.fn(),
    });

    const cmd = commandRegistry.get('apps');
    expect(cmd).toBeTruthy();
    expect(cmd?.loadedFrom).toBe('builtin');

    await cmd!.action();

    expect(openGatewayCatalog).toHaveBeenCalledOnce();
    expect(onCommandOutput).toHaveBeenCalledWith(
      'Apps',
      'Opened Hub app catalog:\nhttps://hub.example.com/apps',
    );
  });

  it('reports missing catalog config without trying local app state', async () => {
    const result = await runAppsCommand(async () => ({ opened: false, url: null }));

    expect(result).toEqual({
      title: 'Apps',
      content: 'Hub app catalog is not configured. Set WORKX_GATEWAY_CATALOG_URL to the Hub apps page.',
    });
  });

  it('reports opener failures clearly', async () => {
    const result = await runAppsCommand(async () => {
      throw new Error('blocked');
    });

    expect(result).toEqual({
      title: 'Apps',
      content: 'Failed to open Hub app catalog: blocked',
    });
  });
});
