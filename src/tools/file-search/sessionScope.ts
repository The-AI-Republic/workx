/**
 * Shared per-session scope for the file/search tools.
 *
 * read/edit/write (FileAccessTool) AND grep/glob (FileSearchTool) must apply
 * the SAME workspace requirement so the root cannot drift between tool
 * families. Mode is intentionally prompt emphasis, not a permission gate.
 */

import type { ToolContext } from '../BaseTool';
import type { FileStateCache } from '../../core/files/FileStateCache';

export interface SessionScope {
  /** Jail anchor; undefined ⇒ no workspace selected (tools disabled, R8). */
  workspaceRoot?: string;
  /** Read-before-edit substrate. Only the file-access tools consume it. */
  cache?: FileStateCache;
}

/** Pull trusted folder context plus the private cache handle from ToolContext. */
export function sessionScope(context: ToolContext): SessionScope {
  const m = context.metadata ?? {};
  const workingDirectory = context.executionContext?.workspace?.workingDirectory;
  return {
    workspaceRoot: workingDirectory?.trim() || undefined,
    cache: (m.fileStateCache as FileStateCache | undefined) ?? undefined,
  };
}

export const NO_WORKSPACE_MSG =
  'No working folder is selected. Choose one above the message input before using file tools.';
