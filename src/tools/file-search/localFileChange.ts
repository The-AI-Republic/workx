import type { ToolContext } from '../BaseTool';
import {
  LOCAL_FILE_DIFF_INPUT_MAX_BYTES,
  LOCAL_FILE_DIFF_MAX_BYTES,
  type LocalFileChangeOperation,
  type LocalFileChangeProgress,
} from '../runtimeMetadata';
import { lexicalPathCheck } from './pathPolicy';

export interface EmitLocalFileChangeInput {
  context: ToolContext;
  workspaceRoot: string;
  path: string;
  before: string;
  after: string;
  operation: LocalFileChangeOperation;
  size: number;
  mtimeMs: number;
}

const textEncoder = new TextEncoder();

export function utf8Size(value: string): number {
  return textEncoder.encode(value).byteLength;
}

export function workspaceRelativeDisplayPath(
  workspaceRoot: string,
  target: string,
): string | null {
  const root = lexicalPathCheck(workspaceRoot, '.');
  const accepted = lexicalPathCheck(workspaceRoot, target);
  if (!root.ok || !accepted.ok) return null;

  const relative = accepted.abs.slice(root.abs.length).replace(/^\/+/, '');
  return relative || null;
}

function messageFor(operation: LocalFileChangeOperation, path: string): string {
  return `${operation === 'created' ? 'Created' : 'Modified'} ${path}`;
}

/**
 * Emit a bounded, best-effort fact after a file mutation has succeeded.
 * Preview work is deliberately unable to alter the mutation's tool result.
 */
export async function emitLocalFileChange(input: EmitLocalFileChangeInput): Promise<void> {
  try {
    const path = workspaceRelativeDisplayPath(input.workspaceRoot, input.path);
    if (!path) {
      console.warn('[local-file-change] Refusing to emit a non-workspace-relative path');
      return;
    }

    const before = input.before.replace(/\r\n/g, '\n');
    const after = input.after.replace(/\r\n/g, '\n');
    if (before === after) return;

    const progress: LocalFileChangeProgress = {
      type: 'local_file_change',
      status: 'completed',
      operation: input.operation,
      path,
      size: input.size,
      mtimeMs: input.mtimeMs,
      message: messageFor(input.operation, path),
    };

    if (utf8Size(before) + utf8Size(after) > LOCAL_FILE_DIFF_INPUT_MAX_BYTES) {
      progress.diffOmittedReason = 'input_too_large';
    } else {
      try {
        const { createTwoFilesPatch } = await import('diff');
        const oldPath = input.operation === 'created' ? '/dev/null' : `a/${path}`;
        const unifiedDiff = createTwoFilesPatch(
          oldPath,
          `b/${path}`,
          before,
          after,
          undefined,
          undefined,
          { context: 3 },
        );
        if (utf8Size(unifiedDiff) <= LOCAL_FILE_DIFF_MAX_BYTES) {
          progress.unifiedDiff = unifiedDiff;
        } else {
          progress.diffOmittedReason = 'diff_too_large';
        }
      } catch (error) {
        progress.diffOmittedReason = 'generation_failed';
        console.warn('[local-file-change] Failed to generate unified diff:', error);
      }
    }

    try {
      input.context.onProgress?.({
        toolUseID:
          input.context.callId
          ?? `${input.context.turnId}:${input.context.toolName}:${path}`,
        data: progress,
      });
    } catch (error) {
      console.warn('[local-file-change] Progress callback failed:', error);
    }
  } catch (error) {
    console.warn('[local-file-change] Preview emission failed:', error);
  }
}
