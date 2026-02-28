/**
 * Server Mode Entry Point
 *
 * Starts the Pi server: loads env, creates ServerAgentBootstrap,
 * starts HTTP+WS server on configured port.
 *
 * @module server/index
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

// Load env vars from .env file
try {
  const dotenv = await import('dotenv');
  dotenv.config();
} catch {
  // dotenv not available — env vars must be set externally
}

import { loadServerConfig, getServerConfig } from './config/server-config';
import { initializeServerAgent, getServerAgentBootstrap } from './agent/ServerAgentBootstrap';
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
import { RequestFrameSchema, makeResponse, makeErrorResponse, makeEvent } from './protocol/frames';
import { getMethodHandler, type MethodContext } from './protocol/methods';
import { invalidRequest, WS_CLOSE, type ErrorShape } from './protocol/errors';
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
// Create HTTP server
// ─────────────────────────────────────────────────────────────────────────

const httpServer = createServer(handleHttpRequest);

function handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
  // Health endpoint
  if (req.method === 'GET' && req.url === '/health') {
    const status = getHealthStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
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
        const result = handleConnectRequest(wsHandle, frame);
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
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Pi Server Mode');
  console.log(`  Port: ${PORT}  Bind: ${BIND}  Auth: ${config.server.auth.mode}`);
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
    console.log(`[Server] Listening on ${BIND}:${PORT}`);
    console.log(`[Server] Health: http://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}/health`);
    console.log(`[Server] WebSocket: ws://${BIND === '0.0.0.0' ? 'localhost' : BIND}:${PORT}`);
  });
}

main().catch((err) => {
  console.error('[Server] Fatal error:', err);
  process.exit(1);
});
