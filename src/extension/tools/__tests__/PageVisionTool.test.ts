/**
 * Unit tests for PageVisionTool
 *
 * Covers: tool definition, parameter validation, tab ID validation,
 * screenshot action, click action, type action, scroll action, keypress action,
 * coordinate validation/clipping, Chrome context validation, error handling,
 * execute() override with metadata injection, and logging.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { BaseToolOptions } from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Mock dependencies via vi.hoisted + vi.mock
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  return {
    screenshotServiceForTab: vi.fn(),
    screenshotServiceCaptureViewport: vi.fn(),
    screenshotServiceCaptureWithScroll: vi.fn(),
    screenshotFileManagerSaveScreenshot: vi.fn(),
    coordinateActionServiceForTab: vi.fn(),
    coordinateActionServiceClickAt: vi.fn(),
    coordinateActionServiceTypeAt: vi.fn(),
    coordinateActionServiceScrollTo: vi.fn(),
    coordinateActionServiceKeypressAt: vi.fn(),
  };
});

vi.mock('@/extension/tools/screenshot/ScreenshotService', () => ({
  ScreenshotService: {
    forTab: mocks.screenshotServiceForTab,
  },
}));

vi.mock('@/extension/tools/screenshot/ScreenshotFileManager', () => ({
  ScreenshotFileManager: {
    saveScreenshot: mocks.screenshotFileManagerSaveScreenshot,
  },
}));

vi.mock('@/extension/tools/screenshot/CoordinateActionService', () => ({
  CoordinateActionService: {
    forTab: mocks.coordinateActionServiceForTab,
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { PageVisionTool } from '@/extension/tools/PageVisionTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build options with a tabId in metadata */
function withTab(tabId: number): BaseToolOptions {
  return { metadata: { tabId } };
}

/** Creates a minimal chrome.tabs.Tab stub */
function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 1,
    active: true,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete',
    ...overrides,
  } as chrome.tabs.Tab;
}

/** Default viewport bounds returned by CDP Runtime.evaluate for validateCoordinates */
const defaultViewport = { width: 1280, height: 720 };

/** Sets up chrome.debugger.sendCommand to return viewport bounds */
function setupDebuggerViewport(
  viewport: { width: number; height: number } = defaultViewport
) {
  const c = (globalThis as any).chrome;
  c.debugger.sendCommand.mockResolvedValue({
    result: { value: viewport },
  });
}

/** Sets up all mocks for a successful screenshot flow */
function setupScreenshotMocks(
  viewport = { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 }
) {
  mocks.screenshotServiceCaptureViewport.mockResolvedValue({
    base64Data: 'base64screenshot',
    viewport,
  });
  mocks.screenshotServiceCaptureWithScroll.mockResolvedValue({
    base64Data: 'base64screenshotScrolled',
    viewport,
  });
  mocks.screenshotServiceForTab.mockResolvedValue({
    captureViewport: mocks.screenshotServiceCaptureViewport,
    captureWithScroll: mocks.screenshotServiceCaptureWithScroll,
    release: vi.fn().mockResolvedValue(undefined),
  });
  mocks.screenshotFileManagerSaveScreenshot.mockResolvedValue(undefined);
}

