/**
 * Sandbox Manager
 *
 * Manages terminal execution configuration and sandbox mode resolution.
 *
 * @module desktop/tools/terminal/SandboxManager
 */

import { getConfigStorage } from '@/core/storage/ConfigStorageProvider';

// ─── Types ──────────────────────────────────────────────────────────

/** Terminal execution mode */
export type ExecutionMode = 'safe' | 'power' | 'auto';

/** Workspace mount access level */
export type WorkspaceAccess = 'rw' | 'ro' | 'none';

/** Network isolation level */
export type NetworkMode = 'host' | 'sandbox';

/** An explicit bind mount mapping a host path into the sandbox */
export interface BindMount {
  hostPath: string;
  access: 'rw' | 'ro';
}

/** Sandbox runtime availability status */
export type SandboxStatus = 'available' | 'unavailable' | 'needs-installation' | 'installing';

/** Result of checking sandbox status */
export interface SandboxStatusResult {
  status: SandboxStatus;
  runtime: string;
  os: string;
  version?: string;
  message?: string;
}

/** Result of installing sandbox runtime */
export interface SandboxInstallResult {
  success: boolean;
  message: string;
}

/** Sandbox configuration for a command execution */
export interface SandboxConfig {
  sandboxed: boolean;
  workspaceAccess: WorkspaceAccess;
  networkMode: NetworkMode;
  bindMounts: BindMount[];
}

// ─── Config Storage Keys ────────────────────────────────────────────

const CONFIG_KEYS = {
  executionMode: 'terminal.executionMode',
  workspaceAccess: 'terminal.sandbox.workspaceAccess',
  networkMode: 'terminal.sandbox.networkMode',
  bindMounts: 'terminal.sandbox.bindMounts',
} as const;

// ─── SandboxManager ─────────────────────────────────────────────────

/**
 * SandboxManager handles:
 * 1. Reading/writing sandbox settings from config storage
 * 2. Checking sandbox runtime status
 * 3. Resolving execution mode to a sandboxed boolean per command
 */
export class SandboxManager {
  private _status: SandboxStatusResult | null = null;
  private _executionMode: ExecutionMode = 'auto';
  private _workspaceAccess: WorkspaceAccess = 'rw';
  private _networkMode: NetworkMode = 'host';
  private _bindMounts: BindMount[] = [];

  /** Get the cached sandbox status */
  get status(): SandboxStatusResult | null {
    return this._status;
  }

  /** Get current execution mode */
  get executionMode(): ExecutionMode {
    return this._executionMode;
  }

  /** Get current workspace access */
  get workspaceAccess(): WorkspaceAccess {
    return this._workspaceAccess;
  }

  /** Get current network mode */
  get networkMode(): NetworkMode {
    return this._networkMode;
  }

  /** Get current bind mounts */
  get bindMounts(): BindMount[] {
    return this._bindMounts;
  }

  /**
   * Initialize sandbox manager — fetch status and load config.
   *
   * Only checks whether the sandbox runtime is available; does NOT
   * attempt automatic installation or repair (which requires sudo).
   * Users can trigger installation explicitly from the Settings UI.
   */
  async initialize(): Promise<void> {
    await this.checkStatus();

    if (this._status && (this._status.status === 'unavailable' || this._status.status === 'needs-installation')) {
      console.log(
        '[SandboxManager] Sandbox not ready (%s). Use Settings → Tools to install.',
        this._status.status,
      );
    }

    await this.loadConfig();
  }

  /**
   * Check sandbox runtime availability.
   *
   * The runtime sidecar path no longer exposes the old Tauri sandbox command
   * bridge. Until sandboxing is ported into the sidecar, sandboxed terminal
   * execution is reported as unavailable and callers must refuse sandboxed
   * commands.
   */
  async checkStatus(): Promise<SandboxStatusResult> {
    this._status = {
      status: 'unavailable',
      runtime: 'runtime-sidecar',
      os: process.platform,
      message: 'Sandboxed terminal execution has not been ported to the runtime sidecar.',
    };
    return this._status;
  }

