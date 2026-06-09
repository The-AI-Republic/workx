export interface DesktopRuntimeHost {
  configDir: string;
  storageDbPath: string;
  rolloutDbPath: string;
  configJsonPath: string;
  cacheDir?: string;
  logDir?: string;
  browserMcpSidecarPath?: string;
  projectRoot?: string;
  keychainServicePrefix?: string;
  platform?: string;
  arch?: string;
}

let host: DesktopRuntimeHost | null = null;

const REQUIRED_HOST_KEYS: Array<keyof DesktopRuntimeHost> = [
  'configDir',
  'storageDbPath',
  'rolloutDbPath',
  'configJsonPath',
];

export function assertDesktopRuntimeHost(nextHost: DesktopRuntimeHost): DesktopRuntimeHost {
  for (const key of REQUIRED_HOST_KEYS) {
    if (typeof nextHost[key] !== 'string' || nextHost[key].trim() === '') {
      throw new Error(`Desktop runtime host is missing required path: ${key}`);
    }
  }
  return nextHost;
}

export function setDesktopRuntimeHost(nextHost: DesktopRuntimeHost): void {
  host = assertDesktopRuntimeHost(nextHost);
}

export function getDesktopRuntimeHost(): DesktopRuntimeHost {
  if (host) return host;

  const encoded = typeof process !== 'undefined' ? process.env.WORKX_DESKTOP_RUNTIME_HOST : undefined;
  if (encoded) {
    try {
      host = assertDesktopRuntimeHost(JSON.parse(encoded) as DesktopRuntimeHost);
      return host;
    } catch (error) {
      throw new Error(`Invalid WORKX_DESKTOP_RUNTIME_HOST JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error('Desktop runtime host paths are not initialized');
}

export function getOptionalDesktopRuntimeHost(): DesktopRuntimeHost | null {
  try {
    return getDesktopRuntimeHost();
  } catch {
    return null;
  }
}

export async function createDevDesktopRuntimeHost(): Promise<DesktopRuntimeHost> {
  const os = await import('node:os');
  const path = await import('node:path');

  if (process.env.WORKX_DESKTOP_RUNTIME_ALLOW_DEV_HOST !== 'true') {
    throw new Error(
      'WORKX_DESKTOP_RUNTIME_HOST is required. Set WORKX_DESKTOP_RUNTIME_ALLOW_DEV_HOST=true only for local sidecar development.'
    );
  }

  const configDir = process.env.WORKX_DESKTOP_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'apple-pi-dev');

  return assertDesktopRuntimeHost({
    configDir,
    storageDbPath: path.join(configDir, 'storage.db'),
    rolloutDbPath: path.join(configDir, 'rollouts.db'),
    configJsonPath: path.join(configDir, 'config.json'),
    cacheDir: path.join(configDir, 'cache'),
    logDir: path.join(configDir, 'logs'),
    browserMcpSidecarPath: process.env.WORKX_BROWSER_MCP_SIDECAR,
    projectRoot: process.cwd(),
    keychainServicePrefix: 'workx',
    platform: process.platform,
    arch: process.arch,
  });
}