/** Sets up all mocks for coordinate action services */
function setupCoordinateActionMocks() {
  mocks.coordinateActionServiceClickAt.mockResolvedValue(undefined);
  mocks.coordinateActionServiceTypeAt.mockResolvedValue(undefined);
  mocks.coordinateActionServiceScrollTo.mockResolvedValue(undefined);
  mocks.coordinateActionServiceKeypressAt.mockResolvedValue(undefined);
  mocks.coordinateActionServiceForTab.mockResolvedValue({
    clickAt: mocks.coordinateActionServiceClickAt,
    typeAt: mocks.coordinateActionServiceTypeAt,
    scrollTo: mocks.coordinateActionServiceScrollTo,
    keypressAt: mocks.coordinateActionServiceKeypressAt,
    release: vi.fn().mockResolvedValue(undefined),
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PageVisionTool', () => {
  let tool: PageVisionTool;

  beforeEach(() => {
    const c = (globalThis as any).chrome;

    // Extend tabs with get method
    c.tabs.get = vi.fn().mockResolvedValue(makeTab());

    // Add debugger API
    c.debugger = {
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn().mockResolvedValue(undefined),
      sendCommand: vi.fn(),
    };

    // Setup default mocks
    setupDebuggerViewport();
    setupScreenshotMocks();
    setupCoordinateActionMocks();

    tool = new PageVisionTool();
  });

  /** Convenience accessor for the chrome mock */
  function chromeMock() {
    return (globalThis as any).chrome;
  }

  // -----------------------------------------------------------------------
  // Tool Definition
  // -----------------------------------------------------------------------
  describe('Tool Definition', () => {
    it('should expose a function-type tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('should be named page_vision', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('page_vision');
      }
    });

    it('should declare action as a required parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        expect(def.function.parameters.required).toContain('action');
      }
    });

    it('should include visual category', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).category).toBe('visual');
      }
    });

    it('should have version 1.0.0', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).version).toBe('1.0.0');
      }
    });

    it('should list expected capabilities in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.capabilities).toEqual(
          expect.arrayContaining([
            'screenshot_capture',
            'coordinate_click',
            'coordinate_type',
            'coordinate_scroll',
            'coordinate_keypress',
            'viewport_detection',
          ])
        );
      }
    });

    it('should declare required permissions', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.permissions).toEqual(
          expect.arrayContaining(['activeTab', 'debugger', 'storage'])
        );
      }
    });

    it('should declare extension platform', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.platforms).toContain('extension');
      }
    });

    it('should define action parameter with enum values', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const actionProp = def.function.parameters.properties?.action;
        expect(actionProp).toBeDefined();
      }
    });

    it('should define coordinates parameter as object type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const coordProp = def.function.parameters.properties?.coordinates;
        expect(coordProp).toBeDefined();
        if (coordProp) {
          expect(coordProp.type).toBe('object');
        }
      }
    });
  });

  // -----------------------------------------------------------------------
  // Parameter Validation (BaseTool.execute -> validateParameters)
  // -----------------------------------------------------------------------
  describe('Parameter Validation', () => {
    it('should fail when required action parameter is missing', async () => {
      const result = await tool.execute({} as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should fail when action is null', async () => {
      const result = await tool.execute({ action: null } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should fail when action has wrong type (number)', async () => {
      const result = await tool.execute({ action: 123 } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when text has wrong type (number)', async () => {
      const result = await tool.execute(
        { action: 'type', text: 123 } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when coordinates has wrong type (string)', async () => {
      const result = await tool.execute(
        { action: 'click', coordinates: 'bad' } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should pass validation for a well-formed screenshot request', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tab ID Validation
  // -----------------------------------------------------------------------
  describe('Tab ID Validation', () => {
    it('should fail when tabId is missing from options metadata', async () => {
      const result = await tool.execute({ action: 'screenshot' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should fail when tabId is undefined in metadata', async () => {
      const result = await tool.execute(
        { action: 'screenshot' },
        { metadata: {} }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should fail when tabId is null in metadata', async () => {
      const result = await tool.execute(
        { action: 'screenshot' },
        { metadata: { tabId: null } }
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should fail when tabId is -1', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab cannot be found');
    });

    it('should fail when chrome.tabs.get rejects (tab does not exist)', async () => {
      chromeMock().tabs.get.mockRejectedValueOnce(new Error('No tab with id'));
      const result = await tool.execute({ action: 'screenshot' }, withTab(999));
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or inaccessible');
    });

    it('should include tabId in error message when tab not found', async () => {
      chromeMock().tabs.get.mockRejectedValueOnce(new Error('No tab'));
      const result = await tool.execute({ action: 'screenshot' }, withTab(42));
      expect(result.success).toBe(false);
      expect(result.error).toContain('42');
    });

    it('should fail when options is undefined (no metadata)', async () => {
      const result = await tool.execute({ action: 'screenshot' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });
  });

  // -----------------------------------------------------------------------
  // Chrome Context Validation
  // -----------------------------------------------------------------------
  describe('Chrome Context Validation', () => {
    it('should fail when chrome is undefined', async () => {
      const original = (globalThis as any).chrome;
      delete (globalThis as any).chrome;
      try {
        const result = await tool.execute({ action: 'screenshot' }, withTab(1));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Chrome extension context required');
      } finally {
        (globalThis as any).chrome = original;
      }
    });

    it('should fail when chrome.tabs is undefined', async () => {
      const originalTabs = (globalThis as any).chrome.tabs;
      delete (globalThis as any).chrome.tabs;
      try {
        const result = await tool.execute({ action: 'screenshot' }, withTab(1));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Chrome extension context required');
      } finally {
        (globalThis as any).chrome.tabs = originalTabs;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Execute Override (metadata injection)
  // -----------------------------------------------------------------------
  describe('execute() override', () => {
    it('should inject action into metadata', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.metadata?.action).toBe('screenshot');
    });

    it('should inject click action into metadata', async () => {
      setupDebuggerViewport();
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.action).toBe('click');
    });

    it('should preserve existing metadata while adding action', async () => {
      const result = await tool.execute(
        { action: 'screenshot' },
        { metadata: { tabId: 1, customField: 'value' } }
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.action).toBe('screenshot');
      expect(result.metadata?.customField).toBe('value');
    });

    it('should handle missing options gracefully', async () => {
      // options is undefined, but still needs tabId for executeImpl
      // so this should fail at tabId validation, not at metadata injection
      const result = await tool.execute({ action: 'screenshot' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should handle empty metadata in options', async () => {
      const result = await tool.execute(
        { action: 'screenshot' },
        { metadata: { tabId: 1 } }
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.action).toBe('screenshot');
    });
  });

  // -----------------------------------------------------------------------
  // Screenshot Action
  // -----------------------------------------------------------------------
  describe('screenshot action', () => {
    it('should capture viewport screenshot successfully', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        image_file_id: 'screenshot_cache',
        width: 1280,
        height: 720,
        format: 'png',
        viewport_bounds: { width: 1280, height: 720, scroll_x: 0, scroll_y: 0 },
      });
    });

    it('should call ScreenshotService.forTab with correct tabId', async () => {
      await tool.execute({ action: 'screenshot' }, withTab(42));
      expect(mocks.screenshotServiceForTab).toHaveBeenCalledWith(42);
    });

    it('should call captureViewport when no scroll_offset provided', async () => {
      await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(mocks.screenshotServiceCaptureViewport).toHaveBeenCalled();
      expect(mocks.screenshotServiceCaptureWithScroll).not.toHaveBeenCalled();
    });

    it('should call captureWithScroll when scroll_offset is provided', async () => {
      await tool.execute(
        { action: 'screenshot', scroll_offset: { x: 0, y: 500 } },
        withTab(1)
      );
      expect(mocks.screenshotServiceCaptureWithScroll).toHaveBeenCalledWith({ x: 0, y: 500 });
      expect(mocks.screenshotServiceCaptureViewport).not.toHaveBeenCalled();
    });

    it('should save screenshot via ScreenshotFileManager', async () => {
      await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(mocks.screenshotFileManagerSaveScreenshot).toHaveBeenCalledWith('base64screenshot');
    });

    it('should save scrolled screenshot data', async () => {
      await tool.execute(
        { action: 'screenshot', scroll_offset: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(mocks.screenshotFileManagerSaveScreenshot).toHaveBeenCalledWith('base64screenshotScrolled');
    });

    it('should return fixed image_file_id', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.data.image_file_id).toBe('screenshot_cache');
    });

    it('should return png format', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.data.format).toBe('png');
    });

    it('should fail when ScreenshotService.forTab throws', async () => {
      mocks.screenshotServiceForTab.mockRejectedValueOnce(
        new Error('CDP_CONNECTION_LOST: Cannot attach debugger')
      );
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('CDP_CONNECTION_LOST');
    });

    it('should fail when captureViewport throws', async () => {
      mocks.screenshotServiceCaptureViewport.mockRejectedValueOnce(
        new Error('SCREENSHOT_FAILED: Page.captureScreenshot failed')
      );
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('SCREENSHOT_FAILED');
    });

    it('should fail when ScreenshotFileManager.saveScreenshot throws', async () => {
      mocks.screenshotFileManagerSaveScreenshot.mockRejectedValueOnce(
        new Error('FILE_STORAGE_ERROR: Storage not available')
      );
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('FILE_STORAGE_ERROR');
    });

    it('should fail when captureWithScroll throws', async () => {
      mocks.screenshotServiceCaptureWithScroll.mockRejectedValueOnce(
        new Error('SCREENSHOT_FAILED: scroll timeout')
      );
      const result = await tool.execute(
        { action: 'screenshot', scroll_offset: { x: 0, y: 100 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('SCREENSHOT_FAILED');
    });

    it('should include viewport bounds from the screenshot service', async () => {
      const customViewport = { width: 1920, height: 1080, scroll_x: 100, scroll_y: 200 };
      mocks.screenshotServiceCaptureViewport.mockResolvedValueOnce({
        base64Data: 'data',
        viewport: customViewport,
      });
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.data.width).toBe(1920);
      expect(result.data.height).toBe(1080);
      expect(result.data.viewport_bounds).toEqual(customViewport);
    });
  });

  // -----------------------------------------------------------------------
  // Click Action
  // -----------------------------------------------------------------------
  describe('click action', () => {
    it('should execute click at coordinates', async () => {
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.coordinates_used).toEqual({ x: 100, y: 200 });
      expect(result.data.action_timestamp).toBeDefined();
    });

    it('should fail when coordinates are missing', async () => {
      const result = await tool.execute({ action: 'click' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinates required for click action');
    });

    it('should call CoordinateActionService.forTab with correct tabId', async () => {
      await tool.execute(
        { action: 'click', coordinates: { x: 50, y: 50 } },
        withTab(7)
      );
      expect(mocks.coordinateActionServiceForTab).toHaveBeenCalledWith(7);
    });

    it('should call clickAt with coordinates and options', async () => {
      await tool.execute(
        {
          action: 'click',
          coordinates: { x: 100, y: 200 },
          options: { button: 'right', modifiers: { ctrl: true }, wait_after_action: 500 },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 100, y: 200 },
        { button: 'right', modifiers: { ctrl: true }, waitAfter: 500 }
      );
    });

    it('should use default wait_after_action of 100ms when not specified', async () => {
      await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 100, y: 200 },
        { button: undefined, modifiers: undefined, waitAfter: 100 }
      );
    });

    it('should validate coordinates via CDP before clicking', async () => {
      await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(chromeMock().debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Runtime.evaluate',
        expect.objectContaining({
          expression: expect.stringContaining('window.innerWidth'),
        })
      );
    });

    it('should fail when CoordinateActionService.forTab throws', async () => {
      mocks.coordinateActionServiceForTab.mockRejectedValueOnce(
        new Error('CDP_CONNECTION_LOST')
      );
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('CDP_CONNECTION_LOST');
    });

    it('should fail when clickAt throws', async () => {
      mocks.coordinateActionServiceClickAt.mockRejectedValueOnce(
        new Error('COORDINATE_CLICK_FAILED')
      );
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('COORDINATE_CLICK_FAILED');
    });

    it('should return action_timestamp as ISO string', async () => {
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      // Verify it is a valid ISO date string
      const parsed = new Date(result.data.action_timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });

    it('should pass button: middle option correctly', async () => {
      await tool.execute(
        {
          action: 'click',
          coordinates: { x: 50, y: 50 },
          options: { button: 'middle' },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 50, y: 50 },
        expect.objectContaining({ button: 'middle' })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Type Action
  // -----------------------------------------------------------------------
  describe('type action', () => {
    it('should execute type at coordinates with text', async () => {
      const result = await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 }, text: 'hello world' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.coordinates_used).toEqual({ x: 100, y: 200 });
      expect(result.data.action_timestamp).toBeDefined();
    });

    it('should fail when coordinates are missing', async () => {
      const result = await tool.execute(
        { action: 'type', text: 'hello' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinates required for type action');
    });

    it('should fail when text is missing', async () => {
      const result = await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('text required for type action');
    });

    it('should fail when both coordinates and text are missing', async () => {
      const result = await tool.execute({ action: 'type' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinates required for type action');
    });

    it('should call typeAt with correct parameters', async () => {
      await tool.execute(
        {
          action: 'type',
          coordinates: { x: 300, y: 400 },
          text: 'test input',
          options: { wait_after_action: 250 },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceTypeAt).toHaveBeenCalledWith(
        { x: 300, y: 400 },
        'test input',
        { waitAfter: 250 }
      );
    });

    it('should use default wait_after_action of 100ms when not specified', async () => {
      await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 }, text: 'text' },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceTypeAt).toHaveBeenCalledWith(
        { x: 100, y: 200 },
        'text',
        { waitAfter: 100 }
      );
    });

    it('should fail when typeAt throws', async () => {
      mocks.coordinateActionServiceTypeAt.mockRejectedValueOnce(
        new Error('COORDINATE_TYPE_FAILED')
      );
      const result = await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 }, text: 'hello' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('COORDINATE_TYPE_FAILED');
    });

    it('should validate coordinates before typing', async () => {
      await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 }, text: 'test' },
        withTab(1)
      );
      expect(chromeMock().debugger.sendCommand).toHaveBeenCalledWith(
        { tabId: 1 },
        'Runtime.evaluate',
        expect.any(Object)
      );
    });

    it('should handle empty string text', async () => {
      // Empty string is falsy, so this should fail validation
      const result = await tool.execute(
        { action: 'type', coordinates: { x: 100, y: 200 }, text: '' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('text required for type action');
    });
  });

  // -----------------------------------------------------------------------
  // Scroll Action
  // -----------------------------------------------------------------------
  describe('scroll action', () => {
    it('should execute scroll to coordinates', async () => {
      const result = await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 500 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.coordinates_used).toEqual({ x: 0, y: 500 });
      expect(result.data.action_timestamp).toBeDefined();
    });

    it('should fail when coordinates are missing', async () => {
      const result = await tool.execute({ action: 'scroll' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('coordinates required for scroll action');
    });

    it('should call scrollTo with correct parameters', async () => {
      await tool.execute(
        {
          action: 'scroll',
          coordinates: { x: 200, y: 800 },
          options: { wait_after_action: 300 },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceScrollTo).toHaveBeenCalledWith(
        { x: 200, y: 800 },
        { waitAfter: 300 }
      );
    });

    it('should use default wait_after_action of 200ms for scroll', async () => {
      await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 500 } },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceScrollTo).toHaveBeenCalledWith(
        { x: 0, y: 500 },
        { waitAfter: 200 }
      );
    });

    it('should NOT validate coordinates for scroll (no validateCoordinates call)', async () => {
      // scroll action does not call validateCoordinates
      await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 500 } },
        withTab(1)
      );
      // debugger.sendCommand should not have been called for coordinate validation
      expect(chromeMock().debugger.sendCommand).not.toHaveBeenCalled();
    });

    it('should fail when scrollTo throws', async () => {
      mocks.coordinateActionServiceScrollTo.mockRejectedValueOnce(
        new Error('COORDINATE_SCROLL_FAILED')
      );
      const result = await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 500 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('COORDINATE_SCROLL_FAILED');
    });

    it('should call CoordinateActionService.forTab for scroll', async () => {
      await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 500 } },
        withTab(5)
      );
      expect(mocks.coordinateActionServiceForTab).toHaveBeenCalledWith(5);
    });
  });

  // -----------------------------------------------------------------------
  // Keypress Action
  // -----------------------------------------------------------------------
  describe('keypress action', () => {
    it('should execute keypress with key', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.action_timestamp).toBeDefined();
    });

    it('should fail when key is missing', async () => {
      const result = await tool.execute({ action: 'keypress' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('key required for keypress action');
    });

    it('should fail when key is empty string', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: '' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('key required for keypress action');
    });

    it('should call keypressAt with correct key and options', async () => {
      await tool.execute(
        {
          action: 'keypress',
          key: 'Escape',
          options: { modifiers: { shift: true }, wait_after_action: 50 },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceKeypressAt).toHaveBeenCalledWith(
        'Escape',
        { modifiers: { shift: true }, waitAfter: 50 }
      );
    });

    it('should use default wait_after_action of 100ms for keypress', async () => {
      await tool.execute(
        { action: 'keypress', key: 'Tab' },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceKeypressAt).toHaveBeenCalledWith(
        'Tab',
        { modifiers: undefined, waitAfter: 100 }
      );
    });

    it('should not include coordinates_used in keypress response', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.coordinates_used).toBeUndefined();
    });

    it('should fail when keypressAt throws', async () => {
      mocks.coordinateActionServiceKeypressAt.mockRejectedValueOnce(
        new Error('COORDINATE_KEYPRESS_FAILED')
      );
      const result = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('COORDINATE_KEYPRESS_FAILED');
    });

    it('should support ArrowDown key', async () => {
      await tool.execute(
        { action: 'keypress', key: 'ArrowDown' },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceKeypressAt).toHaveBeenCalledWith(
        'ArrowDown',
        expect.any(Object)
      );
    });

    it('should pass modifiers with ctrl and alt', async () => {
      await tool.execute(
        {
          action: 'keypress',
          key: 'a',
          options: { modifiers: { ctrl: true, alt: true } },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceKeypressAt).toHaveBeenCalledWith(
        'a',
        expect.objectContaining({ modifiers: { ctrl: true, alt: true } })
      );
    });
  });

  // -----------------------------------------------------------------------
  // Unknown Action
  // -----------------------------------------------------------------------
  describe('Unknown Action', () => {
    it('should fail for an unknown action string', async () => {
      const result = await tool.execute(
        { action: 'hover' } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action: hover');
    });

    it('should fail for another unknown action', async () => {
      const result = await tool.execute(
        { action: 'drag' } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown action: drag');
    });
  });

  // -----------------------------------------------------------------------
  // Coordinate Validation and Clipping
  // -----------------------------------------------------------------------
  describe('Coordinate Validation and Clipping', () => {
    it('should clip coordinates that exceed viewport width', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 1000, y: 300 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      // After clipping, x should be 799 (width-1), y should stay 300
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 799, y: 300 },
        expect.any(Object)
      );
    });

    it('should clip coordinates that exceed viewport height', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 400, y: 800 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 400, y: 599 },
        expect.any(Object)
      );
    });

    it('should clip negative x coordinate to 0', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: -50, y: 300 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 0, y: 300 },
        expect.any(Object)
      );
    });

    it('should clip negative y coordinate to 0', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 400, y: -100 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 400, y: 0 },
        expect.any(Object)
      );
    });

    it('should clip both negative coordinates to 0', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: -10, y: -20 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 0, y: 0 },
        expect.any(Object)
      );
    });

    it('should clip both coordinates that exceed viewport', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 2000, y: 1500 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 799, y: 599 },
        expect.any(Object)
      );
    });

    it('should not clip coordinates that are within bounds', async () => {
      setupDebuggerViewport({ width: 1280, height: 720 });
      const coords = { x: 640, y: 360 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 640, y: 360 },
        expect.any(Object)
      );
    });

    it('should handle coordinates at exact viewport boundary (width-1, height-1)', async () => {
      setupDebuggerViewport({ width: 1280, height: 720 });
      const coords = { x: 1279, y: 719 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 1279, y: 719 },
        expect.any(Object)
      );
    });

    it('should clip coordinates at exactly viewport width and height', async () => {
      setupDebuggerViewport({ width: 1280, height: 720 });
      const coords = { x: 1280, y: 720 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 1279, y: 719 },
        expect.any(Object)
      );
    });

    it('should handle zero coordinates', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 0, y: 0 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 0, y: 0 },
        expect.any(Object)
      );
    });

    it('should fail when viewport bounds cannot be retrieved', async () => {
      chromeMock().debugger.sendCommand.mockResolvedValueOnce({});
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to get viewport bounds');
    });

    it('should fail when debugger.sendCommand returns null result', async () => {
      chromeMock().debugger.sendCommand.mockResolvedValueOnce(null);
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to get viewport bounds');
    });

    it('should fail when debugger.sendCommand throws', async () => {
      chromeMock().debugger.sendCommand.mockRejectedValueOnce(
        new Error('Debugger detached')
      );
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 } },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Debugger detached');
    });

    it('should also clip coordinates for the type action', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 900, y: 700 };
      await tool.execute(
        { action: 'type', coordinates: coords, text: 'test' },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceTypeAt).toHaveBeenCalledWith(
        { x: 799, y: 599 },
        'test',
        expect.any(Object)
      );
    });

    it('should modify the coordinates object in-place', async () => {
      setupDebuggerViewport({ width: 800, height: 600 });
      const coords = { x: 1000, y: 1000 };
      await tool.execute(
        { action: 'click', coordinates: coords },
        withTab(1)
      );
      // The returned coordinates_used should be the clipped values
      // because validateCoordinates modifies in-place
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 799, y: 599 },
        expect.any(Object)
      );
    });
  });

  // -----------------------------------------------------------------------
  // Logging
  // -----------------------------------------------------------------------
  describe('Logging', () => {
    it('should log error when screenshot fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.screenshotServiceForTab.mockRejectedValueOnce(
        new Error('CDP error')
      );
      await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[PageVisionTool]',
        expect.stringContaining('Screenshot failed'),
        expect.any(Object)
      );
      consoleErrorSpy.mockRestore();
    });

    it('should call log with debug level', () => {
      const consoleDebugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      (tool as any).log('debug', 'test debug message', { data: 'value' });
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        '[PageVisionTool]',
        'test debug message',
        { data: 'value' }
      );
      consoleDebugSpy.mockRestore();
    });

    it('should call log with info level', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      (tool as any).log('info', 'test info message');
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[PageVisionTool]',
        'test info message',
        undefined
      );
      consoleLogSpy.mockRestore();
    });

    it('should call log with error level', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (tool as any).log('error', 'test error message', { errorInfo: 'details' });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[PageVisionTool]',
        'test error message',
        { errorInfo: 'details' }
      );
      consoleErrorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // validateChromeContext (protected method)
  // -----------------------------------------------------------------------
  describe('validateChromeContext', () => {
    it('should not throw when chrome and chrome.tabs exist', () => {
      expect(() => (tool as any).validateChromeContext()).not.toThrow();
    });

    it('should throw when chrome is undefined', () => {
      const original = (globalThis as any).chrome;
      delete (globalThis as any).chrome;
      try {
        expect(() => (tool as any).validateChromeContext()).toThrow(
          'Chrome extension context required'
        );
      } finally {
        (globalThis as any).chrome = original;
      }
    });

    it('should throw when chrome.tabs is undefined', () => {
      const originalTabs = (globalThis as any).chrome.tabs;
      delete (globalThis as any).chrome.tabs;
      try {
        expect(() => (tool as any).validateChromeContext()).toThrow(
          'Chrome extension context required'
        );
      } finally {
        (globalThis as any).chrome.tabs = originalTabs;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Response Metadata
  // -----------------------------------------------------------------------
  describe('Response Metadata', () => {
    it('should include toolName in metadata on success', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.metadata?.toolName).toBe('page_vision');
    });

    it('should include duration in metadata on success', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(typeof result.metadata?.duration).toBe('number');
      expect(result.metadata?.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include toolName in metadata on error', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(result.metadata?.toolName).toBe('page_vision');
    });

    it('should include duration in metadata on error', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(typeof result.metadata?.duration).toBe('number');
    });

    it('should include errorType in metadata on error', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(result.metadata?.errorType).toBe('Error');
    });

    it('should include tabId from options metadata', async () => {
      const result = await tool.execute({ action: 'screenshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.metadata?.tabId).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Integration-like scenarios
  // -----------------------------------------------------------------------
  describe('Integration Scenarios', () => {
    it('should handle screenshot followed by click workflow', async () => {
      // Take screenshot
      const screenshotResult = await tool.execute(
        { action: 'screenshot' },
        withTab(1)
      );
      expect(screenshotResult.success).toBe(true);
      expect(screenshotResult.data.image_file_id).toBe('screenshot_cache');

      // Click at coordinates based on screenshot analysis
      const clickResult = await tool.execute(
        { action: 'click', coordinates: { x: 400, y: 300 } },
        withTab(1)
      );
      expect(clickResult.success).toBe(true);
      expect(clickResult.data.coordinates_used).toEqual({ x: 400, y: 300 });
    });

    it('should handle click then type workflow', async () => {
      // Click on input field
      const clickResult = await tool.execute(
        { action: 'click', coordinates: { x: 500, y: 100 } },
        withTab(1)
      );
      expect(clickResult.success).toBe(true);

      // Type text in the focused field
      const typeResult = await tool.execute(
        { action: 'type', coordinates: { x: 500, y: 100 }, text: 'search query' },
        withTab(1)
      );
      expect(typeResult.success).toBe(true);
    });

    it('should handle scroll then screenshot workflow', async () => {
      // Scroll down
      const scrollResult = await tool.execute(
        { action: 'scroll', coordinates: { x: 0, y: 1000 } },
        withTab(1)
      );
      expect(scrollResult.success).toBe(true);

      // Take screenshot after scroll
      const screenshotResult = await tool.execute(
        { action: 'screenshot', scroll_offset: { x: 0, y: 1000 } },
        withTab(1)
      );
      expect(screenshotResult.success).toBe(true);
    });

    it('should handle type followed by keypress Enter workflow', async () => {
      // Type search query
      const typeResult = await tool.execute(
        { action: 'type', coordinates: { x: 500, y: 100 }, text: 'vitest tutorial' },
        withTab(1)
      );
      expect(typeResult.success).toBe(true);

      // Press Enter to submit
      const keypressResult = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(keypressResult.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Edge Cases
  // -----------------------------------------------------------------------
  describe('Edge Cases', () => {
    it('should handle very large coordinates', async () => {
      setupDebuggerViewport({ width: 1920, height: 1080 });
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 999999, y: 999999 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 1919, y: 1079 },
        expect.any(Object)
      );
    });

    it('should handle fractional coordinates', async () => {
      setupDebuggerViewport({ width: 1280, height: 720 });
      const result = await tool.execute(
        { action: 'click', coordinates: { x: 100.5, y: 200.7 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      // Fractional coordinates should pass through since Math.min/max don't round
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 100.5, y: 200.7 },
        expect.any(Object)
      );
    });

    it('should handle scroll_offset with only x', async () => {
      const result = await tool.execute(
        { action: 'screenshot', scroll_offset: { x: 100 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mocks.screenshotServiceCaptureWithScroll).toHaveBeenCalledWith({ x: 100 });
    });

    it('should handle scroll_offset with only y', async () => {
      const result = await tool.execute(
        { action: 'screenshot', scroll_offset: { y: 500 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mocks.screenshotServiceCaptureWithScroll).toHaveBeenCalledWith({ y: 500 });
    });

    it('should handle options with wait_after_action of 0', async () => {
      // 0 is falsy, so it should fall back to default 100
      await tool.execute(
        { action: 'click', coordinates: { x: 100, y: 200 }, options: { wait_after_action: 0 } },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledWith(
        { x: 100, y: 200 },
        expect.objectContaining({ waitAfter: 100 })
      );
    });

    it('should handle keypress with meta modifier', async () => {
      await tool.execute(
        {
          action: 'keypress',
          key: 'c',
          options: { modifiers: { meta: true } },
        },
        withTab(1)
      );
      expect(mocks.coordinateActionServiceKeypressAt).toHaveBeenCalledWith(
        'c',
        expect.objectContaining({ modifiers: { meta: true } })
      );
    });

    it('should handle multiple rapid actions in sequence', async () => {
      for (let i = 0; i < 5; i++) {
        const result = await tool.execute(
          { action: 'click', coordinates: { x: i * 100, y: i * 50 } },
          withTab(1)
        );
        expect(result.success).toBe(true);
      }
      expect(mocks.coordinateActionServiceClickAt).toHaveBeenCalledTimes(5);
    });

    it('should handle tab ID of 0 (valid tab ID)', async () => {
      chromeMock().tabs.get.mockResolvedValue(makeTab({ id: 0 }));
      setupDebuggerViewport();
      const result = await tool.execute({ action: 'screenshot' }, withTab(0));
      expect(result.success).toBe(true);
    });
  });
});
