/**
 * Terminal Tool
 *
 * Desktop-mode tool for executing terminal commands.
 * Integrates with the security filter for safe command execution
 * and OS-native sandbox for filesystem write restriction.
 *
 * @module desktop/tools/terminal/TerminalTool
 */

import { exec as execCommand, type ExecException } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { ToolContext } from '../../../tools/BaseTool';
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
   * Execute a terminal command.
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
    if (sandboxConfig.sandboxed && !this.sandboxManager.isAvailable()) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        executionTimeMs: Date.now() - startTime,
        error: this.sandboxManager.status?.message ?? 'Sandboxed terminal execution is unavailable',
        sandboxed: false,
      };
    }

    try {
      const result = await this.executeInRuntime({
        command,
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeout,
        captureStdout: opts.captureStdout,
        captureStderr: opts.captureStderr,
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

  private executeInRuntime(options: {
    command: string;
    cwd?: string | null;
    env?: Record<string, string>;
    timeout?: number;
    captureStdout?: boolean;
    captureStderr?: boolean;
  }): Promise<{ exitCode: number; stdout: string; stderr: string; sandboxed: boolean }> {
    return new Promise((resolve) => {
      execCommand(
        options.command,
        {
          cwd: options.cwd ?? undefined,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          timeout: options.timeout,
          maxBuffer: 10 * 1024 * 1024,
          encoding: 'utf8',
        },
        (error: ExecException | null, stdout, stderr) => {
          const exitCode = typeof error?.code === 'number' ? error.code : error ? -1 : 0;
          const timeoutMessage = error?.signal === 'SIGTERM' ? 'Command timed out or was terminated' : '';
          resolve({
            exitCode,
            stdout: options.captureStdout === false ? '' : stdout,
            stderr: options.captureStderr === false ? '' : [stderr, timeoutMessage].filter(Boolean).join('\n'),
            sandboxed: false,
          });
        },
      );
    });
  }

  /**
   * Check if a command would be allowed
   */
  check(command: string): FilterResult {
    return this.securityFilter.check(command);
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
      workdir: {
        type: 'string',
        description:
          'Optional subdirectory for this command, relative to the session working folder.',
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
        description: sandboxStatus?.status === 'available'
          ? "Whether to run in the configured sandbox. Only applicable in 'auto' mode."
          : 'Sandboxing is not available in the desktop runtime yet. sandboxed=true will be rejected; sandboxed=false runs on the host.',
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

    if (sandboxStatus?.status !== 'available') {
      return (
        `Execute terminal/shell commands on the local system. ${shellInfo}\n\n` +
        'Commands start in the session working folder unless workdir selects a relative subdirectory for that command. ' +
        'The working folder is not a filesystem security boundary: host commands may access paths outside it. ' +
        'Sandboxed terminal execution is not available in the desktop runtime yet, so sandboxed=true is rejected. ' +
        `Sandbox status: ${statusStr}. Commands still pass through the terminal security filter and approval flow.`
      );
    }

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
    workdir?: string;
    timeout?: number;
    userConfirmed?: boolean;
    sandboxed?: boolean;
  }, context?: ToolContext): Promise<string> {
    // Reload config so setting changes take effect without restart
    await this.sandboxManager.reloadConfig();

    const sessionWorkingDirectory = context?.executionContext?.workspace?.workingDirectory;
    let commandWorkingDirectory = sessionWorkingDirectory;
    if (input.workdir?.trim()) {
      const requested = input.workdir.trim();
      if (isAbsolute(requested)) {
        return 'Command failed: workdir must be relative to the session working folder.';
      }
      if (!sessionWorkingDirectory) {
        return 'Command failed: a relative workdir requires a session working folder.';
      }
      const resolvedWorkdir = resolve(sessionWorkingDirectory, requested);
      const relativeWorkdir = relative(sessionWorkingDirectory, resolvedWorkdir);
      if (
        relativeWorkdir === '..'
        || relativeWorkdir.startsWith(`..${sep}`)
        || isAbsolute(relativeWorkdir)
      ) {
        return 'Command failed: workdir must stay within the session working folder.';
      }
      commandWorkingDirectory = resolvedWorkdir;
    }

    if (!commandWorkingDirectory) {
      return 'Command failed: no working folder is available for this session.';
    }

    const result = await this.execute(input.command, {
      cwd: commandWorkingDirectory,
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