  /**
   * Load sandbox configuration from config storage
   */
  async loadConfig(): Promise<void> {
    try {
      const storage = getConfigStorage();

      const mode = await storage.get<string>(CONFIG_KEYS.executionMode);
      if (mode === 'safe' || mode === 'power' || mode === 'auto') {
        this._executionMode = mode;
      }

      const access = await storage.get<string>(CONFIG_KEYS.workspaceAccess);
      if (access === 'rw' || access === 'ro' || access === 'none') {
        this._workspaceAccess = access;
      }

      const network = await storage.get<string>(CONFIG_KEYS.networkMode);
      if (network === 'host' || network === 'sandbox') {
        this._networkMode = network;
      }

      const mounts = await storage.get<BindMount[] | string>(CONFIG_KEYS.bindMounts);
      if (Array.isArray(mounts)) {
        this._bindMounts = mounts;
      } else if (typeof mounts === 'string') {
        try {
          const parsed = JSON.parse(mounts);
          if (Array.isArray(parsed)) {
            this._bindMounts = parsed;
          }
        } catch {
          // Invalid JSON, keep defaults
        }
      }
    } catch (error) {
      console.warn('[SandboxManager] Failed to load config, using defaults:', error);
    }
  }

  /**
   * Reload config from storage so the next command picks up any setting changes.
   */
  async reloadConfig(): Promise<void> {
    await this.loadConfig();
  }

  /**
   * Set execution mode and persist to config
   */
  async setExecutionMode(mode: ExecutionMode): Promise<void> {
    this._executionMode = mode;
    await getConfigStorage().set(CONFIG_KEYS.executionMode, mode);
  }

  /**
   * Set workspace access and persist to config
   */
  async setWorkspaceAccess(access: WorkspaceAccess): Promise<void> {
    this._workspaceAccess = access;
    await getConfigStorage().set(CONFIG_KEYS.workspaceAccess, access);
  }

  /**
   * Set network mode and persist to config
   */
  async setNetworkMode(mode: NetworkMode): Promise<void> {
    this._networkMode = mode;
    await getConfigStorage().set(CONFIG_KEYS.networkMode, mode);
  }

  /**
   * Set bind mounts and persist to config
   */
  async setBindMounts(mounts: BindMount[]): Promise<void> {
    this._bindMounts = mounts;
    await getConfigStorage().set(CONFIG_KEYS.bindMounts, mounts);
  }

  /**
   * Validate a bind mount path
   * Returns null if valid, or an error message if invalid
   */
  validateBindMount(mount: BindMount): string | null {
    if (!mount.hostPath) {
      return 'Host path is required';
    }
    if (!mount.hostPath.startsWith('/') && !mount.hostPath.match(/^[A-Z]:\\/)) {
      return 'Host path must be absolute';
    }
    if (mount.access !== 'rw' && mount.access !== 'ro') {
      return 'Access must be "rw" or "ro"';
    }
    return null;
  }

  /**
   * Resolve the execution mode to a sandboxed boolean for a given command.
   *
   * - safe → always true
   * - power → always false
   * - auto → use the LLM's sandboxed parameter value
   *
   * @param llmSandboxed - The LLM's sandboxed choice (only used in auto mode)
   */
  resolveSandboxed(llmSandboxed?: boolean): boolean {
    switch (this._executionMode) {
      case 'safe':
        return true;
      case 'power':
        return false;
      case 'auto':
      default:
        return llmSandboxed ?? false;
    }
  }

  /**
   * Get the sandbox configuration for command execution
   */
  getSandboxConfig(llmSandboxed?: boolean): SandboxConfig {
    return {
      sandboxed: this.resolveSandboxed(llmSandboxed),
      workspaceAccess: this._workspaceAccess,
      networkMode: this._networkMode,
      bindMounts: this._bindMounts,
    };
  }

  /**
   * Check if sandbox is available on this platform
   */
  isAvailable(): boolean {
    return this._status?.status === 'available';
  }

  /**
   * Install sandbox runtime.
   */
  async installRuntime(): Promise<SandboxInstallResult> {
    return {
      success: false,
      message: 'Sandbox installation is not available from the runtime sidecar yet.',
    };
  }
}
