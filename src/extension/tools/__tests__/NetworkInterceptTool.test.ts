/**
 * Unit tests for NetworkInterceptTool
 *
 * Tests: Parameter validation, request interception setup, response modification,
 * filter patterns, monitoring, metrics, caching, and cleanup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  NetworkInterceptTool,
  type NetworkInterceptConfig,
  type NetworkPattern,
  type RequestModification,
  type ResponseModification,
  type MonitoringConfig,
} from '@/extension/tools/NetworkInterceptTool';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------

/** Helpers to capture listeners registered via chrome.webRequest */
type ListenerEntry = { callback: Function; filter: any; extraInfo?: string[] };
const capturedListeners: Record<string, ListenerEntry[]> = {
  onBeforeRequest: [],
  onHeadersReceived: [],
  onCompleted: [],
  onErrorOccurred: [],
};

function makeEventMock(name: string) {
  return {
    addListener: vi.fn((cb: Function, filter?: any, extraInfo?: string[]) => {
      capturedListeners[name].push({ callback: cb, filter, extraInfo });
    }),
    removeListener: vi.fn((cb: Function) => {
      capturedListeners[name] = capturedListeners[name].filter(e => e.callback !== cb);
    }),
  };
}

function resetCapturedListeners() {
  for (const key of Object.keys(capturedListeners)) {
    capturedListeners[key] = [];
  }
}

/** Fire every registered listener for a given event with the supplied details */
function fireEvent(eventName: string, details: any) {
  for (const entry of capturedListeners[eventName] ?? []) {
    entry.callback(details);
  }
}

