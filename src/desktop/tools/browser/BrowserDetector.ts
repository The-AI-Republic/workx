/**
 * Browser Detector
 *
 * Detects installed browsers and running browser instances on the system.
 * Used for auto-connecting to existing browser sessions.
 *
 * @module desktop/tools/browser/BrowserDetector
 */

import { invoke } from '@tauri-apps/api/tauri';
import { platform } from '@tauri-apps/api/os';

/**
 * Browser info
 */
export interface BrowserInfo {
  /** Browser name */
  name: string;
  /** Browser type (chrome, firefox, edge, etc.) */
  type: 'chrome' | 'chromium' | 'edge' | 'firefox' | 'safari' | 'other';
  /** Path to browser executable */
  executablePath: string;
  /** Browser version if available */
  version?: string;
  /** Whether browser is currently running */
  isRunning?: boolean;
  /** Debug port if browser is running with remote debugging */
  debugPort?: number;
  /** Profile path if available */
  profilePath?: string;
}

/**
 * Running browser instance
 */
export interface RunningBrowser {
  /** Process ID */
  pid: number;
  /** Browser type */
  type: string;
  /** Debug port if available */
  debugPort?: number;
  /** Profile being used */
  profilePath?: string;
}

/**
 * Common browser executable paths by platform
 */
const BROWSER_PATHS: Record<string, Record<string, string[]>> = {
  darwin: {
    chrome: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ],
    chromium: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    firefox: ['/Applications/Firefox.app/Contents/MacOS/firefox'],
    safari: ['/Applications/Safari.app/Contents/MacOS/Safari'],
  },
  linux: {
    chrome: [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-dev',
      '/opt/google/chrome/chrome',
    ],
    chromium: [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ],
    edge: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
    firefox: ['/usr/bin/firefox', '/snap/bin/firefox'],
  },
  win32: {
    chrome: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe',
    ],
    chromium: ['C:\\Program Files\\Chromium\\Application\\chrome.exe'],
    edge: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
    firefox: [
      'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
      'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
    ],
  },
};

/**
 * Default Chrome profile paths by platform
 */
const CHROME_PROFILE_PATHS: Record<string, string> = {
  darwin: '~/Library/Application Support/Google/Chrome',
  linux: '~/.config/google-chrome',
  win32: '%LOCALAPPDATA%\\Google\\Chrome\\User Data',
};

/**
 * BrowserDetector finds and detects browsers on the system
 *
 * @example
 * ```typescript
 * const detector = new BrowserDetector();
 * const browsers = await detector.detectInstalledBrowsers();
 * const running = await detector.findRunningBrowsers();
 * ```
 */
export class BrowserDetector {
  private platformName: string | null = null;

  /**
   * Get current platform name
   */
  private async getPlatform(): Promise<string> {
    if (!this.platformName) {
      this.platformName = await platform();
    }
    return this.platformName;
  }

  /**
   * Detect all installed browsers
   *
   * @returns List of detected browsers
   */
  async detectInstalledBrowsers(): Promise<BrowserInfo[]> {
    const browsers: BrowserInfo[] = [];
    const platformName = await this.getPlatform();
    const platformPaths = BROWSER_PATHS[platformName] || {};

    for (const [type, paths] of Object.entries(platformPaths)) {
      for (const executablePath of paths) {
        const exists = await this.fileExists(executablePath);
        if (exists) {
          browsers.push({
            name: this.getBrowserName(type),
            type: type as BrowserInfo['type'],
            executablePath,
          });
          break; // Found this browser type, move to next
        }
      }
    }

    return browsers;
  }

  /**
   * Find Chrome executable path
   *
   * @returns Path to Chrome executable or null
   */
  async findChrome(): Promise<string | null> {
    const browsers = await this.detectInstalledBrowsers();
    const chrome = browsers.find((b) => b.type === 'chrome');
    return chrome?.executablePath || null;
  }

  /**
   * Find running browsers with debug ports
   *
   * @returns List of running browsers with debug info
   */
  async findRunningBrowsers(): Promise<RunningBrowser[]> {
    try {
      // Use Tauri command to find running browsers
      const result = await invoke<RunningBrowser[]>('find_running_browsers');
      return result || [];
    } catch (error) {
      console.warn('[BrowserDetector] Failed to find running browsers:', error);
      return [];
    }
  }

  /**
   * Find a browser already running with a debug port
   *
   * @returns Debug port number or null
   */
  async findExistingDebugPort(): Promise<number | null> {
    const running = await this.findRunningBrowsers();
    const withDebug = running.find((b) => b.debugPort);
    return withDebug?.debugPort || null;
  }

  /**
   * Check if Chrome is running
   *
   * @returns true if Chrome is running
   */
  async isChromeRunning(): Promise<boolean> {
    const running = await this.findRunningBrowsers();
    return running.some((b) => b.type === 'chrome');
  }

  /**
   * Get Chrome default profile path
   *
   * @returns Path to Chrome profile directory
   */
  async getChromeProfilePath(): Promise<string> {
    const platformName = await this.getPlatform();
    const path = CHROME_PROFILE_PATHS[platformName] || CHROME_PROFILE_PATHS.linux;

    // Expand home directory
    if (path.startsWith('~')) {
      const home = await invoke<string>('get_home_dir');
      return path.replace('~', home);
    }

    return path;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await invoke<boolean>('file_exists', { path });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get friendly browser name
   */
  private getBrowserName(type: string): string {
    const names: Record<string, string> = {
      chrome: 'Google Chrome',
      chromium: 'Chromium',
      edge: 'Microsoft Edge',
      firefox: 'Firefox',
      safari: 'Safari',
    };
    return names[type] || type;
  }
}
