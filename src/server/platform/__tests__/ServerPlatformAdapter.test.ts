import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ServerPlatformAdapter } from '../ServerPlatformAdapter';

describe('ServerPlatformAdapter', () => {
  let adapter: ServerPlatformAdapter;
  const originalEnv = process.env;

  beforeEach(() => {
    adapter = new ServerPlatformAdapter();
    // Isolate process.env per test
    process.env = { ...originalEnv };
    delete process.env.CHROME_REMOTE_URL;
    delete process.env.CHROME_WS_ENDPOINT;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // ── Platform identity ─────────────────────────────────────────────────

  it('platformId is "server"', () => {
    expect(adapter.platformId).toBe('server');
  });

  it('hasRealTabs is false', () => {
    expect(adapter.hasRealTabs).toBe(false);
  });

  it('hasBrowserTools is false by default', () => {
    expect(adapter.hasBrowserTools).toBe(false);
  });

  // ── initialize ────────────────────────────────────────────────────────

  it('initialize() detects CHROME_REMOTE_URL environment variable', async () => {
    process.env.CHROME_REMOTE_URL = 'http://localhost:9222';

    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(true);
  });

  it('initialize() detects CHROME_WS_ENDPOINT environment variable', async () => {
    process.env.CHROME_WS_ENDPOINT = 'ws://localhost:9222/devtools/browser/abc';

    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(true);
  });

  it('initialize() sets hasBrowserTools=true when browser endpoint found', async () => {
    process.env.CHROME_REMOTE_URL = 'http://remote-chrome:9222';

    expect(adapter.hasBrowserTools).toBe(false);
    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(true);
  });

  it('initialize() leaves hasBrowserTools false when no env vars set', async () => {
    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(false);
  });

  // ── Tab management ────────────────────────────────────────────────────

  it('createTab() returns sentinel tabId 1', async () => {
    const tabId = await adapter.createTab();
    expect(tabId).toBe(1);
  });

  it('closeTab() is a no-op', async () => {
    await expect(adapter.closeTab(1)).resolves.toBeUndefined();
  });

  it('validateTab() always returns { valid: true }', async () => {
    const result = await adapter.validateTab(99);
    expect(result).toEqual({ valid: true });
  });

  it('switchTab() is a no-op', async () => {
    await expect(adapter.switchTab(1, 2)).resolves.toBeUndefined();
  });

  // ── Browser controller ────────────────────────────────────────────────

  it('getBrowserController() returns null', async () => {
    const controller = await adapter.getBrowserController(1);
    expect(controller).toBeNull();
  });

  // ── registerPlatformTools ─────────────────────────────────────────────

  it('registerPlatformTools() is a no-op', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const registry = {} as any;
    const toolsConfig = {} as any;
    const capabilities = { supportsImage: false };

    await expect(
      adapter.registerPlatformTools(registry, toolsConfig, capabilities)
    ).resolves.toBeUndefined();

    consoleSpy.mockRestore();
  });

  // ── Scheduler ─────────────────────────────────────────────────────────

  it('createScheduler() returns working schedule/cancel', () => {
    const scheduler = adapter.createScheduler();
    const callback = vi.fn();

    vi.useFakeTimers();
    scheduler.schedule('heartbeat', 100, callback);

    vi.advanceTimersByTime(250);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.cancel('heartbeat');
    vi.advanceTimersByTime(200);
    expect(callback).toHaveBeenCalledTimes(2); // no more calls

    vi.useRealTimers();
  });

  // ── dispose ───────────────────────────────────────────────────────────

  it('dispose() succeeds', async () => {
    await expect(adapter.dispose()).resolves.toBeUndefined();
  });

  it('dispose() resets hasBrowserTools', async () => {
    process.env.CHROME_REMOTE_URL = 'http://localhost:9222';
    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(true);

    await adapter.dispose();
    expect(adapter.hasBrowserTools).toBe(false);
  });

  // ── getBrowserEndpoint (private, tested via initialize) ───────────────

  it('getBrowserEndpoint() returns null when no env vars', async () => {
    // With no env vars, initialize should leave hasBrowserTools false
    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(false);
  });

  it('getBrowserEndpoint() returns URL from CHROME_REMOTE_URL', async () => {
    process.env.CHROME_REMOTE_URL = 'http://chrome-host:9222';
    await adapter.initialize();
    expect(adapter.hasBrowserTools).toBe(true);
  });
});
