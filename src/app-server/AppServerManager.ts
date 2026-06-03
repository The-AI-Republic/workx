/**
 * App-Server Manager (host-agnostic)
 *
 * Owns the transport, request processor, connection registry, request queue, and
 * status controller. Knows nothing about the desktop control bridge or
 * keychain — those are injected (auth + sessionFactory) by the host
 * integration (DesktopAppServerManager). The same manager can back a future
 * headless migration.
 *
 * @module app-server/AppServerManager
 */

import type { ChannelAdapter } from '@/core/channels/ChannelAdapter';
import { normalizeAppServerConfig, type IAppServerConfig } from './appServerConfig';
import { AppServerConnectionRegistry } from './AppServerConnectionRegistry';
import { AppServerChannel, APP_SERVER_CHANNEL_ID } from './AppServerChannel';
import { AppServerRequestProcessor } from './AppServerRequestProcessor';
import { AppServerWebSocketTransport, type AppServerListenInfo } from './transport/AppServerWebSocketTransport';
import { AppServerAuth } from './connection/AppServerAuth';
import { AppServerRateLimiter } from './connection/rateLimiter';
import { ConnectionWatchdog } from './connection/ConnectionWatchdog';
import { RequestQueue } from './queue/RequestQueue';
import { AppServerStatusController, type AppServerStatusSnapshot } from './status/AppServerStatus';

export interface AppServerManagerDeps {
  config: Partial<IAppServerConfig> | undefined;
  auth: AppServerAuth;
  /** Create a dedicated agent session per connection. */
  sessionFactory: () => Promise<string>;
  /** Tear down a connection's dedicated session on disconnect. */
  sessionDisposer?: (sessionKey: string) => Promise<void>;
  /** Runtime profile, for health responses. */
  profile?: string;
  channelId?: string;
  handshakeTimeoutMs?: number;
  allowedScopes?: string[];
}

export class AppServerManager {
  readonly status = new AppServerStatusController();
  private readonly registry = new AppServerConnectionRegistry();
  private readonly channel: AppServerChannel;
  private readonly config: IAppServerConfig;
  private transport: AppServerWebSocketTransport | null = null;
  private queue: RequestQueue | null = null;
  private watchdog: ConnectionWatchdog | null = null;
  private listenInfo: AppServerListenInfo | null = null;

  constructor(private readonly deps: AppServerManagerDeps) {
    this.config = normalizeAppServerConfig(deps.config);
    this.channel = new AppServerChannel(this.registry, deps.channelId ?? APP_SERVER_CHANNEL_ID);
  }

  /** The channel adapter to register with the agent bootstrap. */
  getChannel(): ChannelAdapter {
    return this.channel;
  }

  getStatus(): AppServerStatusSnapshot {
    return this.status.getSnapshot();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Start the listener. Throws on bind failure (caller decides recovery). */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.status.set({ enabled: false, status: 'disabled' });
      return;
    }

    this.status.set({
      enabled: true,
      status: 'starting',
      authMode: this.config.requireAuth ? 'capability-token' : 'none',
      bindHost: this.config.bindHost,
      lastError: undefined,
    });

    await this.deps.auth.ensureToken();

    this.queue = new RequestQueue({ capacity: this.config.requestQueueCapacity });
    this.watchdog = new ConnectionWatchdog({ handshakeTimeoutMs: this.deps.handshakeTimeoutMs ?? 10_000 });
    const rateLimiter = new AppServerRateLimiter({ windowMs: 1000, max: 50 });

    const processor = new AppServerRequestProcessor({
      channelId: this.channel.channelId,
      channelType: 'websocket',
      registry: this.registry,
      auth: this.deps.auth,
      queue: this.queue,
      rateLimiter,
      watchdog: this.watchdog,
      status: this.status,
      sessionFactory: this.deps.sessionFactory,
      sessionDisposer: this.deps.sessionDisposer,
      allowedScopes: this.deps.allowedScopes,
    });

    this.transport = new AppServerWebSocketTransport({
      host: this.config.bindHost,
      port: this.config.port,
      socketPath: this.config.transport === 'unix-socket' ? this.config.socketPath : undefined,
      maxConnections: this.config.maxConnections,
      maxPayloadBytes: this.config.maxPayloadBytes,
      maxBufferedBytes: this.config.maxBufferedBytes,
      rejectBrowserOrigins: this.config.rejectBrowserOrigins,
      processor,
      status: this.status,
      profile: this.deps.profile ?? 'desktop-runtime',
    });

    this.listenInfo = await this.transport.start();
    this.status.set({
      status: 'ready',
      url: this.listenInfo.url,
      port: this.listenInfo.port,
      socketPath: this.listenInfo.socketPath,
    });
  }

  async stop(reason = 'stop'): Promise<void> {
    this.status.set({ status: 'stopping' });
    await this.transport?.stop(reason);
    await this.queue?.shutdown(reason);
    this.watchdog?.stopAll();
    this.registry.clear();
    this.transport = null;
    this.queue = null;
    this.watchdog = null;
    this.listenInfo = null;
    this.status.set({ status: this.config.enabled ? 'disabled' : 'disabled', connections: 0, url: undefined });
  }

  /** Rotate the capability token. Existing connections remain until they close. */
  async rotateToken(): Promise<string> {
    return this.deps.auth.rotateToken();
  }

  async revealToken(): Promise<string | null> {
    return this.deps.auth.revealToken();
  }

  /** Record a fatal startup/runtime error in status (UI surfaces it). */
  markError(message: string): void {
    this.status.set({ status: 'error', lastError: message });
  }
}
