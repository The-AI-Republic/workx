/**
 * Bridge Client
 *
 * WebSocket client connecting the extension (as a `mode: 'node'` worker) to
 * the WorkX desktop app-server. Speaks the @workx/ws-server wire protocol:
 *
 *   ← connect.challenge      (on open)
 *   → connect                (capability token, mode 'node', node scopes)
 *   ← hello-ok
 *   → node.advertise         (browser tool catalog from BridgeExecutor)
 *   ← node.invoke (event)    → executes → node.result
 *   → node.heartbeat         (every 20s; also extends the MV3 SW lifetime)
 *
 * Reconnects with capped backoff while enabled; a chrome.alarms safety net
 * re-checks the connection every minute so a slept service worker comes back
 * within a bounded window (the alarm wakes the SW, the WS keeps it awake).
 *
 * @module extension/bridge/BridgeClient
 */

import {
  NODE_INVOKE_EVENT,
  NODE_SCOPES,
  NodeInvokePayloadSchema,
  type NodeInvokePayload,
} from '@workx/ws-server';
import { BridgeExecutor } from './BridgeExecutor';
import {
  BRIDGE_KEEPALIVE_ALARM,
  BRIDGE_STATUS_KEY,
  getBridgeSettings,
  onBridgeSettingsChanged,
  type BridgeSettings,
} from './bridgeSettings';
import { createBridgeTransport, type BridgeTransport } from './transport';

const HEARTBEAT_INTERVAL_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

