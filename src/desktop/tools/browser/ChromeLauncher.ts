/**
 * Chrome Launcher
 *
 * Launches Chrome with remote debugging enabled for CDP control.
 * Supports various launch configurations for session preservation.
 *
 * @module desktop/tools/browser/ChromeLauncher
 */

import { invoke } from '@tauri-apps/api/tauri';
import { BrowserDetector } from './BrowserDetector';
import { ProfileManager } from './ProfileManager';

/**
 * Launch options for Chrome
 */
export interface LaunchOptions {
  /** Custom executable path (auto-detected if not provided) */
  executablePath?: string;
  /** User data directory (profile path) */
  userDataDir?: string;
  /** Debug port (auto-selected if not provided) */
  debugPort?: number;
  /** Launch in headless mode */
  headless?: boolean;
  /** Additional Chrome arguments */
  args?: string[];
  /** Window width */
  windowWidth?: number;
  /** Window height */
  windowHeight?: number;
  /** Start maximized */
  startMaximized?: boolean;
  /** Disable GPU (useful for headless) */
  disableGpu?: boolean;
  /** Disable sandbox (needed in some environments) */
  noSandbox?: boolean;
  /** URL to navigate to on launch */
  startUrl?: string;
}

/**
 * Launch result
 */
export interface LaunchResult {
  /** Whether launch was successful */
  success: boolean;
  /** Process ID if successful */
  pid?: number;
  /** Debug port being used */
  debugPort?: number;
  /** WebSocket debugger URL */
  wsEndpoint?: string;
  /** Error message if failed */
  error?: string;
}

/**
 * Default launch options
 */
const DEFAULT_OPTIONS: Partial<LaunchOptions> = {
  headless: false,
  windowWidth: 1280,
  windowHeight: 720,
  startMaximized: false,
  disableGpu: false,
  noSandbox: false,
  args: [],
};

/**
 * Find an available port in range
 */
