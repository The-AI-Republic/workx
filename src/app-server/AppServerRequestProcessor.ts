/**
 * App-Server Request Processor
 *
 * Owns protocol behavior: handshake, auth, scope enforcement, request
 * queueing/serialization, and method dispatch to the shared handlers. The
 * transport only forwards raw connection events here.
 *
 * @module app-server/AppServerRequestProcessor
 */

import { randomUUID } from 'node:crypto';
import {
  ConnectRequestSchema,
  RequestFrameSchema,
  PROTOCOL_VERSION,
  negotiateProtocolVersion,
  resolveClientInfo,
  makeResponse,
  makeErrorResponse,
  makeEvent,
  getMethodHandler,
  getRegisteredMethods,
  buildAvailableEvents,
  METHOD_REGISTRY,
  invalidRequest,
  unauthorized,
  WS_CLOSE,
  type MethodContext,
  type ChallengePayload,
  type HelloOkPayload,
  type ErrorShape,
} from '@workx/ws-server';
import type { AppServerConnectionRegistry, ConnectionSocket } from './AppServerConnectionRegistry';
import type { AppServerAuth } from './connection/AppServerAuth';
import type { RequestQueue } from './queue/RequestQueue';
import { resolveSerialization } from './queue/requestSerialization';
import type { AppServerRateLimiter } from './connection/rateLimiter';
import type { ConnectionWatchdog } from './connection/ConnectionWatchdog';
import type { AppServerStatusController } from './status/AppServerStatus';

/**
 * Default scope set for a capability-token connection. Intentionally narrow:
 * no `credentials.*` and no `config.write` unless explicitly requested AND
 * allowed by config. `admin` only enables health/tools.catalog/logs.tail.
 */
export const DEFAULT_APP_SERVER_SCOPES = [
  'chat',
  'sessions.read',
  'sessions.write',
  'config.read',
  'operator.approvals',
  'admin',
];

const SERVER_VERSION = '1.0.0';

export interface AppServerRequestProcessorDeps {
  channelId: string;
  channelType: string;
  registry: AppServerConnectionRegistry;
  auth: AppServerAuth;
  queue: RequestQueue;
  rateLimiter: AppServerRateLimiter;
  watchdog: ConnectionWatchdog;
  status: AppServerStatusController;
  /** Create a dedicated agent session for a connection; returns its id. */
  sessionFactory: () => Promise<string>;
  /** Tear down a connection's dedicated session on disconnect (prevents leaks). */
  sessionDisposer?: (sessionKey: string) => Promise<void>;
  /** Allowed scopes a connection may be granted (intersected with requested). */
  allowedScopes?: string[];
  now?: () => number;
}

export class AppServerRequestProcessor {
  private readonly now: () => number;

