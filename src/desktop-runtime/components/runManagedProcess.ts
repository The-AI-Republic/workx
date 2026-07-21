import { spawn } from 'node:child_process';
import { ComponentError, type ComponentRunResult } from '@/core/components';

export interface ManagedProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export async function runManagedProcess(
  executablePath: string,
  args: string[],
  options: ManagedProcessOptions
): Promise<ComponentRunResult> {
  const started = Date.now();
  return new Promise<ComponentRunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        new ComponentError('COMPONENT_EXECUTION_FAILED', 'Component execution was cancelled.')
      );
      return;
    }

    const child = spawn(executablePath, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let outputLimited = false;

    const terminate = (): void => {
      child.kill();
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1000);
      forceTimer.unref?.();
    };

    const finishError = (error: ComponentError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      terminate();
      reject(error);
    };

    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        outputLimited = true;
        finishError(
          new ComponentError(
            'COMPONENT_OUTPUT_LIMIT_EXCEEDED',
            `Component output exceeded ${options.maxOutputBytes} bytes.`
          )
        );
        return;
      }
      target.push(chunk);
    };

    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
    child.on('error', (error) => {
      finishError(
        new ComponentError(
          'COMPONENT_EXECUTION_FAILED',
          `Failed to start the managed component: ${error.message}`,
          false,
          { cause: error }
        )
      );
    });
    child.on('close', (code) => {
      if (settled || outputLimited) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
      });
    });

    const abort = (): void => {
      finishError(
        new ComponentError('COMPONENT_EXECUTION_FAILED', 'Component execution was cancelled.')
      );
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      finishError(
        new ComponentError(
          'COMPONENT_EXECUTION_TIMEOUT',
          `Component execution exceeded ${options.timeoutMs}ms.`
        )
      );
    }, options.timeoutMs);
    timer.unref?.();

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
