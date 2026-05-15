/**
 * Code-mode file tools: read_file / edit_file / write_file.
 *
 * Sibling of FileSearchTool (grep/glob). The freshness gate + jail live in
 * Rust (fsExecutor → tauri/src/fs_commands.rs); this layer resolves the
 * per-session workspace + FileStateCache from ToolContext.metadata (the §4.5
 * seam), runs the advisory pre-check, and shapes results.
 *
 * Invariants (design §6): R2 (offset discriminator, isPartialView gate),
 * R4 (JS pre-check advisory; Rust authoritative), R7 (read never persisted,
 * size-gated), R8 (no workspace ⇒ disabled). Absent cache/workspace (the
 * session-less tools/index.ts path) ⇒ degrade gracefully, never throw.
 */

import { createToolDefinition, type ToolDefinition, type ToolHandler, type ToolContext, type ParameterProperty, type Platform } from '../BaseTool';
import { StaticRiskAssessor } from '../../core/approval/assessors/StaticRiskAssessor';
import { FileWriteRiskAssessor } from '../../core/approval/assessors/FileWriteRiskAssessor';
import type { IRiskAssessor } from '../../core/approval/types';
import type { FileStateCache, FileState } from '../../core/files/FileStateCache';
import { fsExecutor, FsUnsupportedPlatformError } from './fsExecutor';
import { lexicalPathCheck } from './pathPolicy';

const MAX_READ_BYTES = 5 * 1024 * 1024; // pre-read hard reject (design §4.7)
const MAX_OUT_LINES = 2000;
const MAX_OUT_BYTES = 256 * 1024;

interface SessionHandles {
  workspaceRoot?: string;
  cache?: FileStateCache;
  /** Per-session persona mode (§4.2). Undefined on the session-less path. */
  agentMode?: string;
}

/** Pull the §4.5-seam handles out of ToolContext.metadata (any may be absent). */
function handles(context: ToolContext): SessionHandles {
  const m = context.metadata ?? {};
  return {
    workspaceRoot: typeof m.workspaceRoot === 'string' && m.workspaceRoot.trim() ? m.workspaceRoot : undefined,
    cache: (m.fileStateCache as FileStateCache | undefined) ?? undefined,
    agentMode: typeof m.agentMode === 'string' ? m.agentMode : undefined,
  };
}

const NOT_CODE_MODE_MSG =
  'The file tools are available in Code mode only. Switch this session to Code mode to read/edit/write project files.';

const NO_WORKSPACE_MSG =
  'No project folder is selected. Code-mode file tools are disabled until you choose a workspace folder in Apple Pi settings.';

abstract class FileAccessTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, ParameterProperty>;
  abstract readonly required: string[];
  abstract readonly riskAssessor: IRiskAssessor;
  protected abstract run(params: Record<string, any>, h: Required<Pick<SessionHandles, 'workspaceRoot'>> & SessionHandles): Promise<string>;

  toToolDefinition(platforms: Platform[]): ToolDefinition {
    return createToolDefinition(this.name, this.description, this.parameters, {
      required: this.required,
      category: 'file-access',
      metadata: { platforms },
    });
  }

  createHandler(): ToolHandler {
    return async (params: Record<string, any>, context: ToolContext): Promise<string> => {
      const h = handles(context);
      // §4.2: code-mode only. Gate by behavior, not registry mutation
      // (consistent with the modes design). Undefined mode ⇒ session-less
      // path ⇒ don't block on mode (workspace gate still applies).
      if (h.agentMode !== undefined && h.agentMode !== 'code') return NOT_CODE_MODE_MSG;
      if (!h.workspaceRoot) return NO_WORKSPACE_MSG; // R8 — never default to app cwd
      const lex = lexicalPathCheck(h.workspaceRoot, String(params.path ?? ''));
      if (!lex.ok) {
        return lex.reason === 'no_workspace' ? NO_WORKSPACE_MSG
          : `Path rejected (${lex.reason}). It must be inside the workspace and not a protected location.`;
      }
      try {
        return await this.run(params, { ...h, workspaceRoot: h.workspaceRoot });
      } catch (e) {
        if (e instanceof FsUnsupportedPlatformError) return e.message;
        throw e;
      }
    };
  }
}

// ── read_file ───────────────────────────────────────────────────────────────

export class ReadFileTool extends FileAccessTool {
  readonly name = 'read_file';
  readonly description =
    'Read a text file from the workspace. Returns cat -n line-numbered content. ' +
    'You MUST read a file before editing it. Large files are size-gated; output is capped.';
  readonly parameters: Record<string, ParameterProperty> = {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
  };
  readonly required = ['path'];
  readonly riskAssessor = new StaticRiskAssessor(0); // read-only, auto-approve

