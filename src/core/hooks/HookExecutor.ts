/**
 * HookExecutor — Executes individual hooks and returns structured results.
 *
 * Each hook type has its own execution path:
 * - command: spawn child process (server/desktop) or skip (extension)
 * - prompt: call LLM via model client
 * - http: POST to URL
 *
 * Exit code semantics (command hooks):
 *   0 → success
 *   1 → non_blocking_error (stderr to user, execution continues)
 *   2 → blocking_error (stderr to model, operation blocked)
 */

import { v4 as uuidv4 } from 'uuid';
import type { HookCommand, HookInput, HookResult, HookOutcome } from './types';

/** Default timeout for command hooks (seconds) */
const DEFAULT_COMMAND_TIMEOUT_S = 30;
/** Default timeout for prompt hooks (seconds) */
const DEFAULT_PROMPT_TIMEOUT_S = 60;
/** Default timeout for HTTP hooks (seconds) */
const DEFAULT_HTTP_TIMEOUT_S = 30;
/** Max recursion depth to prevent infinite hook loops */
const MAX_RECURSION_DEPTH = 3;

export class HookExecutor {
  /**
   * Execute a single hook command with the given input context.
   *
   * @param depth Current recursion depth. Callers should not set this;
   *              it is used internally to guard against infinite loops.
   */
  async execute(
    hook: HookCommand,
    input: HookInput,
    signal?: AbortSignal,
    depth = 0,
  ): Promise<HookResult> {
    const hookId = `hexec_${uuidv4()}`;
    const start = Date.now();

    // Recursion guard
    if (depth >= MAX_RECURSION_DEPTH) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: `Hook recursion depth exceeded (max ${MAX_RECURSION_DEPTH})`,
        duration: 0,
      };
    }

    // Check for pre-aborted signal
    if (signal?.aborted) {
      return { hookId, outcome: 'cancelled', duration: 0 };
    }

    try {
      switch (hook.type) {
        case 'command':
          return await this.executeCommand(hook, input, hookId, start, signal);
        case 'prompt':
          return await this.executePrompt(hook, input, hookId, start);
        case 'http':
          return await this.executeHttp(hook, input, hookId, start, signal);
        default:
          return {
            hookId,
            outcome: 'non_blocking_error',
            stderr: `Unknown hook type: ${(hook as HookCommand).type}`,
            duration: Date.now() - start,
          };
      }
    } catch (error) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Command Hooks
  // -----------------------------------------------------------------------

  private async executeCommand(
    hook: HookCommand,
    input: HookInput,
    hookId: string,
    start: number,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    if (!hook.command) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: 'Command hook missing "command" field',
        duration: Date.now() - start,
      };
    }

    // Extension mode: command hooks not available
    if (
      typeof __BUILD_MODE__ !== 'undefined' &&
      __BUILD_MODE__ === 'extension'
    ) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: 'Command hooks are not available in extension mode',
        duration: Date.now() - start,
      };
    }

    const substituted = HookExecutor.substituteVariables(hook.command, input, hook.shell);
    const timeoutMs = (hook.timeout ?? DEFAULT_COMMAND_TIMEOUT_S) * 1000;
    const inputJson = JSON.stringify(input);

    try {
      const { exitCode, stdout, stderr } = await HookExecutor.spawnCommand(
        substituted,
        inputJson,
        timeoutMs,
        signal,
        hook.shell,
      );

      const outcome = HookExecutor.exitCodeToOutcome(exitCode);
      const parsed = HookExecutor.tryParseJson(stdout);

      return {
        hookId,
        outcome,
        exitCode,
        stdout,
        stderr,
        duration: Date.now() - start,
        // Parsed fields from JSON stdout (if any)
        continue: parsed?.continue,
        suppressOutput: parsed?.suppressOutput,
        stopReason: parsed?.stopReason,
        decision: parsed?.decision,
        systemMessage: parsed?.systemMessage,
        updatedInput: parsed?.hookSpecificOutput?.updatedInput ?? parsed?.updatedInput,
        updatedOutput: parsed?.hookSpecificOutput?.updatedOutput ?? parsed?.updatedOutput,
        additionalContext:
          parsed?.hookSpecificOutput?.additionalContext ??
          parsed?.additionalContext,
      };
    } catch (error) {
      const isTimeout =
        error instanceof Error && error.message.includes('timeout');
      return {
        hookId,
        outcome: isTimeout ? 'timeout' : 'non_blocking_error',
        stderr: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Prompt Hooks
  // -----------------------------------------------------------------------

  private async executePrompt(
    hook: HookCommand,
    input: HookInput,
    hookId: string,
    start: number,
  ): Promise<HookResult> {
    if (!hook.prompt) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: 'Prompt hook missing "prompt" field',
        duration: Date.now() - start,
      };
    }

    const substituted = HookExecutor.substituteVariables(hook.prompt, input);

    // TODO(Phase 2): Prompt hooks require a model client which is not available
    // in the current architecture without coupling to ModelClientFactory.
    return {
      hookId,
      outcome: 'non_blocking_error',
      stderr: `Prompt hooks are not yet implemented (Phase 2). Prompt: ${substituted}`,
      duration: Date.now() - start,
    };
  }

  // -----------------------------------------------------------------------
  // HTTP Hooks
  // -----------------------------------------------------------------------

  private async executeHttp(
    hook: HookCommand,
    input: HookInput,
    hookId: string,
    start: number,
    signal?: AbortSignal,
  ): Promise<HookResult> {
    if (!hook.url) {
      return {
        hookId,
        outcome: 'non_blocking_error',
        stderr: 'HTTP hook missing "url" field',
        duration: Date.now() - start,
      };
    }

    const timeoutMs = (hook.timeout ?? DEFAULT_HTTP_TIMEOUT_S) * 1000;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Combine with external signal
      if (signal) {
        signal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...hook.headers,
      };

      const response = await fetch(hook.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return {
          hookId,
          outcome: 'non_blocking_error',
          stderr: `HTTP hook returned ${response.status}: ${response.statusText}`,
          duration: Date.now() - start,
        };
      }

      const text = await response.text();
      const parsed = HookExecutor.tryParseJson(text);

      return {
        hookId,
        outcome: 'success',
        stdout: text,
        duration: Date.now() - start,
        continue: parsed?.continue,
        suppressOutput: parsed?.suppressOutput,
        stopReason: parsed?.stopReason,
        decision: parsed?.decision,
        systemMessage: parsed?.systemMessage,
        updatedInput: parsed?.updatedInput,
        updatedOutput: parsed?.updatedOutput,
        additionalContext: parsed?.additionalContext,
      };
    } catch (error) {
      const isAbort =
        error instanceof Error && error.name === 'AbortError';
      return {
        hookId,
        outcome: isAbort ? 'timeout' : 'non_blocking_error',
        stderr: error instanceof Error ? error.message : String(error),
        duration: Date.now() - start,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Static Utilities
  // -----------------------------------------------------------------------

  /**
   * Substitute variables in a hook command string.
   * All values are shell-escaped to prevent command injection.
   */
  static substituteVariables(
    template: string,
    input: HookInput,
    shell?: 'bash' | 'powershell',
  ): string {
    const esc = shell === 'powershell'
      ? HookExecutor.escapePowerShell
      : HookExecutor.escapeBash;

    return template
      .replace(/\$TOOL_NAME/g, esc(input.tool_name ?? ''))
      .replace(
        /\$FILE_PATH/g,
        esc(
          (input.tool_input?.file_path as string) ??
            (input.tool_input?.path as string) ??
            '',
        ),
      )
      .replace(
        /\$ARGUMENTS/g,
        esc(input.tool_input ? JSON.stringify(input.tool_input) : ''),
      )
      .replace(/\$SESSION_ID/g, esc(input.session_id ?? ''))
      .replace(/\$CWD/g, esc(input.cwd ?? ''))
      .replace(/\$CURRENT_URL/g, esc(input.current_url ?? ''))
      .replace(/\$CURRENT_DOMAIN/g, esc(input.current_domain ?? ''))
      .replace(/\$TAB_ID/g, esc(input.tab_id !== undefined ? String(input.tab_id) : ''));
  }

  /**
   * Escape a string for safe inclusion in a bash command.
   * Wraps in single quotes and escapes internal single quotes.
   */
  static escapeBash(value: string): string {
    if (value === '') return "''";
    return "'" + value.replace(/'/g, "'\\''") + "'";
  }

  /**
   * Escape a string for safe inclusion in a PowerShell command.
   * Wraps in single quotes and doubles internal single quotes.
   */
  static escapePowerShell(value: string): string {
    if (value === '') return "''";
    return "'" + value.replace(/'/g, "''") + "'";
  }

  /**
   * Map exit code to HookOutcome.
   */
  static exitCodeToOutcome(exitCode: number): HookOutcome {
    switch (exitCode) {
      case 0:
        return 'success';
      case 2:
        return 'blocking_error';
      default:
        return 'non_blocking_error';
    }
  }

  /**
   * Try to parse JSON stdout. Returns undefined if not valid JSON.
   */
  static tryParseJson(text: string | undefined): any | undefined {
    if (!text || !text.trim()) return undefined;
    try {
      return JSON.parse(text.trim());
    } catch {
      return undefined;
    }
  }

  /**
   * Spawn a shell command, pipe input to stdin, and collect output.
   * Only available in Node.js/server or Tauri/desktop environments.
   */
  private static async spawnCommand(
    command: string,
    stdinData: string,
    timeoutMs: number,
    signal?: AbortSignal,
    shell?: 'bash' | 'powershell',
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    // Dynamic import to avoid bundling Node.js APIs in extension builds
    const { spawn } = await import('child_process');

    return new Promise((resolve, reject) => {
      const shellBin = shell === 'powershell' ? 'powershell' : 'bash';
      const shellArgs = shell === 'powershell' ? ['-Command', command] : ['-c', command];

      const proc = spawn(shellBin, shellArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settle = (exitCode: number) => {
        if (settled) return;
        settled = true;
        resolve({ exitCode, stdout, stderr });
      };

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on('close', (code) => {
        settle(code ?? 1);
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });

      // Write input to stdin
      proc.stdin.write(stdinData);
      proc.stdin.end();

      // Timeout
      const timer = setTimeout(() => {
        if (!settled) {
          proc.kill('SIGKILL');
          settled = true;
          reject(new Error(`Hook command timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // External abort
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (!settled) {
              proc.kill('SIGKILL');
              settled = true;
              reject(new Error('Hook command aborted'));
            }
          },
          { once: true },
        );
      }

      proc.on('close', () => clearTimeout(timer));
    });
  }
}

// Declare the global __BUILD_MODE__ so TypeScript doesn't complain
declare const __BUILD_MODE__: string | undefined;