async function findAvailablePort(startPort: number = 9222, endPort: number = 9322): Promise<number> {
  for (let port = startPort; port <= endPort; port++) {
    const available = await invoke<boolean>('is_port_available', { port });
    if (available) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${endPort}`);
}

/**
 * ChromeLauncher handles launching Chrome with debug capabilities
 *
 * @example
 * ```typescript
 * const launcher = new ChromeLauncher();
 *
 * // Simple launch
 * const result = await launcher.launch();
 *
 * // Launch with copied profile
 * const result = await launcher.launchWithSession('/path/to/profile');
 * ```
 */
export class ChromeLauncher {
  private detector: BrowserDetector;
  private profileManager: ProfileManager;
  private runningProcess: { pid: number; debugPort: number } | null = null;

  constructor() {
    this.detector = new BrowserDetector();
    this.profileManager = new ProfileManager();
  }

  /**
   * Launch Chrome with remote debugging enabled
   *
   * @param options - Launch options
   * @returns Launch result with debug connection info
   */
  async launch(options?: LaunchOptions): Promise<LaunchResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    try {
      // Find Chrome executable
      const executablePath = opts.executablePath || (await this.detector.findChrome());
      if (!executablePath) {
        return {
          success: false,
          error: 'Chrome not found. Please install Google Chrome or specify executablePath.',
        };
      }

      // Find available debug port
      const debugPort = opts.debugPort || (await findAvailablePort());

      // Build Chrome arguments
      const args = this.buildArgs(debugPort, opts);

      console.log(`[ChromeLauncher] Launching Chrome from ${executablePath}`);
      console.log(`[ChromeLauncher] Debug port: ${debugPort}`);
      console.log(`[ChromeLauncher] Args: ${args.join(' ')}`);

      // Launch Chrome via Tauri command
      const result = await invoke<{ pid: number; wsEndpoint: string }>('launch_chrome', {
        executablePath,
        args,
        debugPort,
      });

      this.runningProcess = { pid: result.pid, debugPort };

      return {
        success: true,
        pid: result.pid,
        debugPort,
        wsEndpoint: result.wsEndpoint,
      };
    } catch (error) {
      console.error('[ChromeLauncher] Failed to launch Chrome:', error);
      return {
        success: false,
        error: `Failed to launch Chrome: ${error}`,
      };
    }
  }

  /**
   * Launch Chrome with an existing session (profile copy)
   *
   * @param sourceProfilePath - Path to source Chrome profile
   * @param options - Additional launch options
   * @returns Launch result
   */
  async launchWithSession(
    sourceProfilePath: string,
    options?: Omit<LaunchOptions, 'userDataDir'>
  ): Promise<LaunchResult> {
    console.log(`[ChromeLauncher] Launching with session from ${sourceProfilePath}`);

    // Check if profile is available
    const status = await this.profileManager.getProfileStatus(sourceProfilePath);
    if (status === 'locked' || status === 'in-use') {
      // Profile is in use, create a copy
      console.log('[ChromeLauncher] Profile is in use, creating copy...');
      const copiedProfile = await this.profileManager.copyProfile(sourceProfilePath);
      return this.launch({ ...options, userDataDir: copiedProfile });
    }

    // Use profile directly
    return this.launch({ ...options, userDataDir: sourceProfilePath });
  }

  /**
   * Launch Chrome with auto-detected user profile
   *
   * Attempts to use the user's default Chrome profile for session preservation.
   *
   * @param options - Additional launch options
   * @returns Launch result
   */
  async launchWithUserProfile(options?: Omit<LaunchOptions, 'userDataDir'>): Promise<LaunchResult> {
    const profilePath = await this.detector.getChromeProfilePath();
    const defaultProfile = `${profilePath}/Default`;

    return this.launchWithSession(defaultProfile, options);
  }

  /**
   * Connect to an already running Chrome instance
   *
   * @param debugPort - Debug port of running Chrome (auto-detected if not provided)
   * @returns Launch result with connection info
   */
  async connectToRunning(debugPort?: number): Promise<LaunchResult> {
    try {
      // Find existing debug port if not provided
      const port = debugPort || (await this.detector.findExistingDebugPort());
      if (!port) {
        return {
          success: false,
          error: 'No running Chrome instance with remote debugging found',
        };
      }

      // Verify connection
      const wsEndpoint = await invoke<string>('get_chrome_ws_endpoint', { port });

      return {
        success: true,
        debugPort: port,
        wsEndpoint,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to connect to running Chrome: ${error}`,
      };
    }
  }

  /**
   * Close the launched Chrome instance
   */
  async close(): Promise<void> {
    if (this.runningProcess) {
      try {
        await invoke('kill_process', { pid: this.runningProcess.pid });
        console.log(`[ChromeLauncher] Killed Chrome process ${this.runningProcess.pid}`);
      } catch (error) {
        console.warn('[ChromeLauncher] Failed to kill Chrome process:', error);
      }
      this.runningProcess = null;
    }
  }

  /**
   * Check if a Chrome instance is running
   */
  isRunning(): boolean {
    return this.runningProcess !== null;
  }

  /**
   * Get the current debug port
   */
  getDebugPort(): number | null {
    return this.runningProcess?.debugPort || null;
  }

  /**
   * Build Chrome command line arguments
   */
  private buildArgs(debugPort: number, options: LaunchOptions): string[] {
    const args: string[] = [
      `--remote-debugging-port=${debugPort}`,
      '--remote-allow-origins=*',
    ];

    if (options.userDataDir) {
      args.push(`--user-data-dir=${options.userDataDir}`);
    }

    if (options.headless) {
      args.push('--headless=new');
    }

    if (options.disableGpu) {
      args.push('--disable-gpu');
    }

    if (options.noSandbox) {
      args.push('--no-sandbox');
    }

    if (options.startMaximized) {
      args.push('--start-maximized');
    } else if (options.windowWidth && options.windowHeight) {
      args.push(`--window-size=${options.windowWidth},${options.windowHeight}`);
    }

    // Add common flags for automation
    args.push(
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--no-first-run'
    );

    // Add custom args
    if (options.args) {
      args.push(...options.args);
    }

    // Add start URL if provided
    if (options.startUrl) {
      args.push(options.startUrl);
    }

    return args;
  }
}
