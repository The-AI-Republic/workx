/**
 * Bridge transports
 *
 * The extension→desktop bridge speaks one JSON frame protocol over two possible
 * carriers, selected by {@link BridgeSettings.transport}:
 *
 *   - `native` (prod): `chrome.runtime.connectNative` → a desktop-installed
 *     native-messaging host (the relay) that forwards to the app-server. Chrome
 *     authorizes the connection via the host manifest's `allowed_origins`, so
 *     there is **no capability token** (the relay injects it) and **no
 *     heartbeat** (Chrome's `onDisconnect` is authoritative liveness).
 *   - `ws` (dev/fallback): a direct `WebSocket` to the loopback app-server,
 *     authorized by a capability token copied into settings, kept alive by the
 *     app-layer heartbeat.
 *
 * A transport is a dumb pipe: it moves opaque frame strings and reports open /
 * close. All protocol logic (handshake, request/response, invoke) stays in
 * {@link BridgeClient}.
 *
 * @module extension/bridge/transport
 */

import { NATIVE_HOST_NAME, type BridgeSettings } from './bridgeSettings';

export interface BridgeTransportHandlers {
  /** A complete inbound frame (JSON string) arrived. */
  onFrame: (raw: string) => void;
  /** The connection closed/failed. `reason` is best-effort human text. */
  onClose: (reason: string) => void;
}

export interface BridgeTransport {
  /** Open the connection and start delivering frames to `handlers`. */
  open(handlers: BridgeTransportHandlers): void;
  /** Send a frame. Returns false if the transport is not currently open. */
  send(raw: string): boolean;
  /** Close the connection (idempotent). */
  close(reason: string): void;
  /** Whether the transport can currently accept `send`. */
  readonly isOpen: boolean;
  /** Whether the `connect` handshake must carry the capability token. */
  readonly requiresToken: boolean;
  /** Whether the app-layer heartbeat should run on this transport. */
  readonly usesHeartbeat: boolean;
}

/** Direct WebSocket to the loopback app-server (dev / fallback). */
export class WsBridgeTransport implements BridgeTransport {
  readonly requiresToken = true;
  readonly usesHeartbeat = true;
  private ws: WebSocket | null = null;

  constructor(private readonly url: string) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  open(handlers: BridgeTransportHandlers): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      handlers.onClose(err instanceof Error ? err.message : 'WebSocket constructor failed');
      return;
    }
    this.ws = ws;
    ws.onmessage = (event) => handlers.onFrame(String(event.data));
    ws.onclose = () => handlers.onClose('connection closed');
    ws.onerror = () => handlers.onClose('connection error');
  }

  send(raw: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(raw);
    return true;
  }

  close(reason: string): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, reason);
    } catch {
      // already closed
    }
  }
}

/** Native-messaging port to the desktop-installed relay host (prod). */
export class NativeBridgeTransport implements BridgeTransport {
  readonly requiresToken = false;
  readonly usesHeartbeat = false;
  private port: chrome.runtime.Port | null = null;
  private open_ = false;

  constructor(private readonly hostName: string = NATIVE_HOST_NAME) {}

  get isOpen(): boolean {
    return this.open_;
  }

  open(handlers: BridgeTransportHandlers): void {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(this.hostName);
    } catch (err) {
      handlers.onClose(err instanceof Error ? err.message : 'connectNative failed');
      return;
    }
    this.port = port;
    this.open_ = true;
    // Native messaging delivers already-parsed JSON objects; re-stringify so
    // the client sees the same frame shape as the WS path.
    port.onMessage.addListener((msg: unknown) => {
      try {
        handlers.onFrame(JSON.stringify(msg));
      } catch {
        // non-serializable frame — ignore
      }
    });
    port.onDisconnect.addListener(() => {
      this.open_ = false;
      this.port = null;
      const reason = chrome.runtime.lastError?.message ?? 'native host disconnected';
      handlers.onClose(reason);
    });
  }

  send(raw: string): boolean {
    if (!this.open_ || !this.port) return false;
    try {
      this.port.postMessage(JSON.parse(raw));
      return true;
    } catch {
      // Port died between the isOpen check and postMessage.
      this.open_ = false;
      return false;
    }
  }

  close(_reason: string): void {
    const port = this.port;
    this.port = null;
    this.open_ = false;
    try {
      port?.disconnect();
    } catch {
      // already disconnected
    }
  }
}

/** Build the transport the settings ask for (defaults to native). */
export function createBridgeTransport(settings: BridgeSettings): BridgeTransport {
  if (settings.transport === 'ws') return new WsBridgeTransport(settings.url);
  return new NativeBridgeTransport();
}
