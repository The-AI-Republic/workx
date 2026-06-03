/**
 * App-Server Config Normalization
 *
 * Host-agnostic normalization/validation of {@link IAppServerConfig}. The
 * desktop integration reads `IAgentConfig.appServer` and passes it through
 * here; the agent-facing config schema intentionally does NOT expose these
 * fields (no LLM write access).
 *
 * @module app-server/appServerConfig
 */

import type { IAppServerConfig, AppServerTransport } from '@/config/types';
import { DEFAULT_APP_SERVER_CONFIG } from '@/config/defaults';

export type { IAppServerConfig, AppServerTransport };

/** Resolved defaults for app-server config. */
export const APP_SERVER_DEFAULTS: IAppServerConfig = { ...DEFAULT_APP_SERVER_CONFIG };

/** Env override that permits `requireAuth: false` (development only). */
const DEV_ALLOW_NO_AUTH_ENV = 'APPLEPI_APP_SERVER_DEV_ALLOW_NO_AUTH';

export class AppServerConfigError extends Error {}

function clampInt(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value)) {
    throw new AppServerConfigError(`appServer.${label} must be an integer`);
  }
  if (value < min || value > max) {
    throw new AppServerConfigError(`appServer.${label} must be in [${min}, ${max}]`);
  }
  return value;
}

/** True when a host is a loopback address. */
export function isLoopbackHost(host: string): boolean {
  return (
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'localhost' ||
    host === '::ffff:127.0.0.1'
  );
}

/**
 * Normalize a partial app-server config, applying defaults and validating
 * bounds. Throws {@link AppServerConfigError} on invalid input.
 */
export function normalizeAppServerConfig(raw?: Partial<IAppServerConfig>): IAppServerConfig {
  const merged: IAppServerConfig = { ...APP_SERVER_DEFAULTS, ...(raw ?? {}) };

  if (merged.transport !== 'websocket' && merged.transport !== 'unix-socket') {
    throw new AppServerConfigError(`appServer.transport must be 'websocket' or 'unix-socket'`);
  }

  if (typeof merged.bindHost !== 'string' || merged.bindHost.length === 0) {
    merged.bindHost = APP_SERVER_DEFAULTS.bindHost;
  }

  merged.port = clampInt(merged.port, 0, 65535, 'port');
  merged.maxConnections = clampInt(merged.maxConnections, 1, 256, 'maxConnections');
  merged.maxPayloadBytes = clampInt(merged.maxPayloadBytes, 1024, 67_108_864, 'maxPayloadBytes');
  merged.maxBufferedBytes = clampInt(merged.maxBufferedBytes, 65_536, 67_108_864, 'maxBufferedBytes');
  merged.requestQueueCapacity = clampInt(merged.requestQueueCapacity, 1, 4096, 'requestQueueCapacity');

  // Auth must be required unless an explicit development override is set.
  if (!merged.requireAuth && process.env[DEV_ALLOW_NO_AUTH_ENV] !== '1') {
    throw new AppServerConfigError(
      `appServer.requireAuth must be true (set ${DEV_ALLOW_NO_AUTH_ENV}=1 to override in development)`,
    );
  }

  // Non-loopback bind requires allowLan.
  if (
    merged.transport === 'websocket' &&
    !merged.allowLan &&
    !isLoopbackHost(merged.bindHost)
  ) {
    throw new AppServerConfigError(
      `appServer.bindHost '${merged.bindHost}' is not loopback and allowLan is false`,
    );
  }

  return merged;
}
