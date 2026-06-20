/**
 * FileSystemExecutor — the single abstraction over the code-mode fs commands.
 *
 * Sibling of RipgrepExecutor (./ripgrep.ts).
 *
 * After Track 43's cutover the agent (and these tools) runs inside the
 * runtime sidecar — a Node process — so the executor talks to the local
 * filesystem through Node `fs/promises` directly. The jail + freshness
 * contract (design §4.6/§4.8, R1/R3/R4/R5/R6) moved with it into
 * src/server/tools/fs/NodeFsExecutor.ts; this module is the typed entry
 * point both desktop UI _and_ runtime can import (the desktop UI branch
 * is intentionally unreachable post-cutover — code-mode tools run in the
 * agent, not the WebView).
 */

export interface FileMeta {
  mtimeMs: number; // floored integer ms (== JS Math.floor(mtimeMs))
  size: number;
  endings: 'LF' | 'CRLF';
  encoding: 'utf8';
  bom: boolean;
}

export type ReadOutcome = { contentLf: string } & FileMeta;
export type StatOutcome = { exists: boolean; mtimeMs: number; size: number };
export type EditOutcome =
  | ({ ok: 'true'; newContentLf: string } & FileMeta)
  | { ok: 'false'; reason: string; message: string };
export type WriteOutcome =
  | ({ written: 'true' } & FileMeta)
  | { written: 'false'; reason: string; message: string };

export class FsUnsupportedPlatformError extends Error {
  constructor() {
    super('Code-mode file tools are available on the WorkX desktop app only.');
    this.name = 'FsUnsupportedPlatformError';
  }
}

export class FsTimeoutError extends Error {
  constructor() {
    super('The filesystem operation timed out.');
    this.name = 'FsTimeoutError';
  }
}

/**
 * Hard ceiling on a single fs invoke. Reads are already size-gated (≤5 MB)
 * and edits/writes are bounded by content; this exists so a hung Rust call
 * (a stalled FUSE/network mount, a wedged command) surfaces a clean error
 * instead of blocking the tool handler — and the whole turn — forever. The
 * Rust side is not cancelled (Tauri invoke has no abort); we just stop
 * waiting on it.
 */
const FS_INVOKE_TIMEOUT_MS = 30_000;

function isServer(): boolean {
  return typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'server';
}

/**
 * Wrap a NodeFsExecutor call with the shared 30s ceiling. The Rust path
 * needed this against a hung Tauri invoke; the Node path needs it against
 * a hung filesystem (stalled FUSE/network mount, wedged syscall) — the
 * call is not cancelled (Node has no cross-call abort either), we just
 * stop waiting on it.
 */
async function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FsTimeoutError()), FS_INVOKE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const fsExecutor = {
  async stat(workspaceRoot: string, path: string): Promise<StatOutcome> {
    if (!isServer()) throw new FsUnsupportedPlatformError();
    const node = await import('@/server/tools/fs/NodeFsExecutor');
    return withTimeout(node.stat(workspaceRoot, path));
  },
  async readFile(workspaceRoot: string, path: string): Promise<ReadOutcome> {
    if (!isServer()) throw new FsUnsupportedPlatformError();
    const node = await import('@/server/tools/fs/NodeFsExecutor');
    return withTimeout(node.readFile(workspaceRoot, path));
  },
  async applyEdit(args: {
    workspaceRoot: string;
    path: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    expectedMtimeMs: number;
    expectedContentLf: string;
  }): Promise<EditOutcome> {
    if (!isServer()) throw new FsUnsupportedPlatformError();
    const node = await import('@/server/tools/fs/NodeFsExecutor');
    return withTimeout(node.applyEdit(args));
  },
  async writeIfUnchanged(args: {
    workspaceRoot: string;
    path: string;
    content: string;
    expectedMtimeMs: number | null;
    endings: 'LF' | 'CRLF';
    bom: boolean;
  }): Promise<WriteOutcome> {
    if (!isServer()) throw new FsUnsupportedPlatformError();
    const node = await import('@/server/tools/fs/NodeFsExecutor');
    return withTimeout(node.writeIfUnchanged(args));
  },
};
