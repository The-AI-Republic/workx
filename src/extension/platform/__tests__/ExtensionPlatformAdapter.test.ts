import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExtensionPlatformAdapter } from '../ExtensionPlatformAdapter';
import { TabManager } from '../../../core/TabManager';
import { registerExtensionTools } from '../../tools/registerExtensionTools';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCreateTab = vi.fn();
const mockAddTabToGroup = vi.fn();
const mockValidateTab = vi.fn();
const mockClearAllTabsFromGroup = vi.fn();

const mockTabManagerInstance = {
  createTab: mockCreateTab,
  addTabToGroup: mockAddTabToGroup,
  validateTab: mockValidateTab,
  clearAllTabsFromGroup: mockClearAllTabsFromGroup,
};

vi.mock('../../../core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(),
  },
}));

vi.mock('../../../tools/index', () => ({
  registerExtensionTools: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------

describe('ExtensionPlatformAdapter', () => {
  let adapter: ExtensionPlatformAdapter;

  beforeEach(() => {
    adapter = new ExtensionPlatformAdapter();

    // Re-establish mock implementations after mockReset clears them
    vi.mocked(TabManager.getInstance).mockReturnValue(mockTabManagerInstance as any);
    vi.mocked(registerExtensionTools).mockResolvedValue(undefined);
    mockCreateTab.mockReset();
    mockAddTabToGroup.mockReset();
    mockValidateTab.mockReset();
    mockClearAllTabsFromGroup.mockReset();

    // Enrich the global chrome mock provided by setup.ts with additional
    // APIs that ExtensionPlatformAdapter uses.
    (chrome.tabs as any).captureVisibleTab = vi.fn();
    (chrome as any).scripting = {
      executeScript: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Platform identity ─────────────────────────────────────────────────

  it('platformId is "extension"', () => {
    expect(adapter.platformId).toBe('extension');
  });

  it('hasRealTabs is true', () => {
    expect(adapter.hasRealTabs).toBe(true);
  });

  it('hasBrowserTools is true', () => {
    expect(adapter.hasBrowserTools).toBe(true);
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────

  it('initialize() gets TabManager instance', async () => {
    const { TabManager } = await import('../../../core/TabManager');
    await adapter.initialize();
    expect(TabManager.getInstance).toHaveBeenCalled();
  });

  // ── Tab management ────────────────────────────────────────────────────

  it('createTab() creates tab via TabManager and adds to group', async () => {
    mockCreateTab.mockResolvedValue(42);
    mockAddTabToGroup.mockResolvedValue(1);

    await adapter.initialize();
    const tabId = await adapter.createTab({ url: 'https://example.com' });

    expect(tabId).toBe(42);
    expect(mockCreateTab).toHaveBeenCalledWith({
      url: 'https://example.com',
      active: false,
    });
    expect(mockAddTabToGroup).toHaveBeenCalledWith(42);
  });

  it('createTab() throws when tab creation returns null', async () => {
    mockCreateTab.mockResolvedValue(null);

    await adapter.initialize();
    await expect(adapter.createTab()).rejects.toThrow(
      'Failed to create tab: tab creation returned null'
    );
  });

  it('closeTab() calls chrome.tabs.remove', async () => {
    (chrome.tabs.remove as any).mockResolvedValue(undefined);

    await adapter.closeTab(42);
    expect(chrome.tabs.remove).toHaveBeenCalledWith(42);
  });

  it('closeTab() does not throw when tab already closed', async () => {
    (chrome.tabs.remove as any).mockRejectedValue(new Error('No tab with that id'));

    await expect(adapter.closeTab(99)).resolves.toBeUndefined();
  });

  // ── Tab validation ────────────────────────────────────────────────────

  it('validateTab() returns valid for valid tabs', async () => {
    mockValidateTab.mockResolvedValue({ status: 'valid', tab: {} });

    await adapter.initialize();
    const result = await adapter.validateTab(42);
    expect(result).toEqual({ valid: true });
  });

  it('validateTab() returns invalid with reason for invalid tabs', async () => {
    mockValidateTab.mockResolvedValue({ status: 'invalid', reason: 'closed' });

    await adapter.initialize();
    const result = await adapter.validateTab(42);
    expect(result).toEqual({ valid: false, reason: 'closed' });
  });

  it('validateTab() returns not_found for checking status', async () => {
    mockValidateTab.mockResolvedValue({ status: 'checking' });

    await adapter.initialize();
    const result = await adapter.validateTab(42);
    expect(result).toEqual({ valid: false, reason: 'not_found' });
  });

  // ── switchTab ─────────────────────────────────────────────────────────

  it('switchTab() clears old group and adds new tab', async () => {
    mockClearAllTabsFromGroup.mockResolvedValue(undefined);
    mockAddTabToGroup.mockResolvedValue(1);

    await adapter.initialize();
    await adapter.switchTab(10, 20);

    expect(mockClearAllTabsFromGroup).toHaveBeenCalled();
    expect(mockAddTabToGroup).toHaveBeenCalledWith(20);
  });

  // ── Browser controller ────────────────────────────────────────────────

  it('getBrowserController() returns controller with navigate, getPageContent, screenshot, executeScript', async () => {
    const controller = await adapter.getBrowserController(42);

    expect(controller).not.toBeNull();
    expect(controller!.navigate).toBeInstanceOf(Function);
    expect(controller!.getPageContent).toBeInstanceOf(Function);
    expect(controller!.screenshot).toBeInstanceOf(Function);
    expect(controller!.executeScript).toBeInstanceOf(Function);
  });

  it('getBrowserController().navigate() calls chrome.tabs.update', async () => {
    (chrome.tabs.update as any).mockResolvedValue({});

    const controller = await adapter.getBrowserController(42);
    await controller!.navigate('https://example.com');

    expect(chrome.tabs.update).toHaveBeenCalledWith(42, { url: 'https://example.com' });
  });

  it('getBrowserController().getPageContent() executes script to get HTML', async () => {
    (chrome as any).scripting.executeScript.mockResolvedValue([
      { result: '<html><body>Hello</body></html>' },
    ]);

    const controller = await adapter.getBrowserController(42);
    const content = await controller!.getPageContent();

    expect(content).toBe('<html><body>Hello</body></html>');
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 42 } })
    );
  });

  it('getBrowserController().screenshot() calls captureVisibleTab', async () => {
    (chrome.tabs as any).captureVisibleTab.mockResolvedValue('data:image/png;base64,...');

    const controller = await adapter.getBrowserController(42);
    const result = await controller!.screenshot();

    expect(result).toBe('data:image/png;base64,...');
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('getBrowserController().executeScript() runs script on tab', async () => {
    (chrome as any).scripting.executeScript.mockResolvedValue([
      { result: 'script-result' },
    ]);

    const controller = await adapter.getBrowserController(42);
    const result = await controller!.executeScript('return 1+1');

    expect(result).toBe('script-result');
  });

  // ── registerPlatformTools ─────────────────────────────────────────────

  it('registerPlatformTools() calls registerExtensionTools', async () => {
    const registry = {} as any;
    const toolsConfig = {} as any;
    const capabilities = { supportsImage: true };

    await adapter.registerPlatformTools(registry, toolsConfig, capabilities);

    expect(registerExtensionTools).toHaveBeenCalledWith(registry, toolsConfig, {
      name: '',
      supportsImage: true,
    });
  });

  // ── Config storage ────────────────────────────────────────────────────

  it('getConfigStorage() get/set use chrome.storage.local', async () => {
    const setSpy = vi.spyOn(chrome.storage.local, 'set');
    const configStorage = adapter.getConfigStorage();

    // set
    await configStorage.set('myKey', 'myValue');
    expect(setSpy).toHaveBeenCalledWith({ myKey: 'myValue' });

    // get round-trip — MockStorageArea supports actual get/set
    const value = await configStorage.get('myKey');
    expect(value).toBe('myValue');
  });

  // ── Credential store ──────────────────────────────────────────────────

  it('getCredentialStore() prefixes keys with "credential:"', async () => {
    const setSpy = vi.spyOn(chrome.storage.local, 'set');
    const removeSpy = vi.spyOn(chrome.storage.local, 'remove');
    const store = adapter.getCredentialStore();

    // set
    await store.set('apiKey', 'secret123');
    expect(setSpy).toHaveBeenCalledWith({ 'credential:apiKey': 'secret123' });

    // get round-trip
    const value = await store.get('apiKey');
    expect(value).toBe('secret123');

    // delete
    await store.delete('apiKey');
    expect(removeSpy).toHaveBeenCalledWith('credential:apiKey');
  });

  // ── Storage provider ──────────────────────────────────────────────────

  it('getStorageProvider() get/set/delete use chrome.storage.local', async () => {
    const setSpy = vi.spyOn(chrome.storage.local, 'set');
    const removeSpy = vi.spyOn(chrome.storage.local, 'remove');
    const storage = adapter.getStorageProvider();

    // set
    await storage.set('data', { foo: 'bar' });
    expect(setSpy).toHaveBeenCalledWith({ data: { foo: 'bar' } });

    // get round-trip
    const value = await storage.get('data');
    expect(value).toEqual({ foo: 'bar' });

    // delete
    await storage.delete('data');
    expect(removeSpy).toHaveBeenCalledWith('data');
  });

  // ── Scheduler ─────────────────────────────────────────────────────────

  it('createScheduler() schedule/cancel work with intervals', () => {
    const scheduler = adapter.createScheduler();
    const callback = vi.fn();

    vi.useFakeTimers();
    scheduler.schedule('poll', 50, callback);

    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2);

    scheduler.cancel('poll');
    vi.advanceTimersByTime(100);
    expect(callback).toHaveBeenCalledTimes(2); // no more calls

    vi.useRealTimers();
  });
});
