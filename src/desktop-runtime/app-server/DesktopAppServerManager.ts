/**
 * Desktop App-Server Integration
 *
 * Desktop-only wiring around the host-agnostic {@link AppServerManager}:
 *   - reads `IAgentConfig.appServer`,
 *   - builds the keychain-backed capability token store,
 *   - registers the app-server channel on the bootstrap,
 *   - starts the listener and publishes status,
 *   - exposes `appServer.*` runtime service handlers for the UI.
 *
 * App-server startup failure never crashes the sidecar — errors are recorded
 * in status and the runtime keeps serving the UI.
 *
 * @module desktop-runtime/app-server/DesktopAppServerManager
 */

import path from 'node:path';
import type { ServerAgentBootstrap } from '@/server/agent/ServerAgentBootstrap';
import type { ServiceHandler } from '@/core/channels/ServiceRegistry';
import { getChannelManager } from '@/core/channels/ChannelManager';
import { AgentConfig } from '@/config/AgentConfig';
import { AppServerManager } from '@/app-server/AppServerManager';
import { AppServerAuth } from '@/app-server/connection/AppServerAuth';
import { normalizeAppServerConfig } from '@/app-server/appServerConfig';
import type { AppServerStatusSnapshot } from '@/app-server/status/AppServerStatus';
import { getDesktopRuntimeHost } from '../host';
import { getDesktopRuntimeControlBridge } from '../protocol/controlBridge';
import { KeychainTokenStore } from './KeychainTokenStore';

export interface DesktopAppServerManagerOptions {
  bootstrap: ServerAgentBootstrap;
}

export class DesktopAppServerManager {
  private manager: AppServerManager | null = null;
  private channelRegistered = false;

  constructor(private readonly opts: DesktopAppServerManagerOptions) {}

  /**
   * Read config and start the app-server if enabled. Never throws — failures
   * are recorded in status so the desktop runtime keeps running.
   */
  async startFromConfig(): Promise<void> {
    try {
      const agentConfig = await AgentConfig.getInstance();
      const rawConfig = agentConfig.getConfig().appServer;
      const config = normalizeAppServerConfig(rawConfig);

      if (!config.enabled) {
        return;
      }

      const host = getDesktopRuntimeHost();
      const controlBridge = getDesktopRuntimeControlBridge();
      const tokenStore = new KeychainTokenStore({
        keychain: controlBridge.keychain,
        fallbackFilePath: path.join(host.configDir, 'app-server-token'),
        onFallback: () => {
          console.warn(
            '[DesktopAppServerManager] WARN: keychain unavailable — capability token stored in a 0600 file. ' +
              'A local process that can read this file gains the connection\'s full scope set.',
          );
        },
      });

      const auth = new AppServerAuth({ requireAuth: config.requireAuth, store: tokenStore });

      this.manager = new AppServerManager({
        config,
        auth,
        profile: 'desktop-runtime',
        sessionFactory: () => this.opts.bootstrap.createSession(),
        sessionDisposer: (key) => this.opts.bootstrap.releaseSession(key),
      });

      // Register the channel BEFORE starting the transport so events route as
      // soon as connections submit work.
      await this.opts.bootstrap.registerChannel(this.manager.getChannel());
      this.channelRegistered = true;

      await this.manager.start();
      const status = this.manager.getStatus();
      console.error(`[DesktopAppServerManager] app-server ready at ${status.url ?? '(unknown)'}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[DesktopAppServerManager] app-server start failed (runtime continues):', message);
      this.manager?.markError(message);
    }
  }

  /** Stop the listener and unregister the channel. */
  async stop(reason = 'shutdown'): Promise<void> {
    try {
      await this.manager?.stop(reason);
      if (this.channelRegistered && this.manager) {
        await this.opts.bootstrap.unregisterChannel(this.manager.getChannel().channelId);
        this.channelRegistered = false;
      }
    } catch (err) {
      console.error('[DesktopAppServerManager] stop error:', err);
    }
  }

  getStatus(): AppServerStatusSnapshot {
    return (
      this.manager?.getStatus() ?? { enabled: false, status: 'disabled', connections: 0 }
    );
  }

  /**
   * Register `appServer.*` runtime service handlers so the UI can control the
   * app-server. The UI talks to these services, never to the WS listener.
   */
  registerServices(): void {
    const registry = getChannelManager().getServiceRegistry();
    const handlers: Record<string, ServiceHandler> = {
      'appServer.getStatus': async () => this.getStatus(),
      'appServer.restart': async () => {
        await this.stop('restart');
        await this.startFromConfig();
        return this.getStatus();
      },
      'appServer.stop': async () => {
        await this.stop('stop');
        return this.getStatus();
      },
      'appServer.rotateToken': async () => {
        if (!this.manager) throw new Error('App-server not running');
        await this.manager.rotateToken();
        return { rotated: true };
      },
      'appServer.revealToken': async () => {
        if (!this.manager) throw new Error('App-server not running');
        return { token: await this.manager.revealToken() };
      },
      'appServer.setConfig': async () => {
        // Config is persisted via the normal config service; this just restarts
        // the listener so new settings take effect.
        await this.stop('config-change');
        await this.startFromConfig();
        return this.getStatus();
      },
    };
    for (const [name, handler] of Object.entries(handlers)) {
      registry.register(name, handler);
    }
  }
}
