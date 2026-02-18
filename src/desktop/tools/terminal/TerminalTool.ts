/**
 * Terminal Tool
 *
 * Desktop-mode tool for executing terminal commands.
 * Integrates with the security filter for safe command execution
 * and OS-native sandbox for filesystem write restriction.
 *
 * @module desktop/tools/terminal/TerminalTool
 */

import { invoke } from '@tauri-apps/api/core';
import { SecurityFilter, type SecurityConfig, type FilterResult } from './SecurityFilter';
import {
  SandboxManager,
  type SandboxStatusResult,
  type ExecutionMode,
  type WorkspaceAccess,
} from './SandboxManager';

/**
 * Command execution options
 */
export interface ExecuteOptions {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether to capture stdout */
  captureStdout?: boolean;
  /** Whether to capture stderr */
  captureStderr?: boolean;
  /** Skip security check (dangerous!) */
  skipSecurityCheck?: boolean;
  /** User has confirmed the command */
  userConfirmed?: boolean;
  /** Whether to run in sandbox (used in auto mode by LLM) */
  sandboxed?: boolean;
}

/**
 * Command execution result
 */
export interface ExecuteResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Exit code */
  exitCode: number;
  /** Standard output */
  stdout: string;
  /** Standard error */
  stderr: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
  /** Whether command was blocked by security filter */
  blocked?: boolean;
  /** Reason if blocked */
  blockedReason?: string;
  /** Error message if failed */
  error?: string;
  /** Whether command was actually sandboxed */
  sandboxed: boolean;
}

/**
 * Tool definition for agent integration
 */
export interface TerminalToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

/**
 * Default execution options
 */
const DEFAULT_OPTIONS: ExecuteOptions = {
  timeout: 120000,
  captureStdout: true,
  captureStderr: true,
  skipSecurityCheck: false,
};

/**
 * TerminalTool executes terminal commands with security filtering
 * and optional OS-native sandbox protection.
 */
export class TerminalTool {
  private defaultCwd: string | null = null;
  private securityFilter: SecurityFilter;
  private sandboxManager: SandboxManager;

  constructor(securityConfig?: Partial<SecurityConfig>) {
    this.securityFilter = new SecurityFilter(securityConfig);
    this.sandboxManager = new SandboxManager();
  }

  /**
   * Get the sandbox manager instance
   */
  getSandboxManager(): SandboxManager {
    return this.sandboxManager;
  }

  /**
   * Initialize sandbox support
   */
  async initializeSandbox(): Promise<void> {
    await this.sandboxManager.initialize();
  }

  /**
   * Execute a terminal command
   */
  async execute(command: string, options?: ExecuteOptions): Promise<ExecuteResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();