  protected async run(params: Record<string, any>, h: SessionHandles & { workspaceRoot: string }): Promise<string> {
    const path = String(params.path);
    const st = await fsExecutor.stat(h.workspaceRoot, path);
    if (!st.exists) return `File not found: ${path}`;
    if (st.size > MAX_READ_BYTES) {
      return `File too large to read (${Math.round(st.size / 1024)} KB > ${MAX_READ_BYTES / 1024} KB cap). Use grep to locate the relevant region.`;
    }
    const r = await fsExecutor.readFile(h.workspaceRoot, path);

    // Populate the freshness cache: Read entry ⇒ offset SET (R2).
    if (h.cache) {
      const entry: FileState = { content: r.contentLf, mtimeFloorMs: r.mtimeMs, offset: 1, limit: undefined };
      h.cache.set(absKey(h.workspaceRoot, path), entry);
    }

    let lines = r.contentLf.split('\n');
    let truncatedNote = '';
    if (lines.length > MAX_OUT_LINES) {
      lines = lines.slice(0, MAX_OUT_LINES);
      truncatedNote = `\n… [truncated to ${MAX_OUT_LINES} lines; use grep to find specific content]`;
    }
    let body = lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
    if (body.length > MAX_OUT_BYTES) {
      body = body.slice(0, MAX_OUT_BYTES);
      truncatedNote = `\n… [truncated to ${MAX_OUT_BYTES / 1024} KB]`;
    }
    return body + truncatedNote;
  }
}

// ── edit_file ───────────────────────────────────────────────────────────────

export class EditFileTool extends FileAccessTool {
  readonly name = 'edit_file';
  readonly description =
    'Replace an exact substring in a workspace file. old_string must match the current file ' +
    'content exactly and uniquely (or set replace_all). Empty old_string creates a new file. ' +
    'You must read_file first (except when creating). On stale/no_match/not_unique: re-read, ' +
    'widen old_string, or set replace_all — do not retry the identical edit.';
  readonly parameters: Record<string, ParameterProperty> = {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
    old_string: { type: 'string', description: 'Exact text to replace. Empty ⇒ create a new file with new_string.' },
    new_string: { type: 'string', description: 'Replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence (default false ⇒ must be unique).', default: false },
  };
  readonly required = ['path', 'old_string', 'new_string'];
  readonly riskAssessor = new FileWriteRiskAssessor();

  protected async run(params: Record<string, any>, h: SessionHandles & { workspaceRoot: string }): Promise<string> {
    const path = String(params.path);
    const oldString = String(params.old_string ?? '');
    const newString = String(params.new_string ?? '');
    const replaceAll = params.replace_all === true;
    const key = absKey(h.workspaceRoot, path);
    const entry = h.cache?.get(key);

    // Advisory pre-check (R4: authoritative gate is the Rust command).
    if (oldString.length > 0) {
      if (!entry) return `Read the file first: call read_file("${path}") before editing it.`;
      if (entry.isPartialView) return `The cached view of "${path}" is partial. read_file it (fully) before editing.`;
    }

    const res = await fsExecutor.applyEdit({
      workspaceRoot: h.workspaceRoot,
      path,
      oldString,
      newString,
      replaceAll,
      expectedMtimeMs: entry?.mtimeFloorMs ?? 0,
      expectedContentLf: entry?.content ?? '',
    });

    if (res.ok === 'false') return `Edit not applied (${res.reason}): ${res.message}`;

    // Edit entry ⇒ offset undefined (R2): chainable, dedup-immune.
    h.cache?.set(key, { content: res.newContentLf, mtimeFloorMs: res.mtimeMs, offset: undefined, limit: undefined });
    return `Edited ${path} (${replaceAll ? 'all occurrences' : '1 occurrence'}).`;
  }
}

// ── write_file ──────────────────────────────────────────────────────────────

export class WriteFileTool extends FileAccessTool {
  readonly name = 'write_file';
  readonly description =
    'Create a new file, or fully overwrite an existing one, in the workspace. ' +
    'Overwriting an existing file requires a prior read_file of it.';
  readonly parameters: Record<string, ParameterProperty> = {
    path: { type: 'string', description: 'File path, absolute or relative to the workspace root.' },
    content: { type: 'string', description: 'Full file contents to write.' },
  };
  readonly required = ['path', 'content'];
  readonly riskAssessor = new FileWriteRiskAssessor();

  protected async run(params: Record<string, any>, h: SessionHandles & { workspaceRoot: string }): Promise<string> {
    const path = String(params.path);
    const content = String(params.content ?? '');
    const key = absKey(h.workspaceRoot, path);
    const st = await fsExecutor.stat(h.workspaceRoot, path);
    const entry = h.cache?.get(key);

    if (st.exists) {
      if (!entry || entry.isPartialView) {
        return `"${path}" exists. read_file it before overwriting with write_file.`;
      }
    }
    const res = await fsExecutor.writeIfUnchanged({
      workspaceRoot: h.workspaceRoot,
      path,
      content,
      expectedMtimeMs: st.exists ? (entry?.mtimeFloorMs ?? 0) : null,
      endings: 'LF',
      bom: false,
    });
    if (res.written === 'false') return `Write not applied (${res.reason}): ${res.message}`;

    h.cache?.set(key, { content: content.replace(/\r\n/g, '\n'), mtimeFloorMs: res.mtimeMs, offset: undefined, limit: undefined });
    return `${st.exists ? 'Overwrote' : 'Created'} ${path}.`;
  }
}

/** Cache key: absolute, lexically normalized (matches FileStateCache keying). */
function absKey(workspaceRoot: string, p: string): string {
  const isAbs = /^([a-zA-Z]:[\\/]|[\\/])/.test(p);
  return isAbs ? p : `${workspaceRoot}/${p}`;
}
