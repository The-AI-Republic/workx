import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DesktopPlatformAdapter } from '../DesktopPlatformAdapter';
import { MCPManager } from '../../../core/mcp/MCPManager';
import { registerMCPTools } from '../../../core/mcp/MCPToolAdapter';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Use vi.hoisted so the mock object exists before vi.mock factory runs
const { mockMcpManager } = vi.hoisted(() => ({
  mockMcpManager: {
    getServerByName: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(),
    executeTool: vi.fn(),
  },
}));

vi.mock('../../../core/mcp/MCPManager', () => ({
  MCPManager: {
    getInstance: vi.fn().mockResolvedValue(mockMcpManager),
  },
}));

vi.mock('../../../core/mcp/MCPToolAdapter', () => ({
  registerMCPTools: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../core/approval/assessors/McpBrowserRiskAssessor', () => ({
  McpBrowserRiskAssessor: vi.fn(),
}));

// ---------------------------------------------------------------------------

describe('DesktopPlatformAdapter', () => {
  let adapter: DesktopPlatformAdapter;

  beforeEach(() => {
    adapter = new DesktopPlatformAdapter();
    mockMcpManager.connect.mockClear().mockResolvedValue(undefined);
    mockMcpManager.getConnection.mockClear();
    mockMcpManager.getServerByName.mockClear();
    mockMcpManager.executeTool.mockClear();
    // Re-establish return values after mockReset clears them
    vi.mocked(MCPManager.getInstance).mockResolvedValue(mockMcpManager as any);
    vi.mocked(registerMCPTools).mockResolvedValue(undefined);
  });

  describe('getCurrentPageContext()', () => {
    it('returns the selected MCP page URL and domain', async () => {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.getConnection.mockReturnValue({ tools: [{ name: 'list_pages' }] });
      mockMcpManager.executeTool.mockResolvedValue({
        content: [{
          type: 'text',
          text: '## Pages\n0: https://other.example/\n1: https://checkout.example/cart [selected]',
        }],
      });
      adapter.setToolContext({ getTool: vi.fn().mockReturnValue(undefined) } as any, vi.fn());

      await expect(adapter.getCurrentPageContext()).resolves.toEqual({
        currentUrl: 'https://checkout.example/cart',
        currentDomain: 'checkout.example',
      });
      expect(mockMcpManager.executeTool).toHaveBeenCalledWith('browser__list_pages', {});
    });

    it('fails safely when MCP page context is unavailable', async () => {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.getConnection.mockReturnValue({ tools: [{ name: 'list_pages' }] });
      mockMcpManager.executeTool.mockRejectedValue(new Error('browser closed'));
      adapter.setToolContext({ getTool: vi.fn().mockReturnValue(undefined) } as any, vi.fn());

      await expect(adapter.getCurrentPageContext()).resolves.toEqual({});
    });

    it('fails safely when MCP returns malformed page content', async () => {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.getConnection.mockReturnValue({ tools: [{ name: 'list_pages' }] });
      mockMcpManager.executeTool.mockResolvedValue({ content: null } as any);
      adapter.setToolContext({ getTool: vi.fn().mockReturnValue(undefined) } as any, vi.fn());

      await expect(adapter.getCurrentPageContext()).resolves.toEqual({});
    });
  });

  // ── Platform identity ─────────────────────────────────────────────────

  it('platformId is "desktop"', () => {
    expect(adapter.platformId).toBe('desktop');
  });

  it('hasRealTabs is false', () => {
    expect(adapter.hasRealTabs).toBe(false);
  });

  it('hasBrowserTools is true', () => {
    expect(adapter.hasBrowserTools).toBe(true);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  it('initialize() succeeds (no-op)', async () => {
    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  // ── Tab management ────────────────────────────────────────────────────

  it('createTab() returns sentinel tabId 1', async () => {
    expect(await adapter.createTab()).toBe(1);
  });

  it('closeTab() is a no-op', async () => {
    await expect(adapter.closeTab(1)).resolves.toBeUndefined();
  });

  it('validateTab() always returns { valid: true }', async () => {
    expect(await adapter.validateTab(42)).toEqual({ valid: true });
  });

  it('switchTab() is a no-op', async () => {
    await expect(adapter.switchTab(1, 2)).resolves.toBeUndefined();
  });

  // ── Browser controller ────────────────────────────────────────────────

  it('getBrowserController() returns null when not connected', async () => {
    expect(await adapter.getBrowserController(1)).toBeNull();
  });

  // ── setToolContext ────────────────────────────────────────────────────

  it('setToolContext() does not throw', () => {
    expect(() => adapter.setToolContext({ getTool: vi.fn() } as any, vi.fn())).not.toThrow();
  });

  // ── ensureBrowserReady ────────────────────────────────────────────────

  describe('ensureBrowserReady()', () => {
    function setupMcpSuccess() {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.getConnection.mockReturnValue({ tools: [{ name: 'click' }] });
    }

    it('connects to MCP browser server and registers tools', async () => {
      setupMcpSuccess();
      const registry = { getTool: vi.fn().mockReturnValue(undefined) } as any;
      adapter.setToolContext(registry, vi.fn());

      await adapter.ensureBrowserReady();

      expect(mockMcpManager.connect).toHaveBeenCalledWith('browser-id');
      expect(registerMCPTools).toHaveBeenCalled();
    });

    it('is idempotent (second call is no-op)', async () => {
      setupMcpSuccess();
      const registry = { getTool: vi.fn().mockReturnValue(undefined) } as any;
      adapter.setToolContext(registry, vi.fn());

      await adapter.ensureBrowserReady();
      await adapter.ensureBrowserReady();

      expect(mockMcpManager.connect).toHaveBeenCalledTimes(1);
    });

    it('handles missing browser server gracefully', async () => {
      mockMcpManager.getServerByName.mockReturnValue(undefined);
      const emitEvent = vi.fn();
      adapter.setToolContext({ getTool: vi.fn() } as any, emitEvent);

      await expect(adapter.ensureBrowserReady()).resolves.toBeUndefined();

      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'BackgroundEvent',
          data: expect.objectContaining({ level: 'warning' }),
        })
      );
    });

    it('handles connection errors gracefully', async () => {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.connect.mockRejectedValueOnce(new Error('Connection refused'));
      const emitEvent = vi.fn();
      adapter.setToolContext({ getTool: vi.fn() } as any, emitEvent);

      await expect(adapter.ensureBrowserReady()).resolves.toBeUndefined();

      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.stringContaining('Connection refused'),
          }),
        })
      );
    });

    it('emits warning when no tools discovered', async () => {
      mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
      mockMcpManager.getConnection.mockReturnValue({ tools: [] });
      const emitEvent = vi.fn();
      adapter.setToolContext({ getTool: vi.fn() } as any, emitEvent);

      await adapter.ensureBrowserReady();

      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.stringContaining('no tools were discovered'),
          }),
        })
      );
    });

    it('does nothing when setToolContext not called', async () => {
      await expect(adapter.ensureBrowserReady()).resolves.toBeUndefined();
      expect(mockMcpManager.connect).not.toHaveBeenCalled();
    });
  });

  // ── dispose ───────────────────────────────────────────────────────────

  it('dispose() resets browserConnected so ensureBrowserReady reconnects', async () => {
    mockMcpManager.getServerByName.mockReturnValue({ id: 'browser-id', name: 'browser' });
    mockMcpManager.getConnection.mockReturnValue({ tools: [{ name: 'click' }] });
    const registry = { getTool: vi.fn().mockReturnValue(undefined) } as any;
    adapter.setToolContext(registry, vi.fn());

    await adapter.ensureBrowserReady();
    expect(mockMcpManager.connect).toHaveBeenCalledTimes(1);

    await adapter.dispose();
    mockMcpManager.connect.mockClear();

    // After dispose, ensureBrowserReady should reconnect
    adapter.setToolContext(registry, vi.fn());
    await adapter.ensureBrowserReady();
    expect(mockMcpManager.connect).toHaveBeenCalledTimes(1);
  });

  // ── Scheduler ─────────────────────────────────────────────────────────

  it('createScheduler() returns working schedule/cancel', () => {
    vi.useFakeTimers();
    const scheduler = adapter.createScheduler();
    const callback = vi.fn();

    scheduler.schedule('test-task', 100, callback);
    vi.advanceTimersByTime(250);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.cancel('test-task');
    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
