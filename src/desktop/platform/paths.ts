/**
 * Platform Paths
 *
 * Provides platform-specific paths for the desktop application.
 * Uses Tauri's path API to get standard system directories.
 *
 * @module desktop/platform/paths
 */

import {
  appConfigDir,
  appDataDir,
  appLocalDataDir,
  appCacheDir,
  appLogDir,
  homeDir,
  desktopDir,
  downloadDir,
  documentDir,
} from '@tauri-apps/api/path';

/**
 * Platform paths interface
 */
export interface PlatformPaths {
  /** Application configuration directory */
  config: string;
  /** Application data directory */
  data: string;
  /** Application local data directory */
  localData: string;
  /** Application cache directory */
  cache: string;
  /** Application log directory */
  logs: string;
  /** User home directory */
  home: string;
  /** User desktop directory */
  desktop: string;
  /** User downloads directory */
  downloads: string;
  /** User documents directory */
  documents: string;
}

/**
 * Cached paths
 */
let cachedPaths: PlatformPaths | null = null;

/**
 * Get all platform paths
 *
 * Caches the results for subsequent calls.
 *
 * @returns Platform paths object
 */
export async function getPlatformPaths(): Promise<PlatformPaths> {
  if (cachedPaths) {
    return cachedPaths;
  }

  const [config, data, localData, cache, logs, home, desktop, downloads, documents] =
    await Promise.all([
      appConfigDir(),
      appDataDir(),
      appLocalDataDir(),
      appCacheDir(),
      appLogDir(),
      homeDir(),
      desktopDir(),
      downloadDir(),
      documentDir(),
    ]);

  cachedPaths = {
    config,
    data,
    localData,
    cache,
    logs,
    home,
    desktop,
    downloads,
    documents,
  };

  return cachedPaths;
}

/**
 * Get application config directory
 *
 * Platform-specific locations:
 * - Linux: ~/.config/<app>
 * - macOS: ~/Library/Application Support/<app>
 * - Windows: C:\Users\<user>\AppData\Roaming\<app>
 */
export async function getConfigPath(): Promise<string> {
  return appConfigDir();
}

/**
 * Get application data directory
 *
 * Platform-specific locations:
 * - Linux: ~/.local/share/<app>
 * - macOS: ~/Library/Application Support/<app>
 * - Windows: C:\Users\<user>\AppData\Roaming\<app>
 */
export async function getDataPath(): Promise<string> {
  return appDataDir();
}

/**
 * Get application cache directory
 *
 * Platform-specific locations:
 * - Linux: ~/.cache/<app>
 * - macOS: ~/Library/Caches/<app>
 * - Windows: C:\Users\<user>\AppData\Local\<app>\cache
 */
export async function getCachePath(): Promise<string> {
  return appCacheDir();
}

/**
 * Get application log directory
 *
 * Platform-specific locations:
 * - Linux: ~/.local/share/<app>/logs
 * - macOS: ~/Library/Logs/<app>
 * - Windows: C:\Users\<user>\AppData\Roaming\<app>\logs
 */
export async function getLogPath(): Promise<string> {
  return appLogDir();
}

/**
 * Get the database path for SQLite storage
 *
 * @returns Path to the SQLite database file
 */
export async function getDatabasePath(): Promise<string> {
  const dataDir = await appDataDir();
  return `${dataDir}/browserx.db`;
}

/**
 * Get the credentials path (secure storage location)
 *
 * Note: On desktop, credentials are stored in the OS keychain,
 * not in a file. This path is for any supplementary credential data.
 *
 * @returns Path to credentials metadata file
 */
export async function getCredentialsPath(): Promise<string> {
  const configDir = await appConfigDir();
  return `${configDir}/credentials.json`;
}

/**
 * Get the MCP servers configuration path
 *
 * @returns Path to MCP servers config file
 */
export async function getMCPConfigPath(): Promise<string> {
  const configDir = await appConfigDir();
  return `${configDir}/mcp-servers.json`;
}

/**
 * Get the user settings path
 *
 * @returns Path to user settings file
 */
export async function getSettingsPath(): Promise<string> {
  const configDir = await appConfigDir();
  return `${configDir}/settings.json`;
}
