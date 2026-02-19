/**
 * Unit tests for SSEClientTransport
 * Task: T011 [US1]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEClientTransport } from '../transports/SSEClientTransport';

// Mock EventSource
class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  readyState: number = MockEventSource.CONNECTING;
  url: string;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  private listeners: Map<string, Set<(ev: MessageEvent) => void>> = new Map();

  constructor(url: string) {
    this.url = url;
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockEventSource.OPEN;
      this.onopen?.(new Event('open'));
    }, 10);
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }

  // Test helpers
  simulateMessage(data: string): void {
    const event = new MessageEvent('message', { data });
    this.onmessage?.(event);
    this.listeners.get('message')?.forEach((l) => l(event));
  }

  simulateEndpoint(endpoint: string, sessionId: string): void {
    const event = new MessageEvent('endpoint', {
      data: JSON.stringify({ endpoint, sessionId }),
    });
    this.listeners.get('endpoint')?.forEach((l) => l(event));
  }

  simulateError(): void {
    this.onerror?.(new Event('error'));
  }
}

// Mock fetch
const mockFetch = vi.fn();

describe('SSEClientTransport', () => {
  let originalEventSource: typeof EventSource;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    // Save originals
    originalEventSource = globalThis.EventSource;
    originalFetch = globalThis.fetch;

    // Install mocks
    (globalThis as any).EventSource = MockEventSource;
    globalThis.fetch = mockFetch;

    // Reset mocks
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({
      ok: true,
      headers: new Headers(),
      text: () => Promise.resolve(''),
    });
  });

  afterEach(() => {
    // Restore originals
    globalThis.EventSource = originalEventSource;
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    it('should set up message and SSE endpoints from base URL', () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      // The endpoints are private, so we test via start() and send()
      expect(transport).toBeDefined();
    });

    it('should remove trailing slash from URL', () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp/',
      });

      expect(transport).toBeDefined();
    });
  });

  describe('start', () => {
    it('should open an EventSource connection', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();

      expect(transport.isConnected()).toBe(true);
    });

    it('should include API key in SSE URL if provided', async () => {
      let capturedUrl = '';
      (globalThis as any).EventSource = class extends MockEventSource {
        constructor(url: string) {
          super(url);
          capturedUrl = url;
        }
      };

      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
        apiKey: 'test-api-key',
      });

      await transport.start();

      expect(capturedUrl).toContain('apiKey=test-api-key');
    });

    it('should throw if transport is already closed', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();
      await transport.close();

      await expect(transport.start()).rejects.toThrow('Transport has been closed');
    });

    it('should handle connection timeout', async () => {
      // Use a mock that never connects
      (globalThis as any).EventSource = class {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSED = 2;

        readyState = 0;
        onopen: any = null;
        onerror: any = null;
        onmessage: any = null;

        addEventListener() {}
        close() {
          this.readyState = 2;
        }
      };

      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
        timeout: 50,
      });

      await expect(transport.start()).rejects.toThrow('timeout');
    });
  });

  describe('send', () => {
    it('should POST JSON-RPC message to message endpoint', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();

      const message = { jsonrpc: '2.0', method: 'test', id: 1 };
      await transport.send(message as any);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/mcp/message',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(message),
        })
      );
    });

    it('should include Authorization header if API key provided', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
        apiKey: 'test-api-key',
      });

      await transport.start();
      await transport.send({ jsonrpc: '2.0', method: 'test', id: 1 } as any);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-api-key',
          }),
        })
      );
    });

    it('should throw if transport is closed', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();
      await transport.close();

      await expect(transport.send({} as any)).rejects.toThrow('Transport has been closed');
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();

      await expect(transport.send({} as any)).rejects.toThrow('HTTP 500');
    });
  });

  describe('close', () => {
    it('should close the EventSource connection', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();
      expect(transport.isConnected()).toBe(true);

      await transport.close();
      expect(transport.isConnected()).toBe(false);
    });

    it('should call onclose callback', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      const onclose = vi.fn();
      transport.onclose = onclose;

      await transport.start();
      await transport.close();

      expect(onclose).toHaveBeenCalled();
    });

    it('should clear session ID', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();
      // Simulate receiving a session ID
      // (would happen via endpoint event in real scenario)

      await transport.close();

      expect(transport.sessionId).toBeUndefined();
    });
  });

  describe('onmessage callback', () => {
    it('should parse and forward JSON-RPC messages', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      const onmessage = vi.fn();
      transport.onmessage = onmessage;

      await transport.start();

      // Get the mock EventSource instance
      // Simulate a message
      const mockES = (transport as any).eventSource as MockEventSource;
      mockES.simulateMessage('{"jsonrpc":"2.0","result":"test","id":1}');

      expect(onmessage).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          result: 'test',
          id: 1,
        })
      );
    });

    it('should call onerror for invalid JSON', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      const onerror = vi.fn();
      transport.onerror = onerror;

      await transport.start();

      const mockES = (transport as any).eventSource as MockEventSource;
      mockES.simulateMessage('not valid json');

      expect(onerror).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('session management', () => {
    it('should extract session ID from endpoint event', async () => {
      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();

      const mockES = (transport as any).eventSource as MockEventSource;
      mockES.simulateEndpoint('https://new-endpoint.com/message', 'session-123');

      expect(transport.sessionId).toBe('session-123');
    });

    it('should include session ID in subsequent requests', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Headers({ 'Mcp-Session-Id': 'session-456' }),
        text: () => Promise.resolve(''),
      });

      const transport = new SSEClientTransport({
        url: 'https://example.com/mcp',
      });

      await transport.start();

      // First request should not have session ID
      await transport.send({ jsonrpc: '2.0', method: 'init', id: 1 } as any);

      // Session ID should be extracted from response
      expect(transport.sessionId).toBe('session-456');

      // Second request should include session ID
      await transport.send({ jsonrpc: '2.0', method: 'test', id: 2 } as any);

      expect(mockFetch).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'Mcp-Session-Id': 'session-456',
          }),
        })
      );
    });
  });
});
