/**
 * git — exact argument construction for plugin marketplace/source clones.
 *
 * The command executor is injected (`GitRunner`) so this is platform-
 * agnostic and unit-testable. Server supplies a Node child_process runner;
 * the extension uses the GitHub tarball path instead (no git).
 *
 * Arg list + env are verbatim from claudy `marketplaceManager.ts:803-899`
 * (design § Git command specifics) — DO NOT relax the SSH/prompt options:
 *   BatchMode=yes + StrictHostKeyChecking=yes + GIT_TERMINAL_PROMPT=0
 *   + GIT_ASKPASS='' is the fail-closed-but-don't-block-tooling stance.
 *   Credential helpers are NOT disabled by default (user's gh/keychain
 *   should work for private repos).
 */

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GitRunner = (
  args: string[],
  opts: { cwd?: string; env: Record<string, string>; timeoutMs: number },
) => Promise<GitRunResult>;

export const GIT_NO_PROMPT_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
};

const SSH_OPTS = 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes';

export interface GitCloneOptions {
  url: string;
  targetPath: string;
  ref?: string;
  sparsePaths?: string[];
  timeoutMs?: number;
  disableCredentialHelper?: boolean;
}

export function buildCloneArgs(o: GitCloneOptions): string[] {
  const args = ['-c', SSH_OPTS, 'clone', '--depth', '1'];
  if (o.sparsePaths && o.sparsePaths.length > 0) {
    args.push('--filter=blob:none', '--no-checkout');
  } else {
    args.push('--recurse-submodules', '--shallow-submodules');
  }
  if (o.ref) args.push('--branch', o.ref);
  if (o.disableCredentialHelper) args.push('-c', 'credential.helper=');
  args.push(o.url, o.targetPath);
  return args;
}

export function buildPullArgs(ref?: string, disableCredentialHelper?: boolean): string[] {
  const args = ['-c', SSH_OPTS];
  if (disableCredentialHelper) args.push('-c', 'credential.helper=');
  if (ref) {
    // caller runs fetch+checkout+pull in sequence; this returns the pull args
    args.push('pull', 'origin', ref);
  } else {
    args.push('pull', 'origin', 'HEAD');
  }
  return args;
}

/** Map common git stderr patterns to actionable user hints (claudy parity). */
export function gitErrorHint(stderr: string): string | null {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return 'Host key changed (possible MITM or key rotation). Verify the host, then `ssh-keygen -R <host>`.';
  }
  if (/Host key verification failed/i.test(stderr)) {
    return 'Unknown SSH host. Connect once manually to accept the host key, then retry.';
  }
  if (/Permission denied \(publickey\)|Could not read from remote repository/i.test(stderr)) {
    return 'SSH auth failed. Check your key/agent (or use an HTTPS source).';
  }
  if (/timed out|timeout/i.test(stderr)) {
    return 'Clone timed out. Increase BROWSERX_PLUGIN_GIT_TIMEOUT_MS or check connectivity.';
  }
  return null;
}

/** Redact credentials embedded in a URL before logging. */
export function redactUrlCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^@/\s]+@/g, '$1***@');
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function gitTimeoutMs(): number {
  const env =
    typeof process !== 'undefined'
      ? process.env?.BROWSERX_PLUGIN_GIT_TIMEOUT_MS
      : undefined;
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Clone via the injected runner. Throws with a hint-augmented message. */
export async function gitClone(run: GitRunner, o: GitCloneOptions): Promise<void> {
  const args = buildCloneArgs(o);
  const res = await run(args, {
    env: { ...GIT_NO_PROMPT_ENV },
    timeoutMs: o.timeoutMs ?? gitTimeoutMs(),
  });
  if (res.code !== 0) {
    const hint = gitErrorHint(res.stderr);
    throw new Error(
      `git clone failed (${res.code}): ${redactUrlCredentials(res.stderr)}` +
        (hint ? `\nHint: ${hint}` : ''),
    );
  }
}