type BridgeStatus = 'disabled' | 'connecting' | 'connected' | 'error';

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BridgeClient {
  private readonly executor = new BridgeExecutor();
  private transport: BridgeTransport | null = null;
  private status: BridgeStatus = 'disabled';
  private lastError: string | null = null;
  private settings: BridgeSettings | null = null;
  private pending = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private generation = 0;

  /** Publish status for the settings UI (best-effort). */
  private setStatus(status: BridgeStatus, lastError: string | null = this.lastError): void {
    this.status = status;
    this.lastError = lastError;
    void chrome.storage.session
      .set({ [BRIDGE_STATUS_KEY]: { status, lastError, updatedAt: Date.now() } })
      .catch(() => undefined);
  }

  /** Read settings and connect if enabled. Also reacts to settings changes. */
  async start(): Promise<void> {
    onBridgeSettingsChanged((next) => {
      const prev = this.settings;
      this.settings = next;
      // A changed transport/token/URL must apply immediately — drop the live
      // connection so reconcile() redials with the new parameters.
      if (
        prev &&
        this.transport &&
        (prev.transport !== next.transport || prev.url !== next.url || prev.token !== next.token)
      ) {
        this.disconnect('settings changed');
      }
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      void this.reconcile();
    });
    this.settings = await getBridgeSettings();
    await this.reconcile();
  }

  /** Re-check desired state vs actual (called by the keepalive alarm too). */
  async reconcile(): Promise<void> {
    if (!this.settings) this.settings = await getBridgeSettings();
    const { enabled, token, url, transport } = this.settings;
    // Native needs no token/url (Chrome brokers it); ws needs both.
    const configured = transport === 'native' ? enabled : enabled && !!token && !!url;
    if (!configured) {
      this.disconnect('bridge disabled');
      this.setStatus('disabled');
      return;
    }
    // A live/connecting transport already exists — nothing to do.
    if (this.transport) return;
    this.connect();
  }

  getStatus(): { status: BridgeStatus; lastError: string | null } {
    return { status: this.status, lastError: this.lastError };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ───────────────────────────────────────────────────────────────────────

  private connect(): void {
    const settings = this.settings;
    if (!settings) return;
    const generation = ++this.generation;
    this.setStatus('connecting');

    const transport = createBridgeTransport(settings);
    this.transport = transport;
    transport.open({
      onFrame: (raw) => {
        if (generation !== this.generation) return;
        void this.onFrame(raw);
      },
      onClose: (reason) => this.onConnectionLost(generation, reason),
    });
    // The handshake is driven by the server's connect.challenge event, which
    // both transports deliver (the relay forwards it on the native path).
  }

  private disconnect(reason: string): void {
    this.generation += 1;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failPending(new Error(reason));
    if (this.transport) {
      this.transport.close(reason);
      this.transport = null;
    }
    // Desktop is gone — free our tabs for the user's own sessions.
    void this.executor.releaseAll();
  }

  private onConnectionLost(generation: number, message: string): void {
    if (generation !== this.generation) return;
    this.generation += 1;
    this.stopHeartbeat();
    this.failPending(new Error(message));
    this.transport = null;
    void this.executor.releaseAll();

    if (!this.settings?.enabled) {
      this.setStatus('disabled');
      return;
    }
    this.setStatus('error', message);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconcile();
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Protocol
  // ───────────────────────────────────────────────────────────────────────

  private async onFrame(raw: string): Promise<void> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame?.type === 'res' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.ok) {
        pending.resolve(frame.payload);
      } else {
        pending.reject(new Error(frame.error?.message ?? 'request failed'));
      }
      return;
    }

    if (frame?.type === 'event') {
      switch (frame.event) {
        case 'connect.challenge':
          await this.handshake();
          return;
        case NODE_INVOKE_EVENT:
          await this.handleInvoke(frame.payload);
          return;
        default:
          return; // tick, shutdown, … — activity alone extends SW lifetime.
      }
    }
  }

  private async handshake(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;
    try {
      // Native transport: Chrome authorizes via the host manifest and the relay
      // injects the capability token, so we send no `auth` here.
      const connectParams: Record<string, unknown> = {
        client: {
          id: 'workx-extension',
          displayName: 'WorkX Chrome Extension',
          version: chrome.runtime.getManifest().version,
          platform: 'chrome-extension',
          mode: 'node',
        },
        scopes: [...NODE_SCOPES],
      };
      if (this.transport?.requiresToken) {
        connectParams.auth = { token: settings.token };
      }
      await this.request('connect', connectParams);

      const tools = await this.executor.getCatalog();
      await this.request('node.advertise', {
        node: {
          kind: 'browser-extension',
          displayName: 'WorkX Chrome Extension',
          version: chrome.runtime.getManifest().version,
        },
        tools,
      });

      this.setStatus('connected', null);
      this.reconnectDelayMs = RECONNECT_MIN_MS;
      // Native transport relies on Chrome's onDisconnect for liveness — no
      // heartbeat traffic. The WS fallback keeps the app-layer heartbeat.
      if (this.transport?.usesHeartbeat) this.startHeartbeat();
      console.log(
        `[BridgeClient] connected to desktop (${settings.transport}), advertised ${tools.length} tools`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[BridgeClient] handshake failed:', message);
      this.lastError = message;
      // Drop the transport; onClose schedules the retry.
      this.transport?.close('handshake failed');
    }
  }

  private async handleInvoke(payload: unknown): Promise<void> {
    const parsed = NodeInvokePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      console.warn('[BridgeClient] malformed node.invoke payload:', parsed.error.issues);
      return;
    }
    const invoke: NodeInvokePayload = parsed.data;
    const outcome = await this.executor.execute(invoke.toolName ?? '', invoke.parameters, {
      invokeId: invoke.invokeId,
      timeoutMs: invoke.timeoutMs,
      operation: invoke.operation,
      sessionId: invoke.sessionId,
      focusGrantId: invoke.focusGrantId,
    });
    try {
      await this.request('node.result', {
        invokeId: invoke.invokeId,
        ok: outcome.ok,
        result: outcome.result,
        error: outcome.error,
      });
    } catch (err) {
      console.warn('[BridgeClient] failed to deliver node.result:', err);
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const transport = this.transport;
    if (!transport?.isOpen) {
      return Promise.reject(new Error('bridge transport is not open'));
    }
    const id = crypto.randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        const sent = transport.send(JSON.stringify({ type: 'req', id, method, params }));
        if (sent) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('bridge transport is not open'));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error('bridge transport send failed'));
      }
    });
  }

  private failPending(err: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pending.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.request('node.heartbeat', {}).catch(() => {
        // Missed heartbeat — force the reconnect path.
        this.transport?.close('heartbeat failed');
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Service-worker singleton + keepalive alarm
// ─────────────────────────────────────────────────────────────────────────

let clientSingleton: BridgeClient | null = null;

export function getBridgeClient(): BridgeClient {
  if (!clientSingleton) clientSingleton = new BridgeClient();
  return clientSingleton;
}

/**
 * Initialize the bridge in the service worker: start the client and arm the
 * keepalive alarm that revives the connection after a SW sleep. The alarm
 * LISTENER is registered synchronously at the service worker's module top
 * level (MV3 requirement for wake events) — see service-worker.ts.
 */
export async function initializeBridge(): Promise<void> {
  try {
    await chrome.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 1 });
  } catch (err) {
    console.warn('[BridgeClient] failed to create keepalive alarm:', err);
  }
  await getBridgeClient().start();
}