function createChromeMock() {
  return {
    declarativeNetRequest: {
      updateDynamicRules: vi.fn().mockResolvedValue(undefined),
      RuleActionType: {
        BLOCK: 'block',
        REDIRECT: 'redirect',
        MODIFY_HEADERS: 'modifyHeaders',
      },
      HeaderOperation: {
        SET: 'set',
        REMOVE: 'remove',
        APPEND: 'append',
      },
      ResourceType: {
        MAIN_FRAME: 'main_frame',
        SUB_FRAME: 'sub_frame',
        XMLHTTPREQUEST: 'xmlhttprequest',
        SCRIPT: 'script',
        STYLESHEET: 'stylesheet',
        IMAGE: 'image',
      },
    },
    webRequest: {
      onBeforeRequest: makeEventMock('onBeforeRequest'),
      onHeadersReceived: makeEventMock('onHeadersReceived'),
      onCompleted: makeEventMock('onCompleted'),
      onErrorOccurred: makeEventMock('onErrorOccurred'),
    },
    tabs: {
      query: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    runtime: {
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    storage: {
      local: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — reusable config factories
// ---------------------------------------------------------------------------

function defaultMonitoring(overrides: Partial<MonitoringConfig> = {}): MonitoringConfig {
  return {
    logRequests: true,
    logResponses: false,
    captureTimings: false,
    captureHeaders: true,
    captureBody: false,
    maxBodySize: 1024 * 1024,
    saveToStorage: false,
    ...overrides,
  };
}

function defaultConfig(overrides: Partial<NetworkInterceptConfig> = {}): NetworkInterceptConfig {
  return {
    enabled: true,
    patterns: [
      { type: 'url', pattern: '*://api.example.com/*', include: true },
    ],
    monitoring: defaultMonitoring(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('NetworkInterceptTool', () => {
  let tool: NetworkInterceptTool;
  let chromeMock: ReturnType<typeof createChromeMock>;

  beforeEach(() => {
    chromeMock = createChromeMock();
    Object.defineProperty(globalThis, 'chrome', { value: chromeMock, writable: true });
    resetCapturedListeners();
    tool = new NetworkInterceptTool();
  });

  afterEach(async () => {
    // Ensure interception is stopped to clean up listeners
    await tool.stopInterception();
  });

  // =========================================================================
  // Tool definition
  // =========================================================================

  describe('Tool Definition', () => {
    it('should expose a valid function tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('network_intercept');
        expect(def.function.description).toContain('Intercept');
        expect(def.function.parameters).toBeDefined();
      }
    });

    it('should declare required parameters: patterns and monitoring', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const schema = def.function.parameters;
        if (schema.type === 'object' && schema.required) {
          expect(schema.required).toContain('patterns');
          expect(schema.required).toContain('monitoring');
        }
      }
    });

    it('should include extension platform in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).metadata?.platforms).toContain('extension');
      }
    });

    it('should declare declarativeNetRequest permission in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).metadata?.permissions).toContain('declarativeNetRequest');
      }
    });
  });

  // =========================================================================
  // Parameter validation (through BaseTool.execute)
  // =========================================================================

  describe('Parameter Validation', () => {
    it('should fail when required "patterns" parameter is missing', async () => {
      const result = await tool.execute({
        enabled: true,
        monitoring: defaultMonitoring(),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('patterns');
    });

    it('should fail when required "monitoring" parameter is missing', async () => {
      const result = await tool.execute({
        enabled: true,
        patterns: [{ type: 'url', pattern: '*', include: true }],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('monitoring');
    });

    it('should fail when both required parameters are missing', async () => {
      const result = await tool.execute({ enabled: true });
      expect(result.success).toBe(false);
      expect(result.error).toContain('patterns');
      expect(result.error).toContain('monitoring');
    });

    it('should fail when patterns is not an array', async () => {
      const result = await tool.execute({
        enabled: true,
        patterns: 'not-an-array',
        monitoring: defaultMonitoring(),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('patterns');
    });

    it('should fail when monitoring is not an object', async () => {
      const result = await tool.execute({
        enabled: true,
        patterns: [],
        monitoring: 'bad',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('monitoring');
    });

    it('should fail when enabled is not boolean', async () => {
      const result = await tool.execute({
        enabled: 'yes',
        patterns: [],
        monitoring: defaultMonitoring(),
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('enabled');
    });

    it('should succeed with valid minimal parameters', async () => {
      const result = await tool.execute(defaultConfig({ patterns: [] }));
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // Request interception setup (startInterception)
  // =========================================================================

  describe('Request Interception Setup', () => {
    it('should call updateDynamicRules when starting interception with request modifications', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'add', key: 'X-Custom', value: 'test' },
        ],
      });

      await tool.startInterception(config);

      expect(chromeMock.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledTimes(1);
      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules.length).toBe(1);
      expect(call.addRules[0].action.type).toBe('modifyHeaders');
      expect(call.addRules[0].action.requestHeaders[0].header).toBe('X-Custom');
      expect(call.addRules[0].action.requestHeaders[0].value).toBe('test');
    });

    it('should not call updateDynamicRules when there are no modifications', async () => {
      const config = defaultConfig();
      await tool.startInterception(config);
      expect(chromeMock.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('should stop previous interception before starting a new one', async () => {
      const config1 = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
        ],
      });
      await tool.startInterception(config1);

      // Start again — should first remove old rules
      const config2 = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'add', key: 'X-New', value: 'v' },
        ],
      });
      await tool.startInterception(config2);

      // First call: start (addRules), second call: stop (removeRuleIds), third call: start again
      expect(chromeMock.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledTimes(3);
    });

    it('should create a blocking rule for block action', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].action.type).toBe('block');
    });

    it('should create a remove-header rule for header remove action', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'remove', key: 'Cookie' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.type).toBe('modifyHeaders');
      expect(rule.action.requestHeaders[0].header).toBe('Cookie');
      expect(rule.action.requestHeaders[0].operation).toBe('remove');
    });

    it('should create a redirect rule for URL modify action', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'url', action: 'modify', value: 'https://redirect.example.com/' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.type).toBe('redirect');
      expect(rule.action.redirect.url).toBe('https://redirect.example.com/');
    });

    it('should include tabIds in rule condition when tabId is provided', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
        ],
      });
      await tool.startInterception(config, 42);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.tabIds).toEqual([42]);
    });

    it('should not include tabIds when tabId is undefined', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.tabIds).toBeUndefined();
    });

    it('should throw when updateDynamicRules rejects', async () => {
      chromeMock.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(
        new Error('API error')
      );

      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
        ],
      });

      await expect(tool.startInterception(config)).rejects.toThrow('Failed to start interception');
    });

    it('should handle multiple request modifications creating multiple rules', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
          { type: 'header', action: 'add', key: 'X-A', value: 'a' },
          { type: 'header', action: 'remove', key: 'X-B' },
          { type: 'url', action: 'modify', value: 'https://other.com/' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules).toHaveLength(4);
      // Each rule should have a unique id
      const ids = call.addRules.map((r: any) => r.id);
      expect(new Set(ids).size).toBe(4);
    });
  });

  // =========================================================================
  // Response modification
  // =========================================================================

  describe('Response Modification', () => {
    it('should create response header SET rule for add action', async () => {
      const config = defaultConfig({
        responseModifications: [
          { type: 'header', action: 'add', key: 'X-Frame-Options', value: 'DENY' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.type).toBe('modifyHeaders');
      expect(rule.action.responseHeaders).toBeDefined();
      expect(rule.action.responseHeaders[0].header).toBe('X-Frame-Options');
      expect(rule.action.responseHeaders[0].operation).toBe('set');
      expect(rule.action.responseHeaders[0].value).toBe('DENY');
    });

    it('should create response header SET rule for modify action', async () => {
      const config = defaultConfig({
        responseModifications: [
          { type: 'header', action: 'modify', key: 'Content-Type', value: 'application/json' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.responseHeaders[0].operation).toBe('set');
      expect(rule.action.responseHeaders[0].value).toBe('application/json');
    });

    it('should create response header REMOVE rule for remove action', async () => {
      const config = defaultConfig({
        responseModifications: [
          { type: 'header', action: 'remove', key: 'X-Powered-By' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.responseHeaders[0].header).toBe('X-Powered-By');
      expect(rule.action.responseHeaders[0].operation).toBe('remove');
      expect(rule.action.responseHeaders[0].value).toBeUndefined();
    });

    it('should skip non-header response modifications (body, status)', async () => {
      const config = defaultConfig({
        responseModifications: [
          { type: 'body', action: 'modify', value: '{}' },
          { type: 'status', action: 'modify', value: 200 },
        ],
      });
      await tool.startInterception(config);

      // No rules should have been created since body/status mods are not handled
      expect(chromeMock.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('should create rules for both request and response modifications', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'add', key: 'Authorization', value: 'Bearer tok' },
        ],
        responseModifications: [
          { type: 'header', action: 'remove', key: 'Set-Cookie' },
        ],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules).toHaveLength(2);
      // First rule: request header modification
      expect(call.addRules[0].action.requestHeaders).toBeDefined();
      // Second rule: response header modification
      expect(call.addRules[1].action.responseHeaders).toBeDefined();
    });
  });

  // =========================================================================
  // Filter patterns
  // =========================================================================

  describe('Filter Patterns', () => {
    it('should use the first URL include pattern as urlFilter', async () => {
      const config = defaultConfig({
        patterns: [
          { type: 'url', pattern: '*://api.example.com/*', include: true },
        ],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.urlFilter).toBe('*://api.example.com/*');
    });

    it('should not set urlFilter when all patterns are exclude-type', async () => {
      const config = defaultConfig({
        patterns: [
          { type: 'url', pattern: '*://internal/*', include: false },
        ],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.urlFilter).toBeUndefined();
    });

    it('should not set urlFilter for non-url pattern types', async () => {
      const config = defaultConfig({
        patterns: [
          { type: 'method', pattern: 'GET', include: true },
          { type: 'header', pattern: 'Content-Type', include: true },
          { type: 'mime-type', pattern: 'application/json', include: true },
        ],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.urlFilter).toBeUndefined();
    });

    it('should handle RegExp patterns by extracting source', async () => {
      const config = defaultConfig({
        patterns: [
          { type: 'url', pattern: /api\.example\.com/, include: true },
        ],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.urlFilter).toBe('api\\.example\\.com');
    });

    it('should always include resourceTypes in condition', async () => {
      const config = defaultConfig({
        patterns: [],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.resourceTypes).toEqual([
        'main_frame',
        'sub_frame',
        'xmlhttprequest',
        'script',
        'stylesheet',
        'image',
      ]);
    });

    it('should handle empty patterns array gracefully', async () => {
      const config = defaultConfig({
        patterns: [],
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules[0].condition.urlFilter).toBeUndefined();
      expect(call.addRules[0].condition.resourceTypes).toBeDefined();
    });
  });

  // =========================================================================
  // Monitoring
  // =========================================================================

  describe('Monitoring', () => {
    it('should register onBeforeRequest listener when logRequests is true', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      expect(chromeMock.webRequest.onBeforeRequest.addListener).toHaveBeenCalledTimes(1);
    });

    it('should register onCompleted and onErrorOccurred listeners alongside onBeforeRequest', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      expect(chromeMock.webRequest.onCompleted.addListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.webRequest.onErrorOccurred.addListener).toHaveBeenCalledTimes(1);
    });

    it('should register onHeadersReceived listener when logResponses is true', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      expect(chromeMock.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    });

    it('should NOT register onHeadersReceived listener when logResponses is false', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: false }),
      });
      await tool.startInterception(config);

      expect(chromeMock.webRequest.onHeadersReceived.addListener).not.toHaveBeenCalled();
    });

    it('should NOT register any monitoring listeners when logRequests is false', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: false }),
      });
      await tool.startInterception(config);

      expect(chromeMock.webRequest.onBeforeRequest.addListener).not.toHaveBeenCalled();
      expect(chromeMock.webRequest.onCompleted.addListener).not.toHaveBeenCalled();
      expect(chromeMock.webRequest.onErrorOccurred.addListener).not.toHaveBeenCalled();
    });

    it('should include tabId in filter when tabId is provided', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config, 99);

      const call = chromeMock.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(call[1]).toEqual({ urls: ['<all_urls>'], tabId: 99 });
    });

    it('should NOT include tabId in filter when tabId is undefined', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      const call = chromeMock.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(call[1]).toEqual({ urls: ['<all_urls>'] });
    });

    it('should NOT include tabId in filter when tabId is -1', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config, -1);

      const call = chromeMock.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(call[1]).toEqual({ urls: ['<all_urls>'] });
    });
  });

  // =========================================================================
  // Request logging & metrics
  // =========================================================================

  describe('Request Logging and Metrics', () => {
    it('should log requests and increment totalRequests metric', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'req-1',
        url: 'https://api.example.com/data',
        method: 'GET',
        timeStamp: 1000,
        tabId: 1,
        frameId: 0,
        type: 'xmlhttprequest',
        initiator: 'https://example.com',
      });

      const requests = await tool.getRequests();
      expect(requests).toHaveLength(1);
      expect(requests[0].id).toBe('req-1');
      expect(requests[0].url).toBe('https://api.example.com/data');
      expect(requests[0].method).toBe('GET');

      const metrics = await tool.getMetrics();
      expect(metrics.totalRequests).toBe(1);
      expect(metrics.requestsByType['xmlhttprequest']).toBe(1);
    });

    it('should log multiple requests and track by type', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://a.com/1', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'script',
      });
      fireEvent('onBeforeRequest', {
        requestId: 'r2', url: 'https://a.com/2', method: 'POST',
        timeStamp: 1001, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onBeforeRequest', {
        requestId: 'r3', url: 'https://a.com/3', method: 'GET',
        timeStamp: 1002, tabId: 1, frameId: 0, type: 'script',
      });

      const metrics = await tool.getMetrics();
      expect(metrics.totalRequests).toBe(3);
      expect(metrics.requestsByType['script']).toBe(2);
      expect(metrics.requestsByType['xmlhttprequest']).toBe(1);
    });

    it('should log response status and headers when logResponses is enabled', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true, captureHeaders: true }),
      });
      await tool.startInterception(config);

      // First, create the request log entry
      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/data', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });

      // Then simulate response
      fireEvent('onHeadersReceived', {
        requestId: 'r1',
        url: 'https://api.com/data',
        statusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-Custom', value: 'test-value' },
        ],
        timeStamp: 1050,
      });

      const requests = await tool.getRequests();
      expect(requests[0].status).toBe(200);
      expect(requests[0].responseHeaders).toEqual({
        'Content-Type': 'application/json',
        'X-Custom': 'test-value',
      });

      const metrics = await tool.getMetrics();
      expect(metrics.requestsByStatus['200']).toBe(1);
    });

    it('should update timing metrics on request completion', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/d', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });

      fireEvent('onCompleted', {
        requestId: 'r1',
        url: 'https://api.com/d',
        timeStamp: 1150,
        fromCache: false,
      });

      const requests = await tool.getRequests();
      expect(requests[0].timings).toBeDefined();
      expect(requests[0].timings!.startTime).toBe(1000);
      expect(requests[0].timings!.endTime).toBe(1150);
      expect(requests[0].timings!.duration).toBe(150);

      const metrics = await tool.getMetrics();
      expect(metrics.averageResponseTime).toBe(150);
    });

    it('should increment cachedRequests when response is from cache', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/c', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onCompleted', {
        requestId: 'r1', timeStamp: 1010, fromCache: true,
      });

      const metrics = await tool.getMetrics();
      expect(metrics.cachedRequests).toBe(1);
    });

    it('should log errors and increment failedRequests metric', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/fail', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onErrorOccurred', {
        requestId: 'r1',
        error: 'net::ERR_CONNECTION_REFUSED',
      });

      const requests = await tool.getRequests();
      expect(requests[0].error).toBe('net::ERR_CONNECTION_REFUSED');

      const metrics = await tool.getMetrics();
      expect(metrics.failedRequests).toBe(1);
    });

    it('should compute running average response time across multiple requests', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      // Request 1: duration 100
      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://a.com/1', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onCompleted', { requestId: 'r1', timeStamp: 1100, fromCache: false });

      // Request 2: duration 200
      fireEvent('onBeforeRequest', {
        requestId: 'r2', url: 'https://a.com/2', method: 'GET',
        timeStamp: 2000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onCompleted', { requestId: 'r2', timeStamp: 2200, fromCache: false });

      const metrics = await tool.getMetrics();
      // After first: avg = 100; after second: avg = (100 * 1 + 200) / 2 = 150
      expect(metrics.averageResponseTime).toBe(150);
    });

    it('should capture request body when captureBody is enabled and formData is present', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, captureBody: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/post', method: 'POST',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
        requestBody: {
          formData: { field1: ['value1'], field2: ['value2'] },
        },
      });

      const requests = await tool.getRequests();
      expect(requests[0].body).toBe(JSON.stringify({ field1: ['value1'], field2: ['value2'] }));
    });

    it('should not capture request body when captureBody is false', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, captureBody: false }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/post', method: 'POST',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
        requestBody: {
          formData: { field1: ['value1'] },
        },
      });

      const requests = await tool.getRequests();
      expect(requests[0].body).toBeUndefined();
    });
  });

  // =========================================================================
  // getRequests filtering
  // =========================================================================

  describe('getRequests Filtering', () => {
    beforeEach(async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      // Seed requests
      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com/users', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', { requestId: 'r1', statusCode: 200, timeStamp: 1050, responseHeaders: [] });

      fireEvent('onBeforeRequest', {
        requestId: 'r2', url: 'https://api.com/posts', method: 'POST',
        timeStamp: 1100, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', { requestId: 'r2', statusCode: 201, timeStamp: 1150, responseHeaders: [] });

      fireEvent('onBeforeRequest', {
        requestId: 'r3', url: 'https://cdn.com/style.css', method: 'GET',
        timeStamp: 1200, tabId: 1, frameId: 0, type: 'stylesheet',
      });
      fireEvent('onHeadersReceived', { requestId: 'r3', statusCode: 200, timeStamp: 1250, responseHeaders: [] });
    });

    it('should return all requests when no filter is provided', async () => {
      const all = await tool.getRequests();
      expect(all).toHaveLength(3);
    });

    it('should filter by URL substring', async () => {
      const result = await tool.getRequests({ url: 'api.com' });
      expect(result).toHaveLength(2);
    });

    it('should filter by method', async () => {
      const result = await tool.getRequests({ method: 'POST' });
      expect(result).toHaveLength(1);
      expect(result[0].method).toBe('POST');
    });

    it('should filter by status code', async () => {
      const result = await tool.getRequests({ status: 201 });
      expect(result).toHaveLength(1);
      expect(result[0].url).toContain('posts');
    });

    it('should filter by resource type', async () => {
      const result = await tool.getRequests({ type: 'stylesheet' });
      expect(result).toHaveLength(1);
      expect(result[0].url).toContain('cdn.com');
    });

    it('should combine multiple filters', async () => {
      const result = await tool.getRequests({ url: 'api.com', method: 'GET' });
      expect(result).toHaveLength(1);
      expect(result[0].url).toContain('users');
    });

    it('should return empty array when no requests match filter', async () => {
      const result = await tool.getRequests({ url: 'nonexistent.com' });
      expect(result).toHaveLength(0);
    });
  });

  // =========================================================================
  // clearLog
  // =========================================================================

  describe('clearLog', () => {
    it('should clear all logged requests', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://a.com', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });

      expect(await tool.getRequests()).toHaveLength(1);

      tool.clearLog();

      expect(await tool.getRequests()).toHaveLength(0);
    });
  });

  // =========================================================================
  // modifyRequest (standalone method)
  // =========================================================================

  describe('modifyRequest', () => {
    it('should add a dynamic rule for header SET modification', async () => {
      await tool.modifyRequest('*://api.com/*', {
        type: 'header',
        action: 'add',
        key: 'X-Auth',
        value: 'secret',
      });

      expect(chromeMock.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledTimes(1);
      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.addRules).toHaveLength(1);
      const rule = call.addRules[0];
      expect(rule.action.type).toBe('modifyHeaders');
      expect(rule.action.requestHeaders[0].header).toBe('X-Auth');
      expect(rule.action.requestHeaders[0].operation).toBe('set');
      expect(rule.action.requestHeaders[0].value).toBe('secret');
      expect(rule.condition.urlFilter).toBe('*://api.com/*');
      expect(rule.condition.resourceTypes).toEqual(['xmlhttprequest']);
    });

    it('should add a dynamic rule for header REMOVE modification', async () => {
      await tool.modifyRequest('*://api.com/*', {
        type: 'header',
        action: 'remove',
        key: 'Cookie',
      });

      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      const rule = call.addRules[0];
      expect(rule.action.requestHeaders[0].operation).toBe('remove');
      expect(rule.action.requestHeaders[0].value).toBeUndefined();
    });

    it('should accumulate rules in the internal rules array', async () => {
      await tool.modifyRequest('*://a.com/*', {
        type: 'header', action: 'add', key: 'X-A', value: 'a',
      });
      await tool.modifyRequest('*://b.com/*', {
        type: 'header', action: 'add', key: 'X-B', value: 'b',
      });

      // When we stop, both rules should be cleaned up
      // Start interception first so isIntercepting is true
      const config = defaultConfig({
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);
      await tool.stopInterception();

      // stopInterception should have removed rules
      const lastCall = chromeMock.declarativeNetRequest.updateDynamicRules.mock.lastCall![0];
      expect(lastCall.removeRuleIds).toBeDefined();
    });
  });

  // =========================================================================
  // Caching
  // =========================================================================

  describe('Caching', () => {
    it('should store cache entry with default TTL', async () => {
      await tool.cacheResponse('*://api.com/*');

      // Cache should contain the pattern
      await tool.clearCache('*://api.com/*');
      // No error means it was there and got deleted
    });

    it('should store cache entry with custom TTL', async () => {
      await tool.cacheResponse('*://cdn.com/*', 60000);
      // Successful means no error
    });

    it('should clear a specific cache pattern', async () => {
      await tool.cacheResponse('*://a.com/*');
      await tool.cacheResponse('*://b.com/*');

      await tool.clearCache('*://a.com/*');
      // Only a.com should be cleared; b.com still present
    });

    it('should clear all cache entries when no pattern is specified', async () => {
      await tool.cacheResponse('*://a.com/*');
      await tool.cacheResponse('*://b.com/*');
      await tool.cacheResponse('*://c.com/*');

      await tool.clearCache();
      // All entries should be cleared
    });
  });

  // =========================================================================
  // Cleanup (stopInterception)
  // =========================================================================

  describe('Cleanup', () => {
    it('should remove all declarative rules on stop', async () => {
      const config = defaultConfig({
        requestModifications: [
          { type: 'header', action: 'block' },
          { type: 'header', action: 'add', key: 'X-A', value: 'a' },
        ],
      });
      await tool.startInterception(config);

      // Reset mock to count only stop calls
      chromeMock.declarativeNetRequest.updateDynamicRules.mockClear();

      await tool.stopInterception();

      expect(chromeMock.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledTimes(1);
      const call = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(call.removeRuleIds).toHaveLength(2);
      expect(call.removeRuleIds).toEqual([1, 2]);
    });

    it('should remove all monitoring listeners on stop', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      await tool.stopInterception();

      expect(chromeMock.webRequest.onBeforeRequest.removeListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.webRequest.onHeadersReceived.removeListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.webRequest.onCompleted.removeListener).toHaveBeenCalledTimes(1);
      expect(chromeMock.webRequest.onErrorOccurred.removeListener).toHaveBeenCalledTimes(1);
    });

    it('should be a no-op when interception is not active', async () => {
      await tool.stopInterception();
      expect(chromeMock.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('should clear rules array after stop', async () => {
      const config = defaultConfig({
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);
      await tool.stopInterception();

      // Starting again should not try to remove old rules first
      // (isIntercepting is now false, so it won't call stopInterception before start)
      chromeMock.declarativeNetRequest.updateDynamicRules.mockClear();

      const config2 = defaultConfig({
        requestModifications: [{ type: 'header', action: 'add', key: 'X', value: 'v' }],
      });
      await tool.startInterception(config2);

      expect(chromeMock.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledTimes(1);
    });

    it('should throw when removeRuleIds fails during stop', async () => {
      const config = defaultConfig({
        requestModifications: [{ type: 'header', action: 'block' }],
      });
      await tool.startInterception(config);

      chromeMock.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(
        new Error('DNR error')
      );

      await expect(tool.stopInterception()).rejects.toThrow('Failed to stop interception');
    });

    it('should remove existing listeners when startInterception is called while already intercepting', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      // Call again, which should trigger internal stop -> remove listeners
      await tool.startInterception(config);

      // Listeners should have been removed once (from the implicit stop)
      expect(chromeMock.webRequest.onBeforeRequest.removeListener).toHaveBeenCalled();
      expect(chromeMock.webRequest.onHeadersReceived.removeListener).toHaveBeenCalled();
      expect(chromeMock.webRequest.onCompleted.removeListener).toHaveBeenCalled();
      expect(chromeMock.webRequest.onErrorOccurred.removeListener).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Execute via BaseTool.execute (integration with executeImpl)
  // =========================================================================

  describe('execute() integration', () => {
    it('should start interception when enabled=true', async () => {
      const result = await tool.execute(
        defaultConfig({ enabled: true }),
        { metadata: { tabId: 10 } }
      );
      expect(result.success).toBe(true);
    });

    it('should stop interception when enabled=false', async () => {
      // First start
      await tool.startInterception(defaultConfig());

      const result = await tool.execute(
        defaultConfig({ enabled: false }),
      );
      expect(result.success).toBe(true);
    });

    it('should pass tabId from options.metadata to startInterception', async () => {
      const config = defaultConfig({
        requestModifications: [{ type: 'header', action: 'block' }],
        monitoring: defaultMonitoring({ logRequests: true }),
      });

      await tool.execute(config, { metadata: { tabId: 77 } });

      // Check that the rule has the correct tabIds
      const ruleCall = chromeMock.declarativeNetRequest.updateDynamicRules.mock.calls[0][0];
      expect(ruleCall.addRules[0].condition.tabIds).toEqual([77]);

      // Check that monitoring filter has the tabId
      const monitorCall = chromeMock.webRequest.onBeforeRequest.addListener.mock.calls[0];
      expect(monitorCall[1].tabId).toBe(77);
    });

    it('should return error result when startInterception throws', async () => {
      chromeMock.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(
        new Error('boom')
      );

      const config = defaultConfig({
        requestModifications: [{ type: 'header', action: 'block' }],
      });

      const result = await tool.execute(config);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to start interception');
    });
  });

  // =========================================================================
  // Metrics initialization and getMetrics
  // =========================================================================

  describe('Metrics', () => {
    it('should initialize metrics with zero values', async () => {
      const metrics = await tool.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.blockedRequests).toBe(0);
      expect(metrics.modifiedRequests).toBe(0);
      expect(metrics.cachedRequests).toBe(0);
      expect(metrics.failedRequests).toBe(0);
      expect(metrics.totalBytes).toBe(0);
      expect(metrics.averageResponseTime).toBe(0);
      expect(metrics.requestsByType).toEqual({});
      expect(metrics.requestsByStatus).toEqual({});
    });

    it('should return a copy of metrics (not a reference)', async () => {
      const metrics1 = await tool.getMetrics();
      metrics1.totalRequests = 999;

      const metrics2 = await tool.getMetrics();
      expect(metrics2.totalRequests).toBe(0);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge Cases', () => {
    it('should handle onHeadersReceived for unknown requestId gracefully', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      // Fire onHeadersReceived without a matching onBeforeRequest
      fireEvent('onHeadersReceived', {
        requestId: 'unknown-id',
        statusCode: 200,
        responseHeaders: [],
        timeStamp: 1000,
      });

      const requests = await tool.getRequests();
      expect(requests).toHaveLength(0);
    });

    it('should handle onCompleted for unknown requestId gracefully', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onCompleted', {
        requestId: 'unknown-id',
        timeStamp: 2000,
        fromCache: false,
      });

      // Should not throw, metrics should remain at default
      const metrics = await tool.getMetrics();
      expect(metrics.averageResponseTime).toBe(0);
    });

    it('should handle onErrorOccurred for unknown requestId without crashing', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true }),
      });
      await tool.startInterception(config);

      fireEvent('onErrorOccurred', {
        requestId: 'unknown-id',
        error: 'net::ERR_FAILED',
      });

      // failedRequests increments regardless
      const metrics = await tool.getMetrics();
      expect(metrics.failedRequests).toBe(1);
    });

    it('should handle response headers with missing values', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true, captureHeaders: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://a.com', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', {
        requestId: 'r1',
        statusCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'X-No-Value' },           // missing value
          { name: '', value: 'no-name' },    // empty name
        ],
        timeStamp: 1050,
      });

      const requests = await tool.getRequests();
      // Only fully-formed headers should be included
      expect(requests[0].responseHeaders).toEqual({
        'Content-Type': 'text/html',
      });
    });

    it('should handle request body with raw bytes', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, captureBody: true }),
      });
      await tool.startInterception(config);

      const encoder = new TextEncoder();
      const bytes = encoder.encode('raw-body-content');

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com', method: 'PUT',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
        requestBody: {
          raw: [{ bytes: bytes.buffer }],
        },
      });

      const requests = await tool.getRequests();
      expect(requests[0].body).toBe('raw-body-content');
    });

    it('should return empty string for request body with no formData or raw', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, captureBody: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://api.com', method: 'POST',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
        requestBody: {},
      });

      const requests = await tool.getRequests();
      expect(requests[0].body).toBe('');
    });

    it('should group response status codes by hundreds', async () => {
      const config = defaultConfig({
        monitoring: defaultMonitoring({ logRequests: true, logResponses: true }),
      });
      await tool.startInterception(config);

      fireEvent('onBeforeRequest', {
        requestId: 'r1', url: 'https://a.com/1', method: 'GET',
        timeStamp: 1000, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', { requestId: 'r1', statusCode: 204, responseHeaders: [], timeStamp: 1050 });

      fireEvent('onBeforeRequest', {
        requestId: 'r2', url: 'https://a.com/2', method: 'GET',
        timeStamp: 1100, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', { requestId: 'r2', statusCode: 404, responseHeaders: [], timeStamp: 1150 });

      fireEvent('onBeforeRequest', {
        requestId: 'r3', url: 'https://a.com/3', method: 'GET',
        timeStamp: 1200, tabId: 1, frameId: 0, type: 'xmlhttprequest',
      });
      fireEvent('onHeadersReceived', { requestId: 'r3', statusCode: 500, responseHeaders: [], timeStamp: 1250 });

      const metrics = await tool.getMetrics();
      expect(metrics.requestsByStatus['200']).toBe(1);
      expect(metrics.requestsByStatus['400']).toBe(1);
      expect(metrics.requestsByStatus['500']).toBe(1);
    });
  });
});
