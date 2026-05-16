/**
 * Server Configuration
 *
 * Loads configuration from env vars → config.json → defaults.
 * Supports hot-reload for non-sensitive settings.
 *
 * @module server/config/server-config
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─────────────────────────────────────────────────────────────────────────
// Configuration schema
// ─────────────────────────────────────────────────────────────────────────

const RateLimitConfigSchema = z.object({
  windowMs: z.number().default(60_000),
  maxRequests: z.number().default(60),
});

const TlsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  certFile: z.string().default(''),
  keyFile: z.string().default(''),
});

const AuthConfigSchema = z.object({
  mode: z.enum(['none', 'token', 'password', 'trusted-proxy']).default('none'),
  token: z.string().optional(),
  password: z.string().optional(),
  rateLimit: RateLimitConfigSchema.default({}),
});

const ExecConfigSchema = z.object({
  approvalPolicy: z.enum(['always', 'dangerous', 'never', 'allowlist']).default('dangerous'),
  approvalTimeoutMs: z.number().default(300_000),
});

const QueueConfigSchema = z.object({
  cap: z.number().default(20),
  debounceMs: z.number().default(1_000),
  dropPolicy: z.enum(['old', 'new', 'summarize']).default('summarize'),
});

const LimitsConfigSchema = z.object({
  maxConcurrentRuns: z.number().default(4),
  maxSubagentRuns: z.number().default(8),
  maxSpawnDepth: z.number().default(2),
  maxChildrenPerAgent: z.number().default(5),
  runTimeoutSeconds: z.number().default(300),
  maxConnections: z.number().default(50),
  maxPayloadBytes: z.number().default(26_214_400),
  maxBufferedBytes: z.number().default(52_428_800),
  handshakeTimeoutMs: z.number().default(10_000),
  maxSessions: z.number().default(1_000),
  maxHistoryBytes: z.number().default(6_291_456),
  sessionRetentionDays: z.number().default(30),
  // Track 18: USD budget caps for unattended scheduler jobs. 0 = disabled.
  // maxUsdPerDay pauses the job queue once the day's summed cost exceeds it
  // (post-hoc, blocks subsequent jobs). maxUsdPerJob flags an individual
  // over-budget job in the logs. Hot-reloadable via the existing
  // onConfigReload wiring (a candidate Track 20 lockedKeys policy key).
  maxUsdPerDay: z.number().default(0),
  maxUsdPerJob: z.number().default(0),
  queue: QueueConfigSchema.default({}),
});

const BackupConfigSchema = z.object({
  schedule: z.string().default('0 3 * * *'),
  retention: z.number().default(7),
});

const OwnerIdentitiesSchema = z.record(z.string(), z.array(z.string())).default({});

const OwnerConfigSchema = z.object({
  displayName: z.string().default(''),
  identities: OwnerIdentitiesSchema,
});

export const ServerConfigSchema = z.object({
  server: z
    .object({
      port: z.number().default(18100),
      bind: z.enum(['loopback', 'lan', 'tailnet', 'auto']).default('auto'),
      auth: AuthConfigSchema.default({}),
      tls: TlsConfigSchema.default({}),
      trustedProxies: z.array(z.string()).default([]),
      allowedOrigins: z.array(z.string()).default([]),
      exec: ExecConfigSchema.default({}),
      channels: z.record(z.string(), z.unknown()).default({}),
      limits: LimitsConfigSchema.default({}),
      backup: BackupConfigSchema.default({}),
      shutdownGracePeriodMs: z.number().default(10_000),
    })
    .default({}),
  owner: OwnerConfigSchema.default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

// ─────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_DATA_DIR = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
  '.applepi-server',
  'data'
);

const DEFAULT_CONFIG_PATH = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
  '.applepi-server',
  'config.json'
);

// ─────────────────────────────────────────────────────────────────────────
// Loader
// ─────────────────────────────────────────────────────────────────────────

let _config: ServerConfig | null = null;
let _dataDir: string = DEFAULT_DATA_DIR;
let _watcher: fs.FSWatcher | null = null;
let _onReloadCallbacks: Array<(cfg: ServerConfig) => void> = [];

/**
 * Load server configuration.
 *
 * Priority: env vars > config.json > defaults.
 */
export function loadServerConfig(): ServerConfig {
  const configPath = process.env.APPLEPI_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  _dataDir = process.env.APPLEPI_DATA_DIR ?? DEFAULT_DATA_DIR;

  let fileConfig: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch (err) {
      console.warn('[ServerConfig] Failed to parse config file:', err);
    }
  }

  // Overlay env vars onto file config
  const merged = applyEnvOverrides(fileConfig);
  const parsed = ServerConfigSchema.parse(merged);

  _config = parsed;
  return parsed;
}

/**
 * Get current config (loads if not yet loaded).
 */
export function getServerConfig(): ServerConfig {
  if (!_config) {
    return loadServerConfig();
  }
  return _config;
}

/**
 * Get the data directory path.
 */
export function getDataDir(): string {
  return _dataDir;
}

/**
 * Register a callback for config hot-reload.
 */
export function onConfigReload(cb: (cfg: ServerConfig) => void): () => void {
  _onReloadCallbacks.push(cb);
  return () => {
    _onReloadCallbacks = _onReloadCallbacks.filter((c) => c !== cb);
  };
}

/**
 * Start watching config file for changes.
 */
export function watchConfig(): void {
  const configPath = process.env.APPLEPI_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  if (!fs.existsSync(configPath)) return;

  _watcher = fs.watch(configPath, { persistent: false }, () => {
    try {
      const reloaded = loadServerConfig();
      for (const cb of _onReloadCallbacks) {
        try {
          cb(reloaded);
        } catch (err) {
          console.error('[ServerConfig] Reload callback error:', err);
        }
      }
    } catch (err) {
      console.warn('[ServerConfig] Failed to reload config:', err);
    }
  });
}

/**
 * Stop watching config file.
 */
export function stopWatchingConfig(): void {
  _watcher?.close();
  _watcher = null;
}

// ─────────────────────────────────────────────────────────────────────────
// Env overlay
// ─────────────────────────────────────────────────────────────────────────

function applyEnvOverrides(base: Record<string, unknown>): Record<string, unknown> {
  const server = (base.server ?? {}) as Record<string, unknown>;
  const auth = (server.auth ?? {}) as Record<string, unknown>;

  if (process.env.APPLEPI_SERVER_PORT) {
    server.port = parseInt(process.env.APPLEPI_SERVER_PORT, 10);
  }
  if (process.env.APPLEPI_SERVER_BIND) {
    server.bind = process.env.APPLEPI_SERVER_BIND;
  }
  if (process.env.APPLEPI_SERVER_AUTH_MODE) {
    auth.mode = process.env.APPLEPI_SERVER_AUTH_MODE;
  }
  if (process.env.APPLEPI_SERVER_TOKEN) {
    auth.token = process.env.APPLEPI_SERVER_TOKEN;
  }
  if (process.env.APPLEPI_SERVER_PASSWORD) {
    auth.password = process.env.APPLEPI_SERVER_PASSWORD;
  }

  server.auth = auth;
  base.server = server;
  return base;
}

/**
 * Redact secrets from config for safe display.
 */
export function redactConfig(config: ServerConfig): ServerConfig {
  const clone = JSON.parse(JSON.stringify(config)) as ServerConfig;
  if (clone.server.auth.token) {
    clone.server.auth.token = '***';
  }
  if (clone.server.auth.password) {
    clone.server.auth.password = '***';
  }
  return clone;
}