    // Security check (applies regardless of execution mode)
    if (!opts.skipSecurityCheck) {
      const filterResult = this.securityFilter.check(command);

      if (!filterResult.allowed) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: '',
          executionTimeMs: Date.now() - startTime,
          blocked: true,
          blockedReason: filterResult.reason,
          error: `Command blocked: ${filterResult.reason}`,
          sandboxed: false,
        };
      }

      if (
        this.securityFilter.needsConfirmation(command) &&
        !opts.userConfirmed
      ) {
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: '',
          executionTimeMs: Date.now() - startTime,
          blocked: true,
          blockedReason: 'User confirmation required',
          error: 'This command requires user confirmation before execution',
          sandboxed: false,
        };
      }

      command = filterResult.sanitizedCommand || command;
    }

    // Resolve sandbox mode
    const sandboxConfig = this.sandboxManager.getSandboxConfig(opts.sandboxed);

    try {
      const result = await invoke<{
        exitCode: number;
        stdout: string;
        stderr: string;
        sandboxed: boolean;
      }>('terminal_execute', {
        command,
        cwd: opts.cwd || this.defaultCwd,
        env: opts.env,
        timeout: opts.timeout,
        captureStdout: opts.captureStdout,
        captureStderr: opts.captureStderr,
        sandboxed: sandboxConfig.sandboxed,
        workspaceAccess: sandboxConfig.workspaceAccess,
        networkMode: sandboxConfig.networkMode,
        bindMounts: sandboxConfig.bindMounts,
      });

      return {
        success: result.exitCode === 0,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        executionTimeMs: Date.now() - startTime,
        sandboxed: result.sandboxed,
      };
    } catch (error) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        executionTimeMs: Date.now() - startTime,
        error: `Execution failed: ${error}`,
        sandboxed: false,
      };
    }
  }

  /**
   * Check if a command would be allowed
   */
  check(command: string): FilterResult {
    return this.securityFilter.check(command);
  }

  /**
   * Set default working directory
   */
  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  /**
   * Get the tool definition for agent integration.
   * Generates dynamic descriptions based on execution mode and sandbox status.
   */
  getToolDefinition(
    os?: string,
    sandboxStatus?: SandboxStatusResult,
  ): TerminalToolDefinition {
    const shellInfo = this.getShellInfo(os);
    const mode = this.sandboxManager.executionMode;
    const description = this.buildDescription(shellInfo, mode, sandboxStatus);

    const properties: Record<string, unknown> = {
      command: {
        type: 'string',
        description: 'The command to execute',
      },
      cwd: {
        type: 'string',
        description: 'Working directory (optional)',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
    };

    // Add sandboxed parameter for auto mode
    if (mode === 'auto') {
      properties.sandboxed = {
        type: 'boolean',
        description:
          "Whether to run in a sandboxed environment. Only applicable in 'auto' mode. " +
          'When sandboxed=true, the command runs inside an OS-native sandbox that enforces: ' +
          '(1) file writes and deletes are RESTRICTED to the working directory (cwd), temp directories, ' +
          'and package manager caches — any attempt to create, modify, or delete files outside these paths ' +
          'will fail with a permission error; (2) file reads are allowed system-wide; (3) network access is allowed. ' +
          'Set sandboxed=true for commands that modify files, install packages, delete content, or carry elevated risk. ' +
          "Set sandboxed=false for read-only commands (ls, cat, git status, grep, find). " +
          "Ignored in 'safe' mode (always sandboxed) and 'power' mode (never sandboxed).",
      };
    }

    return {
      name: 'terminal',
      description,
      inputSchema: {
        type: 'object',
        properties,
        required: ['command'],
      },
    };
  }

  /**
   * Build the tool description based on execution mode
   */
  private buildDescription(
    shellInfo: string,
    mode: ExecutionMode,
    sandboxStatus?: SandboxStatusResult,
  ): string {
    const wsAccess = this.sandboxManager.workspaceAccess;
    const statusStr = sandboxStatus
      ? `${sandboxStatus.status} (${sandboxStatus.runtime})`
      : 'unknown';

    switch (mode) {
      case 'safe':
        return (
          `Execute terminal/shell commands on the local system. ${shellInfo}\n\n` +
          'Terminal execution mode: safe. All commands run inside an OS-native sandbox with kernel-level restrictions:\n' +
          '- File writes and deletes are ONLY allowed within the working directory (cwd), temp directories, and package manager caches. ' +
          'Any attempt to create, modify, or delete files outside these paths will fail with a permission error.\n' +
          '- File reads are allowed system-wide.\n' +
          '- Network access is allowed.\n' +
          `Workspace access: ${wsAccess}.\n` +
          'The sandboxed parameter is ignored — all commands are sandboxed. Commands are filtered for safety.'
        );

      case 'power':
        return (
          `Execute terminal/shell commands on the local system. ${shellInfo}\n\n` +
          'Terminal execution mode: power. Commands run directly on the host system without sandbox restrictions. ' +
          'Full read/write/delete access to the entire filesystem. ' +
          'The sandboxed parameter is ignored. Commands are filtered for safety.'
        );

      case 'auto':
      default:
        return (
          `Execute terminal/shell commands on the local system. ${shellInfo}\n\n` +
          'Terminal execution mode: auto. You decide whether each command should run sandboxed or directly.\n\n' +
          'SANDBOX RESTRICTIONS: When sandboxed=true, the OS-native sandbox enforces kernel-level restrictions:\n' +
          '- File writes and deletes are ONLY allowed within the working directory (cwd), temp directories, and package manager caches. ' +
          'Any attempt to create, modify, or delete files outside these paths will fail with a permission error (EROFS/EPERM/ACCESS_DENIED).\n' +
          '- File reads are allowed system-wide — you can read any file on the system.\n' +
          '- Network access is allowed — commands like curl, wget, npm install work normally.\n' +
          '- The command sees the real host filesystem (not a virtual environment), but write operations are restricted.\n\n' +
          'WHEN TO SANDBOX:\n' +
          '- sandboxed=true: Commands that create, modify, or delete files (rm, mv, cp, touch, mkdir, npm install, pip install, git checkout, sed -i, tee, write redirects >). Also use for running untrusted scripts.\n' +
          '- sandboxed=false: Read-only commands (ls, cat, head, tail, pwd, git status, git log, git diff, grep, find, echo, which, env, whoami, df, du, ps, top).\n' +
          '- When in doubt, prefer sandboxed=true.\n\n' +
          `Workspace access: ${wsAccess} (rw = read-write, ro = read-only, none = no host file access).\n` +
          `Sandbox status: ${statusStr}. Commands are filtered for safety.`
        );
    }
  }

  /**
   * Get shell description based on the current OS
   */
  private getShellInfo(os?: string): string {
    switch (os) {
      case 'linux':
        return 'Running on Linux with bash shell. Write commands using bash syntax.';
      case 'macos':
        return 'Running on macOS with zsh shell. Write commands using zsh syntax.';
      case 'windows':
        return 'Running on Windows with PowerShell. Write commands using PowerShell syntax.';
      default:
        return 'Uses bash on Linux, zsh on macOS, and PowerShell on Windows. Write commands using the appropriate shell syntax for the current platform.';
    }
  }

  /**
   * Handle tool invocation from agent
   */
  async handleInvocation(input: {
    command: string;
    cwd?: string;
    timeout?: number;
    userConfirmed?: boolean;
    sandboxed?: boolean;
  }): Promise<string> {
    // Reload config so setting changes take effect without restart
    await this.sandboxManager.reloadConfig();

    const result = await this.execute(input.command, {
      cwd: input.cwd,
      timeout: input.timeout,
      userConfirmed: input.userConfirmed,
      sandboxed: input.sandboxed,
    });

    if (result.blocked) {
      return `Command blocked: ${result.blockedReason}`;
    }

    if (!result.success) {
      return `Command failed (exit code ${result.exitCode}):\n${result.stderr || result.error}`;
    }

    let output = result.stdout || '(no output)';
    if (result.sandboxed) {
      output += '\n[Executed in sandbox]';
    }
    return output;
  }

}
