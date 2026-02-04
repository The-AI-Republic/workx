/**
 * Terminal Tool
 *
 * Desktop-mode tool for executing terminal commands.
 * Integrates with the security filter for safe command execution.
 *
 * @module desktop/tools/terminal/TerminalTool
 */

import { invoke } from '@tauri-apps/api/tauri';
import { SecurityFilter, type SecurityConfig, type FilterResult } from './SecurityFilter';

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
  timeout: 30000,
  captureStdout: true,
  captureStderr: true,
  skipSecurityCheck: false,
};

/**
 * TerminalTool executes terminal commands with security filtering
 *
 * @example
 * ```typescript
 * const terminal = new TerminalTool();
 *
 * // Execute a command
 * const result = await terminal.execute('ls -la');
 * console.log(result.stdout);
 *
 * // Execute with options
 * const result2 = await terminal.execute('npm install', {
 *   cwd: '/path/to/project',
 *   timeout: 60000,
 * });
 * ```
 */
export class TerminalTool {
  private securityFilter: SecurityFilter;
  private defaultCwd: string | null = null;

  constructor(securityConfig?: Partial<SecurityConfig>) {
    this.securityFilter = new SecurityFilter(securityConfig);
  }

  /**
   * Execute a terminal command
   *
   * @param command - Command to execute
   * @param options - Execution options
   * @returns Execution result
   */
  async execute(command: string, options?: ExecuteOptions): Promise<ExecuteResult> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const startTime = Date.now();

    // Security check
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
        };
      }

      // Check if confirmation required
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
        };
      }

      command = filterResult.sanitizedCommand || command;
    }

    try {
      // Execute via Tauri command
      const result = await invoke<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>('terminal_execute', {
        command,
        cwd: opts.cwd || this.defaultCwd,
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
      };
    } catch (error) {
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        executionTimeMs: Date.now() - startTime,
        error: `Execution failed: ${error}`,
      };
    }
  }

  /**
   * Check if a command would be allowed
   *
   * @param command - Command to check
   * @returns Filter result
   */
  check(command: string): FilterResult {
    return this.securityFilter.check(command);
  }

  /**
   * Set default working directory
   *
   * @param cwd - Working directory path
   */
  setDefaultCwd(cwd: string): void {
    this.defaultCwd = cwd;
  }

  /**
   * Get the tool definition for agent integration
   */
  getToolDefinition(): TerminalToolDefinition {
    return {
      name: 'terminal',
      description:
        'Execute terminal/shell commands on the local system. Use this tool to run commands, scripts, and system operations. Commands are filtered for safety.',
      inputSchema: {
        type: 'object',
        properties: {
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
            description: 'Timeout in milliseconds (default: 30000)',
          },
        },
        required: ['command'],
      },
    };
  }

  /**
   * Handle tool invocation from agent
   *
   * @param input - Tool input
   * @returns Formatted result for agent
   */
  async handleInvocation(input: {
    command: string;
    cwd?: string;
    timeout?: number;
    userConfirmed?: boolean;
  }): Promise<string> {
    const result = await this.execute(input.command, {
      cwd: input.cwd,
      timeout: input.timeout,
      userConfirmed: input.userConfirmed,
    });

    if (result.blocked) {
      return `Command blocked: ${result.blockedReason}`;
    }

    if (!result.success) {
      return `Command failed (exit code ${result.exitCode}):\n${result.stderr || result.error}`;
    }

    return result.stdout || '(no output)';
  }

  /**
   * Update security configuration
   */
  updateSecurityConfig(config: Partial<SecurityConfig>): void {
    this.securityFilter.updateConfig(config);
  }

  /**
   * Get current security configuration
   */
  getSecurityConfig(): SecurityConfig {
    return this.securityFilter.getConfig();
  }
}
