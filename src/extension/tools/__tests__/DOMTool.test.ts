/**
 * Unit tests for DOMTool
 *
 * Covers: DOMToolErrorCode enum, constructor, tool definition, validateRequest,
 * handleError, execute/executeImpl routing, and action-specific validation.
 *
 * Since validateRequest and handleError are private, we test them indirectly
 * through the public execute() method, which invokes them as part of its
 * standard flow.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DOMTool, DOMToolErrorCode } from '@/extension/tools/DOMTool';
import type { BaseToolOptions } from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Mock DomService — prevent any real CDP calls
//
// vi.mock is hoisted, so we cannot reference top-level variables inside the
// factory.  Instead we use vi.hoisted() which runs before the hoisted mocks.
// ---------------------------------------------------------------------------

const { mockDomServiceInstance, mockForTab } = vi.hoisted(() => {
  const mockDomServiceInstance = {
    getSerializedDom: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    keypress: vi.fn(),
    scroll: vi.fn(),
  };
  const mockForTab = vi.fn().mockResolvedValue(mockDomServiceInstance);
  return { mockDomServiceInstance, mockForTab };
});

vi.mock('@/extension/tools/dom/DomService', () => ({
  DomService: {
    forTab: mockForTab,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build BaseToolOptions with a tabId in metadata */
