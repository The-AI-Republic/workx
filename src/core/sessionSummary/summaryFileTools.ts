/**
 * Per-call canUseTool factory that locks the extractor sub-agent to
 * `file_edit` on the exact summary path. Defence-in-depth on top of the
 * `tools.allow: ['file_edit']` filter that createSubAgentToolRegistry()
 * already applies — even if a future tool-registry refactor accidentally
 * widens the child registry, this gate denies anything else.
 *
 * Mirrors claudy's createMemoryFileCanUseTool()
 * (services/SessionMemory/sessionMemory.ts:460-482).
 */

import * as path from 'path';

export const FILE_EDIT_TOOL_NAME = 'file_edit';

export type CanUseToolDecision =
  | { behavior: 'allow' }
  | { behavior: 'deny'; decisionReason: string };

export type CanUseToolFn = (
  toolName: string,
  input: unknown,
) => CanUseToolDecision | Promise<CanUseToolDecision>;

/**
 * Returns a sync canUseTool gate that:
 *  - Allows only `file_edit`
 *  - Allows it only when the `path` (or `file_path`) input resolves to the
 *    given summary file
 *  - Denies everything else with a human-readable reason
 *
 * Accepts both `path` and `file_path` field names because the FileEditTool
 * input schema has historically used both.
 */
export function createSummaryFileCanUseTool(summaryPath: string): CanUseToolFn {
  const allowedAbsolute = path.resolve(summaryPath);

  return (toolName: string, input: unknown): CanUseToolDecision => {
    if (toolName !== FILE_EDIT_TOOL_NAME) {
      return {
        behavior: 'deny',
        decisionReason: `session_summary_extractor may only call ${FILE_EDIT_TOOL_NAME}; got ${toolName}`,
      };
    }

    const target = extractPath(input);
    if (!target) {
      return {
        behavior: 'deny',
        decisionReason: `${FILE_EDIT_TOOL_NAME} input is missing a path (expected "path" or "file_path")`,
      };
    }

    if (path.resolve(target) !== allowedAbsolute) {
      return {
        behavior: 'deny',
        decisionReason: `${FILE_EDIT_TOOL_NAME} restricted to ${allowedAbsolute}; got ${target}`,
      };
    }

    return { behavior: 'allow' };
  };
}

function extractPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const candidates = [obj.path, obj.file_path, obj.filepath];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}
