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

/**
 * SECURITY (Track 10): marketplace.json is untrusted remote content.
 * A clone `url`/`ref` is attacker-influenced. git treats a leading `-`
 * as an option, so `ref: "--upload-pack=touch /tmp/pwned"` is RCE.
 * Allowed URL schemes only; reject `-`-leading url/ref; `--` separates
 * options from positionals for the url (a `--branch <ref>` value cannot
 * be `--`-guarded, so `ref` is rejected outright if it starts with `-`).
 */
const ALLOWED_URL_RE = /^(https:\/\/|git:\/\/|ssh:\/\/|git@[^-])/i;

export class GitArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitArgError';
  }
}

function assertSafeGitUrl(url: string): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new GitArgError('git url must be a non-empty string');
  }
  if (url.startsWith('-')) {
    throw new GitArgError(`git url may not start with '-': ${url}`);
  }
  if (!ALLOWED_URL_RE.test(url)) {
    throw new GitArgError(
      `git url scheme not allowed (use https://, ssh://, git://, or git@): ${url}`,
    );
  }
}

function assertSafeGitRef(ref: string): void {
  if (ref.startsWith('-')) {
    throw new GitArgError(`git ref may not start with '-': ${ref}`);
  }
  // git refs cannot contain spaces, control chars, or '..'
  if (/\s/.test(ref) || ref.includes('..')) {
    throw new GitArgError(`invalid git ref: ${ref}`);
  }
}

export interface GitCloneOptions {
  url: string;
  targetPath: string;
  ref?: string;
  sparsePaths?: string[];
  timeoutMs?: number;
  disableCredentialHelper?: boolean;
}

export function buildCloneArgs(o: GitCloneOptions): string[] {
  assertSafeGitUrl(o.url);
  if (o.ref) assertSafeGitRef(o.ref);
  const args = ['-c', SSH_OPTS, 'clone', '--depth', '1'];
  if (o.sparsePaths && o.sparsePaths.length > 0) {
    args.push('--filter=blob:none', '--no-checkout');
  } else {
    args.push('--recurse-submodules', '--shallow-submodules');
  }
  if (o.ref) args.push('--branch', o.ref);
  if (o.disableCredentialHelper) args.push('-c', 'credential.helper=');
  // `--` terminates option parsing so a crafted url can't be read as a flag.
  args.push('--', o.url, o.targetPath);
  return args;
}

/** SECURITY: a pinned commit sha must be exactly 40-char lowercase hex. */
export function assertSafeGitSha(sha: string): void {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new GitArgError(`invalid git sha (need 40-char lowercase hex): ${sha}`);
  }
}

/** `fetch --depth 1 origin <sha>` args (pinned-sha install path). */
export function buildFetchShaArgs(sha: string, disableCredentialHelper?: boolean): string[] {
  assertSafeGitSha(sha);
  const args = ['-c', SSH_OPTS];
  if (disableCredentialHelper) args.push('-c', 'credential.helper=');
  args.push('fetch', '--depth', '1', 'origin', sha);
  return args;
}

/** `checkout --detach <sha>` args (after a sha fetch). */
export function buildCheckoutShaArgs(sha: string): string[] {
  assertSafeGitSha(sha);
  return ['checkout', '--detach', sha];
}

/**
 * Pinned-sha materialization: `git clone --branch <sha>` does NOT resolve a
 * raw commit, and a pinned sha MUST land on exactly that commit (supply-
 * chain integrity). So clone the default branch, then fetch + detach-checkout
 * the exact sha. Throws (fail-closed) if either step fails — never installs
 * unverified content.
 */
export async function gitFetchCheckoutSha(
  run: GitRunner,
  cloneDir: string,
  sha: string,
  timeoutMs?: number,
): Promise<void> {
  const t = timeoutMs ?? gitTimeoutMs();
  const fetchRes = await run(buildFetchShaArgs(sha), {
    cwd: cloneDir,
    env: { ...GIT_NO_PROMPT_ENV },
    timeoutMs: t,
  });
  if (fetchRes.code !== 0) {
    throw new Error(
      `git fetch ${sha} failed (${fetchRes.code}): ${redactUrlCredentials(fetchRes.stderr)}`,
    );
  }
  const coRes = await run(buildCheckoutShaArgs(sha), {
    cwd: cloneDir,
    env: { ...GIT_NO_PROMPT_ENV },
    timeoutMs: t,
  });
  if (coRes.code !== 0) {
    throw new Error(
      `git checkout ${sha} failed (${coRes.code}): ${redactUrlCredentials(coRes.stderr)}`,
    );
  }
}

export function buildPullArgs(ref?: string, disableCredentialHelper?: boolean): string[] {
  if (ref) assertSafeGitRef(ref);
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

/**
 * Redact credentials embedded in a URL before logging. Covers
 * `scheme://user:pass@host` for http(s)/ssh/git AND scp-style
 * `user@host:path` (review S4).
 */
export function redactUrlCredentials(text: string): string {
  return text
    .replace(/((?:https?|ssh|git):\/\/)[^@/\s]+@/g, '$1***@')
    .replace(/\b[\w.-]+@([\w.-]+:)/g, '***@$1');
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
