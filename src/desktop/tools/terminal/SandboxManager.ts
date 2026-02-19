/**
 * Sandbox Manager
 *
 * Manages sandbox configuration, status detection, and execution mode resolution
 * for the terminal tool's OS-native sandbox feature.
 *
 * @module desktop/tools/terminal/SandboxManager
 */

import { invoke } from '@tauri-apps/api/core';

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
   * Initialize sandbox manager — fetch status, auto-fix if needed, load config.
   *
   * If the sandbox runtime is missing or broken (e.g. AppArmor blocking bwrap
   * on Ubuntu 24.04+, or unprivileged_userns_clone=0 on older Debian), this
   * will automatically attempt to install/fix it so the user doesn't have to
   * do anything manually.
   */
  async initialize(): Promise<void> {
    await this.checkStatus();

    // Auto-fix: if sandbox is not working, try to install/repair it
    if (this._status && (this._status.status === 'unavailable' || this._status.status === 'needs-installation')) {
      console.log(
        '[SandboxManager] Sandbox not ready (%s), attempting automatic fix...',
        this._status.status,
      );
      try {
        const result = await this.installRuntime();
        if (result.success) {
          console.log('[SandboxManager] Auto-fix succeeded:', result.message);
          // Re-check status after successful fix
          await this.checkStatus();
        } else {
          console.warn('[SandboxManager] Auto-fix failed:', result.message);
        }
      } catch (error) {
        console.warn('[SandboxManager] Auto-fix error:', error);
      }
    }

    await this.loadConfig();
  }

  /**
   * Check sandbox runtime availability via Tauri command
   */
  async checkStatus(): Promise<SandboxStatusResult> {
    try {
      this._status = await invoke<SandboxStatusResult>('sandbox_check_status');
    } catch (error) {
      this._status = {
        status: 'unavailable',
        runtime: 'none',
        os: 'unknown',
        message: `Failed to check sandbox status: ${error}`,
      };
    }
    return this._status;
  }

  /**
   * Load sandbox configuration from config storage
   */
  async loadConfig(): Promise<void> {
    try {
      const mode = await invoke<string | null>('config_storage_get', {
        key: CONFIG_KEYS.executionMode,
      });
      if (mode === 'safe' || mode === 'power' || mode === 'auto') {
        this._executionMode = mode;
      }

      const access = await invoke<string | null>('config_storage_get', {
        key: CONFIG_KEYS.workspaceAccess,
      });
      if (access === 'rw' || access === 'ro' || access === 'none') {
        this._workspaceAccess = access;
      }

      const network = await invoke<string | null>('config_storage_get', {
        key: CONFIG_KEYS.networkMode,
      });
      if (network === 'host' || network === 'sandbox') {
        this._networkMode = network;
      }

      const mounts = await invoke<string | null>('config_storage_get', {
        key: CONFIG_KEYS.bindMounts,
      });
      if (mounts) {
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
    await invoke('config_storage_set', {
      key: CONFIG_KEYS.executionMode,
      value: mode,
    });
  }

  /**
   * Set workspace access and persist to config
   */
  async setWorkspaceAccess(access: WorkspaceAccess): Promise<void> {
    this._workspaceAccess = access;
    await invoke('config_storage_set', {
      key: CONFIG_KEYS.workspaceAccess,
      value: access,
    });
  }

  /**
   * Set network mode and persist to config
   */
  async setNetworkMode(mode: NetworkMode): Promise<void> {
    this._networkMode = mode;
    await invoke('config_storage_set', {
      key: CONFIG_KEYS.networkMode,
      value: mode,
    });
  }

  /**
   * Set bind mounts and persist to config
   */
  async setBindMounts(mounts: BindMount[]): Promise<void> {
    this._bindMounts = mounts;
    await invoke('config_storage_set', {
      key: CONFIG_KEYS.bindMounts,
      value: JSON.stringify(mounts),
    });
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
   * Get the sandbox configuration for passing to Tauri invoke
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
   * Install sandbox runtime (Linux only)
   */
  async installRuntime(): Promise<SandboxInstallResult> {
    try {
      return await invoke<SandboxInstallResult>('sandbox_install_runtime');
    } catch (error) {
      return {
        success: false,
        message: `Installation failed: ${error}`,
      };
    }
  }
}
