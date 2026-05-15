/**
 * FileSystemExecutor — the single abstraction over the code-mode fs commands.
 *
 * Sibling of RipgrepExecutor (./ripgrep.ts). Desktop only: the WebView cannot
 * touch the filesystem, so every op is a Rust `invoke`. The Rust side is the
 * AUTHORITATIVE jail + freshness boundary (design §4.6/§4.8, R1/R3/R4/R5/R6);
 * this module is a thin typed transport. Non-desktop builds reject clearly —
 * code mode file tools are desktop-only in v1.
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
    super('Code-mode file tools are available on the Apple Pi desktop app only.');
    this.name = 'FsUnsupportedPlatformError';
  }
}

function isDesktop(): boolean {
  return typeof __BUILD_MODE__ !== 'undefined' && __BUILD_MODE__ === 'desktop';
}

async function invokeFs<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new FsUnsupportedPlatformError();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export const fsExecutor = {
  stat(workspaceRoot: string, path: string): Promise<StatOutcome> {
    return invokeFs<StatOutcome>('fs_stat', { workspaceRoot, path });
  },
  readFile(workspaceRoot: string, path: string): Promise<ReadOutcome> {
    return invokeFs<ReadOutcome>('fs_read_file', { workspaceRoot, path });
  },
  applyEdit(args: {
    workspaceRoot: string;
    path: string;
    oldString: string;
    newString: string;
    replaceAll: boolean;
    expectedMtimeMs: number;
    expectedContentLf: string;
  }): Promise<EditOutcome> {
    return invokeFs<EditOutcome>('fs_apply_edit', {
      workspaceRoot: args.workspaceRoot,
      path: args.path,
      oldString: args.oldString,
      newString: args.newString,
      replaceAll: args.replaceAll,
      expectedMtimeMs: args.expectedMtimeMs,
      expectedContentLf: args.expectedContentLf,
    });
  },
  writeIfUnchanged(args: {
    workspaceRoot: string;
    path: string;
    content: string;
    expectedMtimeMs: number | null;
    endings: 'LF' | 'CRLF';
    bom: boolean;
  }): Promise<WriteOutcome> {
    return invokeFs<WriteOutcome>('fs_write_if_unchanged', {
      workspaceRoot: args.workspaceRoot,
      path: args.path,
      content: args.content,
      expectedMtimeMs: args.expectedMtimeMs,
      endings: args.endings,
      bom: args.bom,
    });
  },
};