  constructor(private readonly deps: AppServerRequestProcessorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Called when the transport accepts a new connection. */
  onOpen(connectionId: string, socket: ConnectionSocket): void {
    this.deps.registry.add({ connectionId, socket, now: this.now() });
    this.deps.status.setConnections(this.deps.registry.count());

    const challenge: ChallengePayload = {
      nonce: randomUUID(),
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: SERVER_VERSION,
      authModes: this.deps.auth.authModes(),
    };
    socket.send(JSON.stringify(makeEvent('connect.challenge', challenge)));

    this.deps.watchdog.armHandshakeTimeout(connectionId, () => {
      const conn = this.deps.registry.get(connectionId);
      if (conn && !conn.authenticated) {
        conn.socket.close(WS_CLOSE.POLICY_VIOLATION, 'Handshake timeout');
        this.onClose(connectionId);
      }
    });
  }

  /** Called when the transport receives a frame. `raw` is the JSON string. */
  async onMessage(connectionId: string, raw: string): Promise<void> {
    const conn = this.deps.registry.get(connectionId);
    if (!conn) return;
    this.deps.registry.touch(connectionId, this.now());

    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      conn.socket.send(JSON.stringify(makeErrorResponse(randomUUID(), invalidRequest('Invalid JSON'))));
      return;
    }

    if (!conn.authenticated) {
      await this.handleConnect(connectionId, frame);
      return;
    }

    const parsed = RequestFrameSchema.safeParse(frame);
    if (!parsed.success) {
      conn.socket.send(
        JSON.stringify(
          makeErrorResponse(
            (frame as { id?: string })?.id ?? randomUUID(),
            invalidRequest('Invalid request frame', parsed.error.issues),
          ),
        ),
      );
      return;
    }

    const req = parsed.data;

    // Dedupe per connection.
    if (conn.requestIds.has(req.id)) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, invalidRequest('Duplicate request'))));
      return;
    }

    // Authorize scope.
    const spec = METHOD_REGISTRY[req.method];
    if (!spec) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, invalidRequest(`Unknown method: ${req.method}`))));
      return;
    }
    if (!conn.scopes.includes(spec.scope)) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, unauthorized(`Missing scope: ${spec.scope}`))));
      return;
    }

    const handler = getMethodHandler(req.method);
    if (!handler) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, invalidRequest(`No handler: ${req.method}`))));
      return;
    }

    // Health/readiness bypass BOTH the rate limiter and the queue so they stay
    // observable under load — a throttled liveness probe reads as an unhealthy
    // server and can trigger a needless restart of a healthy sidecar.
    if (req.method === 'health') {
      await this.runHandler(connectionId, req.id, req.method, req.params, handler);
      return;
    }

    // Rate limit (after the health bypass).
    const rl = this.deps.rateLimiter.check(connectionId, this.now());
    if (rl) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, rl)));
      return;
    }

    const serialization = resolveSerialization(req.method, {
      sessionKey: conn.sessionKey,
      connectionId,
      approvalId: req.params?.approvalId as string | undefined,
    });

    conn.requestIds.add(req.id);
    const result = this.deps.queue.enqueue({
      connectionId,
      requestId: req.id,
      serialKey: serialization.key,
      mode: serialization.mode,
      gate: conn.gate,
      run: () => this.runHandler(connectionId, req.id, req.method, req.params, handler),
    });

    if (!result.accepted && result.error) {
      conn.requestIds.delete(req.id);
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, result.error)));
    }
  }

  /** Called when the transport reports the connection closed. */
  onClose(connectionId: string): void {
    const conn = this.deps.registry.get(connectionId);
    if (!conn) return;
    const sessionKey = conn.sessionKey;
    this.deps.watchdog.clearHandshakeTimeout(connectionId);
    this.deps.rateLimiter.clear(connectionId);
    this.deps.registry.remove(connectionId);
    this.deps.status.setConnections(this.deps.registry.count());

    // Dispose the connection's dedicated session so sessions don't accumulate
    // for the life of the runtime. Fire-and-forget — onClose is a sync sink.
    if (sessionKey && this.deps.sessionDisposer) {
      void this.deps.sessionDisposer(sessionKey).catch((err) => {
        console.error(`[AppServerRequestProcessor] session dispose failed for ${sessionKey}:`, err);
      });
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────

  private async runHandler(
    connectionId: string,
    requestId: string,
    method: string,
    params: Record<string, unknown> | undefined,
    handler: ReturnType<typeof getMethodHandler>,
  ): Promise<void> {
    const conn = this.deps.registry.get(connectionId);
    if (!conn || !handler) return;

    const ctx: MethodContext = {
      connectionId,
      requestId,
      role: conn.role,
      scopes: conn.scopes,
      sessionKey: (params?.sessionKey as string) ?? conn.sessionKey,
      channelId: this.deps.channelId,
      channelType: this.deps.channelType,
      sendEvent: (event: string, payload?: unknown) => {
        conn.socket.send(JSON.stringify(makeEvent(event, payload)));
      },
    };

    try {
      const out = await handler(params, ctx);
      conn.socket.send(JSON.stringify(makeResponse(requestId, out)));
    } catch (err) {
      const shape = isErrorShape(err)
        ? err
        : ({
            code: 'UNAVAILABLE',
            message: err instanceof Error ? err.message : 'Internal error',
            retryable: true,
          } as ErrorShape);
      conn.socket.send(JSON.stringify(makeErrorResponse(requestId, shape)));
    } finally {
      conn.requestIds.delete(requestId);
    }
  }

  private async handleConnect(connectionId: string, frame: unknown): Promise<void> {
    const conn = this.deps.registry.get(connectionId);
    if (!conn) return;

    const parsed = ConnectRequestSchema.safeParse(frame);
    if (!parsed.success) {
      const reqId = (frame as { id?: string })?.id ?? randomUUID();
      conn.socket.send(
        JSON.stringify(makeErrorResponse(reqId, invalidRequest('Invalid connect request', parsed.error.issues))),
      );
      return;
    }
    const req = parsed.data;

    const negotiated = negotiateProtocolVersion(req.params);
    if (negotiated === null) {
      conn.socket.send(
        JSON.stringify(makeErrorResponse(req.id, invalidRequest(`Protocol mismatch (server ${PROTOCOL_VERSION})`))),
      );
      conn.socket.close(WS_CLOSE.PROTOCOL_MISMATCH, 'Protocol mismatch');
      return;
    }

    const clientInfo = resolveClientInfo(req.params);
    if (!clientInfo) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, invalidRequest('Client identification required'))));
      return;
    }

    if (!this.deps.auth.verify(req.params.auth?.token)) {
      conn.socket.send(JSON.stringify(makeErrorResponse(req.id, unauthorized('Invalid capability token'))));
      conn.socket.close(WS_CLOSE.POLICY_VIOLATION, 'Invalid token');
      this.onClose(connectionId);
      return;
    }

    // Resolve scopes: allowed ∩ requested (or all allowed if none requested).
    const allowed = this.deps.allowedScopes ?? DEFAULT_APP_SERVER_SCOPES;
    const requested = req.params.scopes;
    const scopes =
      requested && requested.length > 0 ? requested.filter((s) => allowed.includes(s)) : [...allowed];

    // Create a dedicated session for this connection.
    let sessionKey: string;
    try {
      sessionKey = await this.deps.sessionFactory();
    } catch (err) {
      conn.socket.send(
        JSON.stringify(
          makeErrorResponse(req.id, {
            code: 'UNAVAILABLE',
            message: `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
            retryable: true,
          }),
        ),
      );
      return;
    }

    conn.authenticated = true;
    conn.role = clientInfo.mode;
    conn.scopes = scopes;
    conn.sessionKey = sessionKey;
    conn.clientInfo = { id: clientInfo.id, mode: clientInfo.mode };
    conn.subscriptions.add(sessionKey);
    this.deps.watchdog.clearHandshakeTimeout(connectionId);

    const helloOk: HelloOkPayload = {
      type: 'hello-ok',
      protocol: negotiated,
      server: { version: SERVER_VERSION, connId: connectionId },
      features: { methods: getRegisteredMethods(), events: buildAvailableEvents(scopes) },
      snapshot: { sessions: [], health: { status: this.deps.status.getSnapshot().status } },
      auth: { role: clientInfo.mode, scopes, issuedAtMs: this.now() },
      policy: { maxPayload: 0, maxBufferedBytes: 0, tickIntervalMs: 30_000 },
      sessionKey,
    };
    conn.socket.send(JSON.stringify(makeResponse(req.id, helloOk)));
  }
}

function isErrorShape(err: unknown): err is ErrorShape {
  return typeof err === 'object' && err !== null && 'code' in err && 'message' in err;
}
