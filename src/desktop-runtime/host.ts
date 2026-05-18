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

export function setDesktopRuntimeHost(nextHost: DesktopRuntimeHost): void {
  host = nextHost;
}

export function getDesktopRuntimeHost(): DesktopRuntimeHost {
  if (host) return host;

  const encoded = typeof process !== 'undefined' ? process.env.APPLEPI_DESKTOP_RUNTIME_HOST : undefined;
  if (encoded) {
    try {
      host = JSON.parse(encoded) as DesktopRuntimeHost;
      return host;
    } catch (error) {
      throw new Error(`Invalid APPLEPI_DESKTOP_RUNTIME_HOST JSON: ${error instanceof Error ? error.message : String(error)}`);
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

  const configDir = process.env.APPLEPI_DESKTOP_CONFIG_DIR
    ?? path.join(os.homedir(), '.config', 'apple-pi-dev');

  return {
    configDir,
    storageDbPath: path.join(configDir, 'storage.db'),
    rolloutDbPath: path.join(configDir, 'rollouts.db'),
    configJsonPath: path.join(configDir, 'config.json'),
    cacheDir: path.join(configDir, 'cache'),
    logDir: path.join(configDir, 'logs'),
    browserMcpSidecarPath: process.env.APPLEPI_BROWSER_MCP_SIDECAR,
    projectRoot: process.cwd(),
    keychainServicePrefix: 'applepi',
    platform: process.platform,
    arch: process.arch,
  };
}
