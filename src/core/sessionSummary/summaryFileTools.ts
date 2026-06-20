/**
 * Per-call pre-execute gate that locks the extractor sub-agent to
 * `file_edit` on the exact summary path. Defence-in-depth on top of the
 * `tools.allow: ['file_edit']` filter that createSubAgentToolRegistry()
 * already applies — even if a future tool-registry refactor accidentally
 * widens the child registry, this gate denies anything else.
 *
 * Installed via `SubAgentToolParams.canUseTool` →
 * `ToolRegistry.setPreExecuteCheck()` on the child registry.
 *
 * Mirrors claudy's createMemoryFileCanUseTool()
 * (services/SessionMemory/sessionMemory.ts:460-482).
 */

import type { PreExecuteCheck, PreExecuteDecision } from '@/tools/ToolRegistry';
import { normalizeSummaryPath } from './filePath';

export const FILE_EDIT_TOOL_NAME = 'file_edit';

// Re-export decision shape so test files don't need a deep import.
export type CanUseToolDecision = PreExecuteDecision;
export type SyncCanUseTool = PreExecuteCheck;

/**
 * Returns a sync gate that:
 *  - Allows only `file_edit`
 *  - Allows it only when the `path` (or `file_path`) input resolves to the
 *    given summary file
 *  - Denies everything else with a human-readable reason
 *
 * Accepts both `path` and `file_path` field names because the FileEditTool
 * input schema has historically used both.
 */
export function createSummaryFileCanUseTool(summaryPath: string): PreExecuteCheck {
  const allowedAbsolute = normalizeSummaryPath(summaryPath);

  return (toolName: string, input: Record<string, unknown>): PreExecuteDecision => {
    if (toolName !== FILE_EDIT_TOOL_NAME) {
      return {
        behavior: 'deny',
        decisionReason: `session summary shadow agent may only call ${FILE_EDIT_TOOL_NAME}; got ${toolName}`,
      };
    }

    const target = extractPath(input);
    if (!target) {
      return {
        behavior: 'deny',
        decisionReason: `${FILE_EDIT_TOOL_NAME} input is missing a path (expected "path" or "file_path")`,
      };
    }

    if (normalizeSummaryPath(target) !== allowedAbsolute) {
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
