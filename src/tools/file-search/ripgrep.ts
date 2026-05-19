/**
 * RipgrepExecutor — the single abstraction over the `rg` binary.
 *
 * Hides three things from the tools that use it:
 *  1. Binary sourcing (hybrid: system `rg` on PATH → bundled fallback).
 *  2. The execution model split — desktop is a Tauri WebView (JS cannot spawn
 *     processes, must `invoke` a Rust command); server is Node (child_process).
 *  3. ripgrep's exit-code semantics (exit 1 = "no matches", not an error;
 *     a real timeout with no output throws).
 *
 * Tools call `runRipgrep(args)` and never learn which platform or which
 * binary served the request. Swapping the bundled-binary strategy later
 * (e.g. a different sidecar) is a change confined to this file + Rust.
 */

export interface RipgrepResult {
  stdout: string;
  stderr: string;
  /** ripgrep exit code: 0 = matches, 1 = no matches, 2 = error. */
  exitCode: number;
  timedOut: boolean;
  /** Which binary served the request — for diagnostics only. */
  source: 'system' | 'bundled';
}

export interface RunRipgrepOptions {
  /** Working directory ripgrep runs in (search root). */
  cwd?: string;
  /** Hard timeout; defaults to 20s (enforced in Rust on desktop, by execFile on server). */
  timeoutMs?: number;
  /** Max stdout bytes to buffer; both paths cap memory (Node via execFile, desktop via the Rust reader). */
  maxBuffer?: number;
}

export class RipgrepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ripgrep timed out after ${timeoutMs}ms`);
    this.name = 'RipgrepTimeoutError';
  }
}

export class RipgrepNotFoundError extends Error {
  constructor() {
    super(
      'ripgrep (rg) was not found on PATH and no bundled binary is available. ' +
        'Install ripgrep (https://github.com/BurntSushi/ripgrep#installation) to use code search.'
    );
    this.name = 'RipgrepNotFoundError';
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024; // 32 MB — wide greps can be large

function getBuildMode(): string {
  return typeof __BUILD_MODE__ !== 'undefined' ? __BUILD_MODE__ : 'extension';
}

/**
 * Run ripgrep with an explicit argv array (NEVER a shell string — the
 * pattern/path/glob are model-controlled, so shell interpolation must not
 * be reachable). Exit code 1 (no matches) resolves normally; the caller
 * interprets it. A timeout rejects with RipgrepTimeoutError.
 */
export async function runRipgrep(
  args: string[],
  opts: RunRipgrepOptions = {}
): Promise<RipgrepResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const mode = getBuildMode();

  if (mode === 'desktop') {
    return runViaTauri(args, opts.cwd, timeoutMs);
  }
  return runViaNode(args, opts.cwd, timeoutMs, opts.maxBuffer ?? DEFAULT_MAX_BUFFER);
}

/**
 * Desktop: delegate to the Rust `ripgrep_execute` command. Rust owns the
 * hybrid resolution (system → bundled sidecar next to the exe) and the
 * timeout/kill so the WebView never has to spawn a process.
 */
async function runViaTauri(
  args: string[],
  cwd: string | undefined,
  timeoutMs: number
): Promise<RipgrepResult> {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    const r = await invoke<RipgrepResult>('ripgrep_execute', {
      args,
      cwd: cwd ?? null,
      timeoutMs,
    });
    if (r.timedOut) throw new RipgrepTimeoutError(timeoutMs);
    return r;
  } catch (e) {
    if (e instanceof RipgrepTimeoutError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/not found|no such file|enoent/i.test(msg)) throw new RipgrepNotFoundError();
    throw e;
  }
}

/**
 * Server / Node: hybrid resolution in JS — try system `rg` first, fall back
 * to the `@vscode/ripgrep` bundled binary on ENOENT.
 */
async function runViaNode(
  args: string[],
  cwd: string | undefined,
  timeoutMs: number,
  maxBuffer: number
): Promise<RipgrepResult> {
  const { execFile } = await import('node:child_process');

  const attempt = (
    bin: string,
    source: 'system' | 'bundled'
  ): Promise<RipgrepResult> =>
    new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        args,
        { cwd, timeout: timeoutMs, maxBuffer, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              reject(Object.assign(new Error('ENOENT'), { enoent: true }));
              return;
            }
            // maxBuffer exceeded also kills the child (killed + SIGTERM), but
            // this is NOT a timeout. Return the partial output with a notice
            // so the model still gets results + guidance — mirrors the
            // desktop Rust reader's cap-and-annotate behavior. Must be
            // checked before the timeout branch below (same kill signature).
            if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message)) {
              resolve({
                stdout: (stdout ?? '') + `\n[output truncated at ${maxBuffer} bytes]\n`,
                stderr: stderr ?? '',
                exitCode: 0,
                timedOut: false,
                source,
              });
              return;
            }
            // execFile sets killed + SIGTERM on timeout.
            if ((err as any).killed && (err as any).signal === 'SIGTERM') {
              resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 124, timedOut: true, source });
              return;
            }
            // Non-zero exit (incl. 1 = no matches) is NOT a rejection.
            const exitCode = typeof (err as any).code === 'number' ? (err as any).code : 2;
            resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, timedOut: false, source });
            return;
          }
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0, timedOut: false, source });
        }
      );
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(Object.assign(new Error('ENOENT'), { enoent: true }));
        } else {
          reject(err);
        }
      });
    });

  let result: RipgrepResult;
  try {
    result = await attempt('rg', 'system');
  } catch (e) {
    if (!(e as any)?.enoent) throw e;
    let rgPath: string;
    try {
      ({ rgPath } = await import('@vscode/ripgrep'));
    } catch {
      throw new RipgrepNotFoundError();
    }
    try {
      result = await attempt(rgPath, 'bundled');
    } catch (e2) {
      if ((e2 as any)?.enoent) throw new RipgrepNotFoundError();
      throw e2;
    }
  }

  if (result.timedOut) throw new RipgrepTimeoutError(timeoutMs);
  return result;
}

/** ripgrep convention: exit code 1 with empty stdout means "no matches". */
export function isNoMatches(r: RipgrepResult): boolean {
  return r.exitCode === 1 && r.stdout.trim() === '';
}
