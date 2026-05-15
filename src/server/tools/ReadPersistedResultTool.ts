/**
 * Server-only retrieval tool for tool-result content persisted by
 * FileToolResultStore (track 09).
 *
 * The persisted-output preview message in server mode names a file path on
 * disk. This tool lets the agent fetch the full content of that file. Path
 * validation is strict — symlink-resolved and constrained to live under
 * `{rootDir}/{sessionId}/tool-results/` — so the agent cannot read arbitrary
 * files on the host.
 */

import type { ToolDefinition, ToolContext } from '@/tools/BaseTool';

/**
 * Hard cap on the size of a single retrieval. Persisted files are written by
 * FileToolResultStore with content > the per-tool threshold (default 50 KB) —
 * there's no enforced upper bound at write time, so a buggy / malicious tool
 * could persist arbitrarily large content. This cap keeps a retrieval from
 * blowing up the agent's context window or the server's memory.
 */
export const READ_PERSISTED_RESULT_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export const READ_PERSISTED_RESULT_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_persisted_result',
    description:
      'Read the full content of a tool result that was persisted to disk. ' +
      'Use this when a previous tool result was too large and returned a ' +
      '<persisted-output> block with a file path. Pass the path verbatim ' +
      'from the persisted-output block.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute file path taken verbatim from a <persisted-output> block.',
        },
      },
      required: ['path'],
    },
  },
};

export class ReadPersistedResultTool {
  /**
   * @param rootDir Absolute path to the parent directory under which sessions
   *                live (e.g. `{dataDir}/sessions`). Must match the rootDir
   *                used by FileToolResultStore.
   */
  constructor(private readonly rootDir: string) {}

  getDefinition(): ToolDefinition {
    return READ_PERSISTED_RESULT_TOOL_DEFINITION;
  }

  async execute(
    params: { path?: unknown },
    _context?: ToolContext,
  ): Promise<string> {
    if (typeof params.path !== 'string' || params.path.length === 0) {
      throw new Error('read_persisted_result: "path" must be a non-empty string');
    }
    const requested = params.path;

    const { readFile, realpath, stat } = await import('node:fs/promises');
    const { resolve, sep } = await import('node:path');

    // Resolve the root to a canonical path. The root must exist; if it
    // doesn't, surface that clearly — caller misconfigured the tool.
    let realRoot: string;
    try {
      realRoot = await realpath(this.rootDir);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new Error(
          `read_persisted_result: rootDir does not exist: ${this.rootDir}`,
        );
      }
      throw e;
    }

    // Resolve the requested path. We must realpath() the *target* (after
    // node path-resolution) so that symlinks escaping the root are caught.
    const absRequested = resolve(requested);
    let realTarget: string;
    try {
      realTarget = await realpath(absRequested);
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        throw new Error(
          `read_persisted_result: file not found (may have been cleaned up by the TTL sweep): ${requested}`,
        );
      }
      throw e;
    }

    // Must be strictly under realRoot.
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (!realTarget.startsWith(rootWithSep)) {
      throw new Error(
        `read_persisted_result: path is outside the tool-results root: ${requested}`,
      );
    }

    // Must live under a tool-results/ subdirectory (defense in depth — keeps
    // session-meta or other future per-session files unreadable through this tool).
    if (!realTarget.includes(`${sep}tool-results${sep}`)) {
      throw new Error(
        `read_persisted_result: path is not under a tool-results directory: ${requested}`,
      );
    }

    // Size cap: refuse pathologically large files before reading them into
    // memory. The realistic upper bound is "a bit over a tool's threshold",
    // so 50 MB is a generous ceiling for legitimate retrievals.
    const st = await stat(realTarget);
    if (st.size > READ_PERSISTED_RESULT_MAX_BYTES) {
      throw new Error(
        `read_persisted_result: file is ${st.size} bytes, exceeds the ` +
          `${READ_PERSISTED_RESULT_MAX_BYTES}-byte retrieval cap. Use a more ` +
          `targeted retrieval (e.g., search the file via the appropriate tool).`,
      );
    }

    return readFile(realTarget, 'utf-8');
  }
}