function withTab(tabId: number): BaseToolOptions {
  return { metadata: { tabId } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DOMTool', () => {
  let tool: DOMTool;

  beforeEach(() => {
    const g = globalThis as any;
    const c = g.chrome;

    // Add chrome.tabs.get mock
    c.tabs.get = vi.fn().mockResolvedValue({
      id: 1,
      url: 'https://example.com',
      status: 'complete',
    });

    // Add permissions API
    c.permissions = {
      contains: vi.fn().mockResolvedValue(true),
    };

    // Reset DomService mocks — re-set forTab to return the mock instance
    mockForTab.mockReset().mockResolvedValue(mockDomServiceInstance);
    mockDomServiceInstance.getSerializedDom.mockReset().mockResolvedValue({
      html: '<html></html>',
      nodes: [],
    });
    mockDomServiceInstance.click.mockReset().mockResolvedValue({
      success: true,
      action: 'click',
    });
    mockDomServiceInstance.type.mockReset().mockResolvedValue({
      success: true,
      action: 'type',
    });
    mockDomServiceInstance.keypress.mockReset().mockResolvedValue({
      success: true,
      action: 'keypress',
    });
    mockDomServiceInstance.scroll.mockReset().mockResolvedValue({
      success: true,
      action: 'scroll',
    });

    tool = new DOMTool();
  });

  // =========================================================================
  // DOMToolErrorCode enum
  // =========================================================================

  describe('DOMToolErrorCode', () => {
    it('should define VALIDATION_ERROR', () => {
      expect(DOMToolErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    });

    it('should define TAB_NOT_FOUND', () => {
      expect(DOMToolErrorCode.TAB_NOT_FOUND).toBe('TAB_NOT_FOUND');
    });

    it('should define CONTENT_SCRIPT_NOT_LOADED', () => {
      expect(DOMToolErrorCode.CONTENT_SCRIPT_NOT_LOADED).toBe('CONTENT_SCRIPT_NOT_LOADED');
    });

    it('should define PERMISSION_DENIED', () => {
      expect(DOMToolErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    });

    it('should define ELEMENT_NOT_FOUND', () => {
      expect(DOMToolErrorCode.ELEMENT_NOT_FOUND).toBe('ELEMENT_NOT_FOUND');
    });

    it('should define ACTION_FAILED', () => {
      expect(DOMToolErrorCode.ACTION_FAILED).toBe('ACTION_FAILED');
    });

    it('should define TIMEOUT', () => {
      expect(DOMToolErrorCode.TIMEOUT).toBe('TIMEOUT');
    });

    it('should define UNKNOWN_ERROR', () => {
      expect(DOMToolErrorCode.UNKNOWN_ERROR).toBe('UNKNOWN_ERROR');
    });

    it('should have exactly 8 error codes', () => {
      const values = Object.values(DOMToolErrorCode);
      expect(values).toHaveLength(8);
    });
  });

  // =========================================================================
  // Constructor & Tool Definition
  // =========================================================================

  describe('Constructor & Tool Definition', () => {
    it('should create an instance', () => {
      expect(tool).toBeInstanceOf(DOMTool);
    });

    it('should expose a function-type tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('should be named browser_dom', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('browser_dom');
      }
    });

    it('should declare action as a required parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        expect(def.function.parameters.required).toContain('action');
      }
    });

    it('should include dom category', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).category).toBe('dom');
      }
    });

    it('should be version 3.0.0', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).version).toBe('3.0.0');
      }
    });

    it('should list expected capabilities in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.capabilities).toEqual(
          expect.arrayContaining([
            'dom_snapshot',
            'page_click',
            'page_input',
            'page_keypress',
            'iframe_support',
            'shadow_dom_support',
          ])
        );
      }
    });

    it('should declare required permissions', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.permissions).toEqual(
          expect.arrayContaining(['activeTab', 'scripting', 'tabs'])
        );
      }
    });

    it('should target extension platform', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.platforms).toContain('extension');
      }
    });
  });

  // =========================================================================
  // validateRequest (tested via execute)
  // =========================================================================

  describe('validateRequest', () => {
    it('should reject when action is missing', async () => {
      const result = await tool.execute({} as any, withTab(1));
      expect(result.success).toBe(false);
      // BaseTool catches the missing required param "action"
      expect(result.error).toContain('action');
    });

    it('should reject when action is null', async () => {
      const result = await tool.execute({ action: null } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should reject an invalid action string', async () => {
      const result = await tool.execute({ action: 'destroy' } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid action');
    });

    it('should accept snapshot action with no other params', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
    });

    // --- click validation ---

    it('should reject click when node_id is missing', async () => {
      const result = await tool.execute({ action: 'click' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('node_id is required for click');
    });

    it('should accept click with string node_id in "frameId:backendNodeId" format', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: '0:123' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });

    it('should reject click with numeric node_id (BaseTool schema enforces string type)', async () => {
      // DOMTool's validateRequest accepts numbers for backward compat, but
      // BaseTool's validateParameters runs first and rejects non-string node_id
      // because the tool definition declares node_id as type: 'string'.
      const result = await tool.execute(
        { action: 'click', node_id: 42 },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'node_id' must be a string");
    });

    it('should reject click when string node_id has wrong format (single number)', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: '123' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('frameId:backendNodeId');
    });

    it('should reject click when string node_id has non-numeric parts', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: 'abc:def' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('valid numbers');
    });

    it('should reject click when node_id is a non-integer number', async () => {
      // BaseTool schema validation catches this as a type mismatch (expects string)
      const result = await tool.execute(
        { action: 'click', node_id: 3.14 },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'node_id' must be a string");
    });

    it('should reject click when node_id is a boolean', async () => {
      // BaseTool schema validation catches this as a type mismatch (expects string)
      const result = await tool.execute(
        { action: 'click', node_id: true } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'node_id' must be a string");
    });

    // --- type validation ---

    it('should reject type when node_id is missing', async () => {
      const result = await tool.execute(
        { action: 'type', text: 'hello' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('node_id is required for type');
    });

    it('should reject type when text is missing', async () => {
      const result = await tool.execute(
        { action: 'type', node_id: '0:1' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('text is required for type action');
    });

    it('should reject type when text is null', async () => {
      // BaseTool schema validation catches null before DOMTool's validateRequest
      const result = await tool.execute(
        { action: 'type', node_id: '0:1', text: null } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'text' cannot be null");
    });

    it('should reject type when text is a number instead of string', async () => {
      // BaseTool schema validation catches type mismatch before DOMTool's validateRequest
      const result = await tool.execute(
        { action: 'type', node_id: '0:1', text: 42 } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'text' must be a string");
    });

    it('should accept type with empty string text (for deletion)', async () => {
      const result = await tool.execute(
        { action: 'type', node_id: '0:1', text: '' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });

    it('should accept type with all valid params', async () => {
      const result = await tool.execute(
        { action: 'type', node_id: '0:5', text: 'hello world' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });

    // --- keypress validation ---

    it('should reject keypress when key is missing', async () => {
      const result = await tool.execute({ action: 'keypress' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('key is required for keypress');
    });

    it('should reject keypress when key is empty string', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: '' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('key is required for keypress');
    });

    it('should reject keypress when key is a number', async () => {
      // BaseTool schema validation catches type mismatch before DOMTool's validateRequest
      const result = await tool.execute(
        { action: 'keypress', key: 13 } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("'key' must be a string");
    });

    it('should accept keypress with a valid key', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });

    // --- scroll validation ---

    it('should reject scroll when node_id is missing', async () => {
      const result = await tool.execute({ action: 'scroll' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('node_id is required for scroll');
    });

    it('should accept scroll with valid node_id', async () => {
      const result = await tool.execute(
        { action: 'scroll', node_id: '0:10' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });

    // --- node_id format validation (shared across actions) ---

    it('should reject node_id with three colon-separated parts', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: '0:1:2' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('frameId:backendNodeId');
    });
  });

  // =========================================================================
  // Tab ID Validation (inside executeImpl)
  // =========================================================================

  describe('Tab ID Validation', () => {
    it('should fail when tabId is missing from options metadata', async () => {
      const result = await tool.execute({ action: 'snapshot' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should fail when tabId is -1', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab cannot be found');
    });

    it('should fail when chrome.tabs.get rejects (tab does not exist)', async () => {
      (globalThis as any).chrome.tabs.get.mockRejectedValueOnce(
        new Error('No tab with id: 999')
      );
      const result = await tool.execute({ action: 'snapshot' }, withTab(999));
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or inaccessible');
    });
  });

  // =========================================================================
  // execute - action routing
  // =========================================================================

  describe('execute - action routing', () => {
    it('should route snapshot to DomService.getSerializedDom', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.getSerializedDom).toHaveBeenCalled();
    });

    it('should route click to DomService.click with node_id', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: '0:42' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.click).toHaveBeenCalledWith('0:42');
    });

    it('should route type to DomService.type with node_id, text, and options', async () => {
      const opts = { clearFirst: true };
      const result = await tool.execute(
        { action: 'type', node_id: '0:5', text: 'hello', options: opts },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.type).toHaveBeenCalledWith('0:5', 'hello', opts);
    });

    it('should route keypress to DomService.keypress with key', async () => {
      const result = await tool.execute(
        { action: 'keypress', key: 'Escape' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.keypress).toHaveBeenCalledWith('Escape', undefined);
    });

    it('should route keypress with modifiers to DomService.keypress', async () => {
      const result = await tool.execute(
        {
          action: 'keypress',
          key: 'a',
          options: { modifiers: { ctrl: true, shift: true, alt: false } },
        },
        withTab(1)
      );
      expect(result.success).toBe(true);
      // Only enabled modifiers are passed, capitalized
      expect(mockDomServiceInstance.keypress).toHaveBeenCalledWith(
        'a',
        expect.arrayContaining(['Ctrl', 'Shift'])
      );
      // alt: false should NOT be included
      const passedModifiers = mockDomServiceInstance.keypress.mock.calls[0][1];
      expect(passedModifiers).not.toContain('Alt');
    });

    it('should route scroll to DomService.scroll with node_id, scrollX, scrollY', async () => {
      const result = await tool.execute(
        { action: 'scroll', node_id: '0:1', options: { scrollX: 100, scrollY: 500 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.scroll).toHaveBeenCalledWith('0:1', 100, 500);
    });

    it('should default scrollX to 0 when not provided', async () => {
      const result = await tool.execute(
        { action: 'scroll', node_id: '0:1', options: { scrollY: 300 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.scroll).toHaveBeenCalledWith('0:1', 0, 300);
    });

    it('should pass undefined scrollY when not provided (triggers default in DomService)', async () => {
      const result = await tool.execute(
        { action: 'scroll', node_id: '0:1' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(mockDomServiceInstance.scroll).toHaveBeenCalledWith('0:1', 0, undefined);
    });

    it('should return data from DomService for snapshot', async () => {
      const mockDom = { html: '<div>test</div>', nodes: [{ id: 1 }] };
      mockDomServiceInstance.getSerializedDom.mockResolvedValueOnce(mockDom);

      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockDom);
    });

    it('should return data from DomService for click', async () => {
      const mockResult = { success: true, action: 'click', elementTag: 'button' };
      mockDomServiceInstance.click.mockResolvedValueOnce(mockResult);

      const result = await tool.execute(
        { action: 'click', node_id: '0:7' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResult);
    });
  });

  // =========================================================================
  // execute - error handling (handleError tested indirectly)
  // =========================================================================

  describe('execute - error handling', () => {
    it('should return failure when DomService.getSerializedDom throws', async () => {
      mockDomServiceInstance.getSerializedDom.mockRejectedValueOnce(
        new Error('CDP connection failed')
      );

      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('CDP connection failed');
    });

    it('should return failure when DomService.click throws', async () => {
      mockDomServiceInstance.click.mockRejectedValueOnce(
        new Error('Element not found for node_id 0:999')
      );

      const result = await tool.execute(
        { action: 'click', node_id: '0:999' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Element not found');
    });

    it('should return failure when DomService.type throws', async () => {
      mockDomServiceInstance.type.mockRejectedValueOnce(
        new Error('action failed for type')
      );

      const result = await tool.execute(
        { action: 'type', node_id: '0:1', text: 'test' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('action failed');
    });

    it('should return failure when DomService.keypress throws', async () => {
      mockDomServiceInstance.keypress.mockRejectedValueOnce(
        new Error('keypress timed out')
      );

      const result = await tool.execute(
        { action: 'keypress', key: 'Enter' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should return failure when DomService.scroll throws', async () => {
      mockDomServiceInstance.scroll.mockRejectedValueOnce(
        new Error('Could not establish connection')
      );

      const result = await tool.execute(
        { action: 'scroll', node_id: '0:1' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not establish connection');
    });

    it('should fail when Chrome extension APIs are not available', async () => {
      const saved = (globalThis as any).chrome;
      (globalThis as any).chrome = undefined;

      try {
        const result = await tool.execute({ action: 'snapshot' }, withTab(1));
        expect(result.success).toBe(false);
        expect(result.error).toContain('Chrome extension APIs not available');
      } finally {
        (globalThis as any).chrome = saved;
      }
    });

    it('should fail when required permissions are missing', async () => {
      (globalThis as any).chrome.permissions.contains.mockResolvedValueOnce(false);

      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required permissions');
    });
  });

  // =========================================================================
  // execute - metadata enrichment
  // =========================================================================

  describe('execute - metadata enrichment', () => {
    it('should inject action into metadata on success', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.action).toBe('snapshot');
    });

    it('should inject action into metadata for click', async () => {
      const result = await tool.execute(
        { action: 'click', node_id: '0:1' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.metadata!.action).toBe('click');
    });

    it('should preserve existing metadata from options', async () => {
      const result = await tool.execute(
        { action: 'snapshot' },
        { metadata: { tabId: 1, sessionId: 'sess_123' } }
      );
      expect(result.success).toBe(true);
      expect(result.metadata!.tabId).toBe(1);
      expect(result.metadata!.sessionId).toBe('sess_123');
      expect(result.metadata!.action).toBe('snapshot');
    });

    it('should include toolName as browser_dom in metadata', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.metadata!.toolName).toBe('browser_dom');
    });

    it('should include duration in metadata', async () => {
      const result = await tool.execute({ action: 'snapshot' }, withTab(1));
      expect(result.success).toBe(true);
      expect(typeof result.metadata!.duration).toBe('number');
      expect(result.metadata!.duration).toBeGreaterThanOrEqual(0);
    });
  });

  // =========================================================================
  // handleError (tested by constructing a subclass with access)
  // =========================================================================

  describe('handleError - error classification', () => {
    /**
     * We cannot directly call the private handleError method, but we can
     * verify its behavior by checking the DOMToolErrorCode enum values are
     * correct and the error mapping logic is consistent with the error
     * messages produced by executeImpl error paths.
     *
     * We also create a TestDOMTool subclass to expose the private method.
     */

    // Create a test subclass that exposes handleError
    class TestDOMTool extends DOMTool {
      public callHandleError(error: any, action: string, tabId: number, duration: number) {
        return (this as any).handleError(error, action, tabId, duration);
      }

      public callValidateRequest(request: unknown) {
        return (this as any).validateRequest(request);
      }
    }

    let testTool: TestDOMTool;

    beforeEach(() => {
      testTool = new TestDOMTool();
    });

    it('should classify "not found" errors as TAB_NOT_FOUND', () => {
      const response = testTool.callHandleError(
        new Error('No tab with id: not found'),
        'snapshot',
        1,
        100
      );
      expect(response.success).toBe(false);
      expect(response.error.code).toBe(DOMToolErrorCode.TAB_NOT_FOUND);
    });

    it('should classify "No tab with id" errors as TAB_NOT_FOUND', () => {
      const response = testTool.callHandleError(
        new Error('No tab with id 42'),
        'click',
        42,
        50
      );
      expect(response.error.code).toBe(DOMToolErrorCode.TAB_NOT_FOUND);
    });

    it('should classify "Could not establish connection" as CONTENT_SCRIPT_NOT_LOADED', () => {
      const response = testTool.callHandleError(
        new Error('Could not establish connection to content script'),
        'type',
        1,
        200
      );
      expect(response.error.code).toBe(DOMToolErrorCode.CONTENT_SCRIPT_NOT_LOADED);
    });

    it('should classify "Element ... not found" as TAB_NOT_FOUND due to "not found" taking priority', () => {
      // Note: The ELEMENT_NOT_FOUND branch is unreachable in the current
      // implementation because "not found" in the first condition matches
      // before the "Element" + "not found" check can trigger.
      const response = testTool.callHandleError(
        new Error('Element with id 0:123 not found'),
        'click',
        1,
        150
      );
      expect(response.error.code).toBe(DOMToolErrorCode.TAB_NOT_FOUND);
    });

    it('should classify "action failed" as ACTION_FAILED', () => {
      const response = testTool.callHandleError(
        new Error('click action failed'),
        'click',
        1,
        100
      );
      expect(response.error.code).toBe(DOMToolErrorCode.ACTION_FAILED);
    });

    it('should classify "timeout" errors as TIMEOUT', () => {
      const response = testTool.callHandleError(
        new Error('Operation timeout waiting for element'),
        'scroll',
        1,
        30000
      );
      expect(response.error.code).toBe(DOMToolErrorCode.TIMEOUT);
    });

    it('should classify "timed out" errors as TIMEOUT', () => {
      const response = testTool.callHandleError(
        new Error('Request timed out after 30s'),
        'snapshot',
        1,
        30000
      );
      expect(response.error.code).toBe(DOMToolErrorCode.TIMEOUT);
    });

    it('should classify "permission" errors as PERMISSION_DENIED', () => {
      const response = testTool.callHandleError(
        new Error('Insufficient permission to access tab'),
        'snapshot',
        1,
        50
      );
      expect(response.error.code).toBe(DOMToolErrorCode.PERMISSION_DENIED);
    });

    it('should classify "Invalid action" errors as VALIDATION_ERROR', () => {
      const response = testTool.callHandleError(
        new Error('Invalid action: destroy'),
        'destroy',
        1,
        10
      );
      expect(response.error.code).toBe(DOMToolErrorCode.VALIDATION_ERROR);
    });

    it('should classify "is required" errors as VALIDATION_ERROR', () => {
      const response = testTool.callHandleError(
        new Error('node_id is required for click action'),
        'click',
        1,
        10
      );
      expect(response.error.code).toBe(DOMToolErrorCode.VALIDATION_ERROR);
    });

    it('should classify unrecognized errors as UNKNOWN_ERROR', () => {
      const response = testTool.callHandleError(
        new Error('Something completely unexpected happened'),
        'snapshot',
        1,
        100
      );
      expect(response.error.code).toBe(DOMToolErrorCode.UNKNOWN_ERROR);
    });

    it('should handle non-Error values (string)', () => {
      const response = testTool.callHandleError(
        'raw string error',
        'click',
        1,
        50
      );
      expect(response.success).toBe(false);
      expect(response.error.message).toBe('raw string error');
    });

    it('should handle null/undefined error', () => {
      const response = testTool.callHandleError(null, 'click', 1, 50);
      expect(response.success).toBe(false);
      expect(response.error.message).toBe('null');
    });

    it('should include action and tabId in error details', () => {
      const response = testTool.callHandleError(
        new Error('test error'),
        'keypress',
        42,
        100
      );
      expect(response.error.details.action).toBe('keypress');
      expect(response.error.details.tabId).toBe(42);
    });

    it('should include stack trace in details for Error objects', () => {
      const error = new Error('with stack');
      const response = testTool.callHandleError(error, 'type', 1, 100);
      expect(response.error.details.stack).toBeDefined();
      expect(response.error.details.stack).toContain('with stack');
    });

    it('should have undefined stack for non-Error values', () => {
      const response = testTool.callHandleError('string error', 'click', 1, 50);
      expect(response.error.details.stack).toBeUndefined();
    });

    it('should set metadata correctly', () => {
      const response = testTool.callHandleError(
        new Error('test'),
        'snapshot',
        7,
        250
      );
      expect(response.metadata.duration).toBe(250);
      expect(response.metadata.toolName).toBe('browser_dom');
      expect(response.metadata.tabId).toBe(7);
    });

    // --- validateRequest direct tests ---

    it('validateRequest should return error for non-object request', () => {
      expect(testTool.callValidateRequest(null)).toBe('Request must be an object');
      expect(testTool.callValidateRequest(undefined)).toBe('Request must be an object');
      expect(testTool.callValidateRequest('string')).toBe('Request must be an object');
    });

    it('validateRequest should return error for invalid action value', () => {
      const error = testTool.callValidateRequest({ action: 'hover' });
      expect(error).toContain('Invalid action: hover');
    });

    it('validateRequest should return null for valid snapshot', () => {
      expect(testTool.callValidateRequest({ action: 'snapshot' })).toBeNull();
    });

    it('validateRequest should return null for valid click with string node_id', () => {
      expect(testTool.callValidateRequest({ action: 'click', node_id: '1:456' })).toBeNull();
    });

    it('validateRequest should return null for valid click with numeric node_id', () => {
      expect(testTool.callValidateRequest({ action: 'click', node_id: 42 })).toBeNull();
    });

    it('validateRequest should return error for missing action', () => {
      const error = testTool.callValidateRequest({ node_id: '0:1' });
      expect(error).toContain('Invalid action');
    });
  });
});
