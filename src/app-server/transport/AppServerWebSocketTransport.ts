/**
 * App-Server WebSocket Transport
 *
 * Loopback WebSocket listener with HTTP health endpoints. Accepts and
 * authenticates byte streams, forwards normalized connection events to the
 * request processor, and enforces transport-level limits (origin rejection,
 * connection count, payload size, slow-consumer disconnect).
 *
 * @module app-server/transport/AppServerWebSocketTransport
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { WS_CLOSE } from '@workx/ws-server';
import type { AppServerRequestProcessor } from '../AppServerRequestProcessor';
import type { AppServerStatusController } from '../status/AppServerStatus';
import type { ConnectionSocket } from '../AppServerConnectionRegistry';
import { handleHealthRequest } from './httpHealth';

export interface AppServerListenInfo {
  host: string;
  port: number;
  url: string;
  socketPath?: string;
}

export interface AppServerWebSocketTransportOptions {
  host: string;
  port: number;
  /**
   * When set, listen on a Unix domain socket / Windows named pipe instead of a
   * TCP host:port (Phase 4). On Windows use a `\\.\pipe\...` path.
   */
  socketPath?: string;
  maxConnections: number;
  maxPayloadBytes: number;
  maxBufferedBytes: number;
  rejectBrowserOrigins: boolean;
  processor: AppServerRequestProcessor;
  status: AppServerStatusController;
  profile: string;
}

export class AppServerWebSocketTransport {
  private httpServer: Server | null = null;
  private wss: { close: (cb?: () => void) => void; clients: Set<unknown> } | null = null;
  private slowConsumerTimer: ReturnType<typeof setInterval> | null = null;
  private connectionCount = 0;
  private readonly startedAtMs: number;

  constructor(private readonly opts: AppServerWebSocketTransportOptions) {
    this.startedAtMs = Date.now();
  }

  async start(): Promise<AppServerListenInfo> {
    const { WebSocketServer, WebSocket } = await import('ws');

    const httpServer = createHttpServer((req, res) => this.handleHttp(req, res));
    this.httpServer = httpServer;

    const wss = new WebSocketServer({
      server: httpServer,
      maxPayload: this.opts.maxPayloadBytes,
      verifyClient: (
        info: { origin?: string; req: IncomingMessage },
        cb: (ok: boolean, code?: number, message?: string) => void,
      ) => {
        if (this.opts.rejectBrowserOrigins && info.origin) {
          cb(false, 403, 'Origin not allowed');
          return;
        }
        if (this.connectionCount >= this.opts.maxConnections) {
          cb(false, 503, 'Connection limit reached');
          return;
        }
        cb(true);
      },
    });
    this.wss = wss as unknown as { close: (cb?: () => void) => void; clients: Set<unknown> };

    wss.on('connection', (ws: import('ws').WebSocket) => {
      const connectionId = `appsrv_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      this.connectionCount += 1;

      const socket: ConnectionSocket = {
        send: (data: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        },
        close: (code: number, reason: string) => ws.close(code, reason),
        bufferedAmount: () => ws.bufferedAmount,
      };

      this.opts.processor.onOpen(connectionId, socket);

      ws.on('message', (data: import('ws').RawData) => {
        const raw = data.toString();
        if (Buffer.byteLength(raw) > this.opts.maxPayloadBytes) {
          ws.close(WS_CLOSE.POLICY_VIOLATION, 'Payload too large');
          return;
        }
        void this.opts.processor.onMessage(connectionId, raw);
      });

      ws.on('close', () => {
        this.connectionCount = Math.max(0, this.connectionCount - 1);
        this.opts.processor.onClose(connectionId);
      });

      ws.on('error', () => {
        // Errors are followed by 'close'; nothing to do here.
      });
    });

    // Slow-consumer sweep: close connections whose outbound buffer is saturated.
    this.slowConsumerTimer = setInterval(() => {
      for (const client of wss.clients) {
        const ws = client as import('ws').WebSocket;
        if (ws.bufferedAmount > this.opts.maxBufferedBytes) {
          ws.close(WS_CLOSE.POLICY_VIOLATION, 'SLOW_CONSUMER');
        }
      }
    }, 1000);
    (this.slowConsumerTimer as { unref?: () => void }).unref?.();

    // Phase 4: Unix domain socket / Windows named pipe.
    if (this.opts.socketPath) {
      const sockPath = this.opts.socketPath;
      // Remove a stale socket file (best-effort, POSIX only — named pipes on
      // Windows are not filesystem entries).
      if (platform() !== 'win32' && existsSync(sockPath)) {
        try {
          unlinkSync(sockPath);
        } catch {
          // If it can't be removed it's likely in use; listen() will surface it.
        }
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(sockPath, () => resolve());
      });
      return { host: this.opts.host, port: 0, url: `ws+unix://${sockPath}`, socketPath: sockPath };
    }

    const port = await new Promise<number>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(this.opts.port, this.opts.host, () => {
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port);
      });
    });

    const url = `ws://${this.opts.host}:${port}`;
    return { host: this.opts.host, port, url };
  }

  async stop(_reason?: string): Promise<void> {
    if (this.slowConsumerTimer) {
      clearInterval(this.slowConsumerTimer);
      this.slowConsumerTimer = null;
    }
    if (this.wss) {
      for (const client of this.wss.clients) {
        (client as import('ws').WebSocket).close(WS_CLOSE.SERVICE_RESTART, 'shutting down');
      }
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const health = handleHealthRequest(req.method, req.url, {
      status: this.opts.status.getSnapshot(),
      profile: this.opts.profile,
      startedAtMs: this.startedAtMs,
      now: Date.now(),
    });
    if (health) {
      res.writeHead(health.statusCode, { 'Content-Type': health.contentType });
      res.end(health.body);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}
