/**
 * FileSearchTool — shared base for ripgrep-backed, read-only file tools.
 *
 * Gives grep/glob (and future read/edit/write) one shape: declare a name,
 * description, JSON-schema params, an argv builder and a result formatter;
 * the base handles tool-definition assembly, search-root resolution, the
 * RipgrepExecutor call, error mapping, and read-only auto-approval.
 *
 * Tools never touch the platform split or the rg binary — that lives in
 * ./ripgrep.ts. Adding a new ripgrep-backed tool = one subclass.
 */

import { createToolDefinition, type ToolDefinition, type ToolHandler, type ToolContext, type ParameterProperty, type Platform } from '../BaseTool';
import { StaticRiskAssessor } from '../../core/approval/assessors/StaticRiskAssessor';
import { runRipgrep, RipgrepTimeoutError, RipgrepNotFoundError, RipgrepOutsideWorkspaceError, type RipgrepResult } from './ripgrep';
import { sessionScope, NOT_CODE_MODE_MSG, NO_WORKSPACE_MSG } from './sessionScope';
import { lexicalPathCheck } from './pathPolicy';

export abstract class FileSearchTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, ParameterProperty>;
  abstract readonly required: string[];

  /** Build the ripgrep argv from validated tool params. */
  protected abstract buildArgs(params: Record<string, any>): string[];

  /** Shape ripgrep output into the model-facing string. */
  protected abstract formatResult(result: RipgrepResult, params: Record<string, any>): string;

  /** Read-only — always auto-approved (score 0). */
  readonly riskAssessor = new StaticRiskAssessor(0);

  toToolDefinition(platforms: Platform[]): ToolDefinition {
    return createToolDefinition(this.name, this.description, this.parameters, {
      required: this.required,
      category: 'file-search',
      metadata: { platforms, capabilities: ['read'] },
    });
  }

  createHandler(): ToolHandler {
    return async (params: Record<string, any>, context: ToolContext): Promise<string> => {
      const scope = sessionScope(context);
      // Same gates as the file-access tools (sessionScope.ts): grep/glob are
      // code-mode-only (§4.2) and MUST stay jailed to the selected workspace
      // (R5/R8). undefined mode ⇒ session-less path ⇒ don't block on mode;
      // the workspace gate still applies. NEVER fall back to process.cwd()/
      // the app's project root — that was an arbitrary-filesystem read hole.
      if (scope.agentMode !== undefined && scope.agentMode !== 'code') return NOT_CODE_MODE_MSG;
      if (!scope.workspaceRoot) return NO_WORKSPACE_MSG;

      // Resolve the search root strictly inside the workspace. The lexical
      // check here is advisory; the runtime ripgrep wrapper re-jails the
      // workspace with `realpath()` containment (defense in depth — the
      // lexical check cannot resolve symlinks).
      let cwd = scope.workspaceRoot;
      const explicit = typeof params.path === 'string' && params.path.trim() ? String(params.path) : undefined;
      if (explicit) {
        const lex = lexicalPathCheck(scope.workspaceRoot, explicit);
        if (!lex.ok) {
          return lex.reason === 'no_workspace'
            ? NO_WORKSPACE_MSG
            : `Search path rejected (${lex.reason}). It must be inside the workspace and not a protected location.`;
        }
        cwd = lex.abs;
      }

      try {
        const result = await runRipgrep(this.buildArgs(params), { cwd, workspaceRoot: scope.workspaceRoot });
        if (result.exitCode === 2 && result.stderr.trim()) {
          // Make paths workspace-relative (drop the absolute root prefix) and
          // bound the surfaced text — ripgrep stderr otherwise leaks absolute
          // filesystem paths into the model context.
          const cleaned = result.stderr
            .split(scope.workspaceRoot).join('.')
            .split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' / ')
            .slice(0, 400);
          return `Search error: ${cleaned}`;
        }
        // exit 1 + empty stdout (no matches) and exit 0 both render through
        // the subclass; the subclass owns the empty-result wording.
        return this.formatResult(result, params);
      } catch (e) {
        if (e instanceof RipgrepOutsideWorkspaceError) {
          return 'Search path rejected (outside_workspace). It must be inside the workspace and not a protected location.';
        }
        if (e instanceof RipgrepTimeoutError) {
          return 'Search timed out. Narrow the pattern or scope to a specific path.';
        }
        if (e instanceof RipgrepNotFoundError) {
          return e.message;
        }
        throw e;
      }
    };
  }
}

/**
 * Coerce a model-supplied limit. `0` = unlimited (param contract). NaN /
 * negative / non-numeric (e.g. the model sends "abc") falls back to the
 * default — WITHOUT this, Number(x) → NaN flowed into paginate() and
 * silently returned zero results with no truncation note (data loss masked
 * as "no matches"). undefined ⇒ default.
 */
export function coerceLimit(raw: unknown, dflt: number): number {
  if (raw === undefined || raw === null) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
}

/** Coerce a model-supplied offset to a finite, non-negative integer (else 0). */
export function coerceOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Apply head_limit/offset pagination to a list of lines (claudy parity). */
export function paginate(
  lines: string[],
  headLimit: number,
  offset: number
): { page: string[]; truncated: boolean } {
  if (headLimit <= 0) return { page: lines.slice(offset), truncated: false };
  const page = lines.slice(offset, offset + headLimit);
  const truncated = lines.length > offset + headLimit;
  return { page, truncated };
}
