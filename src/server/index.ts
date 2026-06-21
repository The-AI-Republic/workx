/**
 * Server Mode Entry Point
 *
 * Starts the WorkX Server: loads env, creates ServerAgentBootstrap,
 * starts HTTP+WS server on configured port.
 *
 * @module server/index
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// Polyfill EventSource for Node.js (required by SSE MCP transport)
if (typeof globalThis.EventSource === 'undefined') {
  try {
    const { default: EventSource } = await import('eventsource') as any;
    (globalThis as any).EventSource = EventSource;
  } catch {
    console.warn('[Server] EventSource polyfill not available — SSE MCP transport will not work');
  }
}

// Load env vars from .env file
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // dotenv not available — env vars must be set externally
}

import { loadServerConfig, getServerConfig } from './config/server-config';
import {
  initializeServerAgent,
  getServerAgentBootstrap,
  A2A_CARD_PATH,
  A2A_RPC_PATH,
} from './agent/ServerAgentBootstrap';
import { registerShutdownHandlers, gracefulShutdown } from './agent/shutdown';
import { sendChallenge, handleConnectRequest, cancelHandshake, type WsHandle } from './connection/handshake';
import {
  trackConnection,
  untrackConnection,
  touchConnection,
  startTickBroadcast,
  startStaleCleanup,
} from './connection/watchdog';
import { checkRateLimit, clearRateLimits } from './connection/rate-limiter';
import { authorizeMethod, removeConnectionAuth, getConnectionAuth } from './auth/authorize';
import { RequestFrameSchema, makeResponse, makeErrorResponse, makeEvent } from '@workx/ws-server';
import { getMethodHandler, type MethodContext } from '@workx/ws-server';
import { invalidRequest, WS_CLOSE, type ErrorShape } from '@workx/ws-server';
import { canAcceptConnection, isPayloadTooLarge, isDuplicate } from './limits/resource-limits';
import { removeLogSubscriber } from './handlers/logs';
import { getHealthStatus } from './handlers/health';
import { installStructuredLogging } from './health/log-streamer';
import { toAgentEvent } from './streaming/agent-events';
import { toChatEvent, throttleDelta, flushRemainingDelta, startChatStream, endChatStream } from './streaming/chat-stream';

// ─────────────────────────────────────────────────────────────────────────
// Load configuration
// ─────────────────────────────────────────────────────────────────────────

const config = loadServerConfig();
const PORT = config.server.port;
const BIND = resolveBind(config.server.bind);

// ─────────────────────────────────────────────────────────────────────────
// Install structured logging
// ─────────────────────────────────────────────────────────────────────────

installStructuredLogging();

// ─────────────────────────────────────────────────────────────────────────
// Create HTTP/HTTPS server
// ─────────────────────────────────────────────────────────────────────────

const tlsEnabled = config.server.tls.enabled;
let httpServer: Server;

if (tlsEnabled) {
  const certFile = config.server.tls.certFile;
  const keyFile = config.server.tls.keyFile;

  if (!certFile || !keyFile) {
    console.error('[Server] TLS enabled but certFile or keyFile not configured');
    process.exit(1);
  }

  try {
    const tlsOptions = {
      cert: readFileSync(certFile),
      key: readFileSync(keyFile),
    };
    httpServer = createHttpsServer(tlsOptions, handleHttpRequest) as unknown as Server;
    console.log('[Server] TLS enabled');
  } catch (err) {
    console.error('[Server] Failed to load TLS certificates:', err);
    process.exit(1);
  }
} else {
  httpServer = createHttpServer(handleHttpRequest);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(__dirname, '..', 'web');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Max accepted A2A request body size (1 MiB) — guards against unbounded reads. */
const A2A_MAX_BODY_BYTES = 1024 * 1024;

