import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// We need to reset modules between tests to clear the module-level _config singleton
let loadServerConfig: typeof import('../server-config').loadServerConfig;
let getServerConfig: typeof import('../server-config').getServerConfig;
let getDataDir: typeof import('../server-config').getDataDir;
let redactConfig: typeof import('../server-config').redactConfig;
let ServerConfigSchema: typeof import('../server-config').ServerConfigSchema;

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'WORKX_CONFIG_PATH',
  'WORKX_DATA_DIR',
  'WORKX_SERVER_PORT',
  'WORKX_SERVER_BIND',
  'WORKX_SERVER_AUTH_MODE',
  'WORKX_SERVER_TOKEN',
  'WORKX_SERVER_PASSWORD',
];

beforeEach(async () => {
  // Save env
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  // Create temp dir
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-config-test-'));

  // Reset modules to get fresh singleton state
  vi.resetModules();
  const mod = await import('../server-config');
  loadServerConfig = mod.loadServerConfig;
  getServerConfig = mod.getServerConfig;
  getDataDir = mod.getDataDir;
  redactConfig = mod.redactConfig;
  ServerConfigSchema = mod.ServerConfigSchema;
});

afterEach(() => {
  // Restore env
  for (const key of ENV_KEYS) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }

  // Cleanup temp dir
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

// ---------------------------------------------------------------------------
// Schema defaults
// ---------------------------------------------------------------------------

describe('ServerConfigSchema defaults', () => {
  it('parses empty object with all defaults', () => {
    const config = ServerConfigSchema.parse({});
    expect(config.server.port).toBe(18100);
    expect(config.server.bind).toBe('auto');
    expect(config.server.auth.mode).toBe('none');
    expect(config.server.limits.maxConcurrentRuns).toBe(4);
    expect(config.server.limits.maxConnections).toBe(50);
    expect(config.server.limits.maxPayloadBytes).toBe(26_214_400);
    expect(config.server.limits.queue.cap).toBe(20);
    expect(config.server.limits.queue.dropPolicy).toBe('summarize');
    expect(config.server.exec.approvalPolicy).toBe('dangerous');
    expect(config.server.tls.enabled).toBe(false);
    expect(config.owner.displayName).toBe('');
  });
});

// ---------------------------------------------------------------------------
// loadServerConfig from file
// ---------------------------------------------------------------------------

describe('loadServerConfig', () => {
  it('loads config from a JSON file', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      server: { port: 9999, auth: { mode: 'token', token: 'abc' } },
    }));
    process.env.WORKX_CONFIG_PATH = configPath;

    const config = loadServerConfig();
    expect(config.server.port).toBe(9999);
    expect(config.server.auth.mode).toBe('token');
    expect(config.server.auth.token).toBe('abc');
  });

  it('uses defaults when config file does not exist', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'nonexistent.json');
    const config = loadServerConfig();
    expect(config.server.port).toBe(18100);
  });

  it('uses defaults when config file has invalid JSON', () => {
    const configPath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(configPath, '{invalid json');
    process.env.WORKX_CONFIG_PATH = configPath;

    const config = loadServerConfig();
    expect(config.server.port).toBe(18100);
  });
});

// ---------------------------------------------------------------------------
// Env var overrides
// ---------------------------------------------------------------------------

describe('env var overrides', () => {
  it('WORKX_SERVER_PORT overrides file config', () => {
    const configPath = path.join(tmpDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ server: { port: 8000 } }));
    process.env.WORKX_CONFIG_PATH = configPath;
    process.env.WORKX_SERVER_PORT = '4444';

    const config = loadServerConfig();
    expect(config.server.port).toBe(4444);
  });

  it('WORKX_SERVER_BIND overrides default', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_BIND = 'lan';

    const config = loadServerConfig();
    expect(config.server.bind).toBe('lan');
  });

  it('WORKX_SERVER_AUTH_MODE overrides default', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_AUTH_MODE = 'token';

    const config = loadServerConfig();
    expect(config.server.auth.mode).toBe('token');
  });

  it('WORKX_SERVER_TOKEN overrides config file token', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_TOKEN = 'env-token-123';

    const config = loadServerConfig();
    expect(config.server.auth.token).toBe('env-token-123');
  });

  it('WORKX_SERVER_PASSWORD overrides config file password', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_PASSWORD = 'env-pass';

    const config = loadServerConfig();
    expect(config.server.auth.password).toBe('env-pass');
  });
});

// ---------------------------------------------------------------------------
// getDataDir
// ---------------------------------------------------------------------------

describe('getDataDir', () => {
  it('returns WORKX_DATA_DIR when set', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_DATA_DIR = '/custom/data';
    loadServerConfig();
    expect(getDataDir()).toBe('/custom/data');
  });
});

// ---------------------------------------------------------------------------
// getServerConfig singleton
// ---------------------------------------------------------------------------

describe('getServerConfig', () => {
  it('auto-loads on first call', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    const config = getServerConfig();
    expect(config.server.port).toBe(18100);
  });

  it('returns cached config on subsequent calls', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    const first = getServerConfig();
    const second = getServerConfig();
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// redactConfig
// ---------------------------------------------------------------------------

describe('redactConfig', () => {
  it('redacts token and password', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_TOKEN = 'secret';
    process.env.WORKX_SERVER_PASSWORD = 'hidden';

    const config = loadServerConfig();
    const redacted = redactConfig(config);

    expect(redacted.server.auth.token).toBe('***');
    expect(redacted.server.auth.password).toBe('***');
  });

  it('does not modify original config', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    process.env.WORKX_SERVER_TOKEN = 'original';

    const config = loadServerConfig();
    redactConfig(config);

    expect(config.server.auth.token).toBe('original');
  });

  it('returns deep clone', () => {
    process.env.WORKX_CONFIG_PATH = path.join(tmpDir, 'none.json');
    const config = loadServerConfig();
    const redacted = redactConfig(config);

    redacted.server.port = 0;
    expect(config.server.port).not.toBe(0);
  });
});
