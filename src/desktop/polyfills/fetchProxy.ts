/**
 * Fetch Proxy for Desktop Mode
 *
 * Overrides globalThis.fetch to route HTTP requests through Rust (via Tauri IPC),
 * bypassing WebView CORS restrictions. This is the desktop equivalent of how
 * Chrome extension service workers make fetch requests without CORS.
 *
 * Local requests (localhost, dev server) are NOT proxied.
 *
 * @module desktop/polyfills/fetchProxy
 */

import { invoke, Channel } from '@tauri-apps/api/core';
import { LARGE_PAYLOAD_THRESHOLD } from '@/desktop/channels/LargePayloadStore';

const CHUNK_SIZE = 48 * 1024; // 48KB per chunk — well under WebView2 postMessage limit

/** Events received from Rust http_fetch command */
interface HttpEvent {
  event: 'headers' | 'chunk' | 'end' | 'error';
  status?: number;
  status_text?: string;
  headers?: Record<string, string>;
  data?: string; // base64 encoded chunk
  message?: string;
}

/** Save original fetch for local requests */
const originalFetch = globalThis.fetch.bind(globalThis);

/**
 * Check if a URL should be proxied through Rust.
 * Local/dev server requests go through the browser directly.
 */
function shouldProxy(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;

    // Don't proxy local dev server / Tauri internal requests
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === 'tauri.localhost' ||
      host === 'ipc.localhost' ||  // Tauri v2 uses this for invoke() HTTP-based IPC
      host === '0.0.0.0'
    ) {
      return false;
    }

    // Only proxy http/https
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Decode base64 string to Uint8Array
 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Extract request details from fetch arguments
 */
async function parseRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ method: string; url: string; headers: Record<string, string>; body: string | null }> {
  let method = 'GET';
  let url: string;
  let headers: Record<string, string> = {};
  let body: string | null = null;

  if (input instanceof Request) {
    url = input.url;
    method = input.method;
    input.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (input.body) {
      body = await input.text();
    }
  } else {
    url = input instanceof URL ? input.toString() : input;
  }

  // Override with init options
  if (init) {
    if (init.method) method = init.method;
    if (init.headers) {
      const h = new Headers(init.headers);
      h.forEach((value, key) => {
        headers[key] = value;
      });
    }
    if (init.body) {
      if (typeof init.body === 'string') {
        body = init.body;
      } else if (init.body instanceof ArrayBuffer) {
        body = new TextDecoder().decode(init.body);
      } else if (init.body instanceof Uint8Array) {
        body = new TextDecoder().decode(init.body);
      } else {
        // ReadableStream, FormData, etc. — fall back to string conversion
        body = String(init.body);
      }
    }
  }

  return { method, url, headers, body };
}

/**
 * Fetch implementation that routes through Rust
 */
async function rustFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { method, url, headers, body } = await parseRequest(input, init);

  const bodyLen = body?.length ?? 0;

  // For large bodies, chunk them into Rust's buffer before invoking http_fetch
  let requestId: string | null = null;
  if (body && bodyLen > LARGE_PAYLOAD_THRESHOLD) {
    requestId = crypto.randomUUID();
    const totalChunks = Math.ceil(bodyLen / CHUNK_SIZE);
    for (let i = 0; i < bodyLen; i += CHUNK_SIZE) {
      const chunkIndex = Math.floor(i / CHUNK_SIZE);
      await invoke('http_append_body_chunk', {
        requestId,
        chunk: body.slice(i, i + CHUNK_SIZE),
      });
    }
  }

  // Channel for streaming response from Rust
  const onEvent = new Channel<HttpEvent>();

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let resolved = false;

    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        controller = ctrl;
      },
    });

    onEvent.onmessage = (msg: HttpEvent) => {
      switch (msg.event) {
        case 'headers': {
          resolved = true;
          const responseHeaders = new Headers(msg.headers || {});
          resolve(
            new Response(stream, {
              status: msg.status || 200,
              statusText: msg.status_text || '',
              headers: responseHeaders,
            }),
          );
          break;
        }
        case 'chunk': {
          if (msg.data) {
            try {
              controller.enqueue(base64ToBytes(msg.data));
            } catch {
              // Stream already closed
            }
          }
          break;
        }
        case 'end': {
          try {
            controller.close();
          } catch {
            // Already closed
          }
          break;
        }
        case 'error': {
          const error = new Error(msg.message || 'Request failed');
          if (!resolved) {
            reject(error);
          } else {
            try {
              controller.error(error);
            } catch {
              // Already closed
            }
          }
          break;
        }
      }
    };

    // Invoke the Rust command
    invoke('http_fetch', {
      method,
      url,
      headers,
      body: requestId ? null : body,
      requestId,
      onEvent,
    }).catch((err) => {
      if (!resolved) {
        reject(new Error(String(err)));
      }
    });
  });
}

/**
 * Proxied fetch — routes external requests through Rust, local requests through browser
 */
async function proxiedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;

  if (shouldProxy(url)) {
    return rustFetch(input, init);
  }

  return originalFetch(input, init);
}

/**
 * Install the fetch proxy. Call once at app startup.
 */
export function installFetchProxy(): void {
  globalThis.fetch = proxiedFetch as typeof globalThis.fetch;
}