/** Read and JSON-parse a request body, bounded by {@link A2A_MAX_BODY_BYTES}. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > A2A_MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  // Health endpoint (UNAUTHENTICATED — K8s/Docker liveness/readiness probe).
  // Track 17 security boundary: this returns ONLY the HealthStatus shape (a
  // truthful status enum now, via DiagnosticsMonitor). The full DoctorReport
  // is NEVER served here — it is exposed solely through the authenticated
  // `diagnostics.report` service. Do not widen this payload.
  if (req.method === 'GET' && req.url === '/health') {
    const status = getHealthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  // A2A delegation endpoint (FR-6, server decoupling). Only mounted when the
  // bootstrap enabled it (WORKX_SERVER_A2A_ENABLED). The agent card is a public
  // discovery document; the JSON-RPC endpoint routes message/send into the
  // local agent.
  const a2aServer = getServerAgentBootstrap().getA2AServer();
  if (a2aServer) {
    const reqPath = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;

    if (req.method === 'GET' && reqPath === A2A_CARD_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(a2aServer.getAgentCard()));
      return;
    }

    if (req.method === 'POST' && reqPath === A2A_RPC_PATH) {
      readJsonBody(req)
        .then((body) => a2aServer.handleRpc(body))
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: err instanceof Error ? err.message : 'Parse error' },
            })
          );
        });
      return;
    }
  }

  // Static file serving for web UI
  if (req.method === 'GET') {
    const urlPath = new URL(req.url ?? '/', `http://${req.headers.host}`).pathname;
    const filePath = join(WEB_ROOT, urlPath === '/' ? 'index.html' : urlPath);

    // Prevent path traversal
    if (!filePath.startsWith(WEB_ROOT)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath);
      // Hashed assets (chunks/*-[hash].js, assets/*-[hash].css) are immutable
      const isHashed = /[-\.][a-f0-9]{8,}\.\w+$/.test(filePath);
      const cacheControl = isHashed
        ? 'public, max-age=31536000, immutable'
        : 'no-cache';
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': cacheControl,
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback: serve index.html for unmatched routes
    const indexPath = join(WEB_ROOT, 'index.html');
    if (existsSync(indexPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'no-cache',
      });
      createReadStream(indexPath).pipe(res);
      return;
    }
  }

  // All other requests → 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

// ─────────────────────────────────────────────────────────────────────────
// Create WebSocket server
// ─────────────────────────────────────────────────────────────────────────

async function startWebSocketServer(): Promise<void> {
  const { WebSocketServer, WebSocket } = await import('ws');
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    // Check connection limit
    if (!canAcceptConnection()) {
      ws.close(WS_CLOSE.POLICY_VIOLATION, 'Connection limit reached');
      return;
    }

    const isLoopback = req.socket.remoteAddress === '127.0.0.1' ||
      req.socket.remoteAddress === '::1' ||
      req.socket.remoteAddress === '::ffff:127.0.0.1';

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }

    const isBrowserOrigin = !!headers.origin;

    // CORS / Origin validation
    const allowedOrigins = config.server.allowedOrigins;
    if (isBrowserOrigin && allowedOrigins.length > 0) {
      if (!allowedOrigins.includes(headers.origin)) {
        console.warn(`[Server] Rejected connection from disallowed origin: ${headers.origin}`);
        ws.close(WS_CLOSE.POLICY_VIOLATION, 'Origin not allowed');
        return;
      }
    }
    const tempId = `pending_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    // Track connection
    trackConnection({
      connectionId: tempId,
      ws: {
        send: (data: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: (code: number, reason: string) => ws.close(code, reason),
        bufferedAmount: ws.bufferedAmount,
        readyState: ws.readyState,
      },
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      authenticated: false,
      failedAuthAttempts: 0,
      bufferedBytes: 0,
      maxBufferedBytes: config.server.limits.maxBufferedBytes,
    });

    const wsHandle: WsHandle = {
      send: (data: string) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code: number, reason: string) => ws.close(code, reason),
      isLoopback,
      headers,
    };

    // Send challenge
    sendChallenge(wsHandle);

    let connectionId: string | null = null;

    ws.on('message', async (data) => {
      const raw = data.toString();

      // Payload size check
      if (isPayloadTooLarge(Buffer.byteLength(raw))) {
        ws.close(WS_CLOSE.POLICY_VIOLATION, 'Payload too large');
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(raw);
      } catch {
        wsHandle.send(JSON.stringify(
          makeErrorResponse(randomUUID(), invalidRequest('Invalid JSON'))
        ));
        return;
      }

      // Pre-handshake: only accept connect requests
      if (!connectionId) {
        const result = await handleConnectRequest(wsHandle, frame);
        if (!result) return; // Failed handshake

        connectionId = result.connectionId;

        // Update tracking with real connection ID
        untrackConnection(tempId);
        trackConnection({
          connectionId,
          ws: {
            send: (d: string) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(d);
            },
            close: (c: number, r: string) => ws.close(c, r),
            bufferedAmount: ws.bufferedAmount,
            readyState: ws.readyState,
          },
          connectedAt: Date.now(),
          lastActivity: Date.now(),
          authenticated: true,
          failedAuthAttempts: 0,
          bufferedBytes: 0,
          maxBufferedBytes: config.server.limits.maxBufferedBytes,
        });

        console.log(`[Server] Client connected: ${connectionId} (role: ${result.role})`);
        return;
      }

      // Post-handshake: validate request frame
      const parseResult = RequestFrameSchema.safeParse(frame);
      if (!parseResult.success) {
        wsHandle.send(JSON.stringify(
          makeErrorResponse(
            (frame as { id?: string })?.id ?? randomUUID(),
            invalidRequest('Invalid request frame', parseResult.error.issues)
          )
        ));
        return;
      }

      const req = parseResult.data;
      touchConnection(connectionId);

      // Deduplication
      if (isDuplicate(req.id)) {
        wsHandle.send(JSON.stringify(
          makeErrorResponse(req.id, invalidRequest('Duplicate request'))
        ));
        return;
      }

      // Rate limiting
      const rateLimitError = checkRateLimit(connectionId, req.method, {
        isLoopback,
        isBrowserOrigin,
      });
      if (rateLimitError) {
        wsHandle.send(JSON.stringify(makeErrorResponse(req.id, rateLimitError)));
        return;
      }

      // Authorization
      const authError = authorizeMethod(connectionId, req.method);
      if (authError) {
        wsHandle.send(JSON.stringify(makeErrorResponse(req.id, authError)));
        return;
      }

      // Dispatch to handler
      const handler = getMethodHandler(req.method);
      if (!handler) {
        wsHandle.send(JSON.stringify(
          makeErrorResponse(req.id, invalidRequest(`Unknown method: ${req.method}`))
        ));
        return;
      }

      const connAuth = getConnectionAuth(connectionId);
      const ctx: MethodContext = {
        connectionId,
        requestId: req.id,
        role: connAuth?.role ?? 'channel',
        scopes: connAuth?.scopes ?? [],
        userId: connAuth?.userId,
        sessionKey: `ws:main:${connectionId}`,
        sendEvent: (event: string, payload?: unknown) => {
          wsHandle.send(JSON.stringify(makeEvent(event, payload)));
        },
      };

      try {
        const result = await handler(req.params, ctx);
        wsHandle.send(JSON.stringify(makeResponse(req.id, result)));
      } catch (err) {
        if (isErrorShape(err)) {
          wsHandle.send(JSON.stringify(makeErrorResponse(req.id, err)));
        } else {
          wsHandle.send(JSON.stringify(
            makeErrorResponse(req.id, {
              code: 'UNAVAILABLE',
              message: err instanceof Error ? err.message : 'Internal error',
              retryable: true,
            })
          ));
        }
      }
    });

    ws.on('close', () => {
      if (connectionId) {
        console.log(`[Server] Client disconnected: ${connectionId}`);
        removeConnectionAuth(connectionId);
        untrackConnection(connectionId);
        clearRateLimits(connectionId);
        removeLogSubscriber(connectionId);
      } else {
        untrackConnection(tempId);
        cancelHandshake(wsHandle);
      }
    });

    ws.on('error', (err) => {
      console.error(`[Server] WebSocket error (${connectionId ?? tempId}):`, err.message);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Bind address resolution
// ─────────────────────────────────────────────────────────────────────────

function resolveBind(bind: string): string {
  switch (bind) {
    case 'loopback':
      return '127.0.0.1';
    case 'lan':
    case 'tailnet':
    case 'auto':
      return '0.0.0.0';
    default:
      return '0.0.0.0';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Type guard
// ─────────────────────────────────────────────────────────────────────────

function isErrorShape(err: unknown): err is ErrorShape {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    'message' in err
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const proto = tlsEnabled ? 'https' : 'http';
  const wsProto = tlsEnabled ? 'wss' : 'ws';

  console.log('═══════════════════════════════════════════════════════');
  console.log('  WorkX Server Mode');
  console.log(`  Port: ${PORT}  Bind: ${BIND}  Auth: ${config.server.auth.mode}  TLS: ${tlsEnabled ? 'on' : 'off'}`);
  console.log('═══════════════════════════════════════════════════════');

  // Register shutdown handlers
  registerShutdownHandlers(() => {
    httpServer.close();
  });

  // Initialize agent
  console.log('[Server] Initializing agent...');
  await initializeServerAgent();

  // Start WebSocket server
  await startWebSocketServer();

  // Start watchdog timers
  startTickBroadcast();
  startStaleCleanup();

  // Start listening
  httpServer.listen(PORT, BIND, () => {
    const host = BIND === '0.0.0.0' ? 'localhost' : BIND;
    console.log(`[Server] Listening on ${BIND}:${PORT}`);
    console.log(`[Server] Web UI: ${proto}://${host}:${PORT}`);
    console.log(`[Server] Health: ${proto}://${host}:${PORT}/health`);
    console.log(`[Server] WebSocket: ${wsProto}://${host}:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
