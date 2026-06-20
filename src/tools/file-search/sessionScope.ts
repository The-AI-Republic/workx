/**
 * Shared per-session scope for the code-mode file/search tools.
 *
 * read/edit/write (FileAccessTool) AND grep/glob (FileSearchTool) must apply
 * the SAME gates — code-mode only (§4.2), workspace required (R8) — so the
 * jail anchor is identical and cannot drift between the two tool families.
 * This is the single place that reads the §4.5 metadata seam.
 */

import type { ToolContext } from '../BaseTool';
import type { FileStateCache } from '../../core/files/FileStateCache';

export interface SessionScope {
  /** Jail anchor; undefined ⇒ no workspace selected (tools disabled, R8). */
  workspaceRoot?: string;
  /** Read-before-edit substrate. Only the file-access tools consume it. */
  cache?: FileStateCache;
  /** Per-session persona mode (§4.2). Undefined ⇒ session-less path. */
  agentMode?: string;
}

/** Pull the §4.5-seam handles out of ToolContext.metadata (any may be absent). */
export function sessionScope(context: ToolContext): SessionScope {
  const m = context.metadata ?? {};
  return {
    workspaceRoot: typeof m.workspaceRoot === 'string' && m.workspaceRoot.trim() ? m.workspaceRoot : undefined,
    cache: (m.fileStateCache as FileStateCache | undefined) ?? undefined,
    agentMode: typeof m.agentMode === 'string' ? m.agentMode : undefined,
  };
}

export const NOT_CODE_MODE_MSG =
  'The file tools are available in Code mode only. Switch this session to Code mode to read/edit/write project files.';

export const NO_WORKSPACE_MSG =
  'No project folder is selected. Code-mode file tools are disabled until you choose a workspace folder in WorkX settings.';
