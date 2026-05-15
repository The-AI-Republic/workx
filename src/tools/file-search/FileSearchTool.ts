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
import { runRipgrep, isNoMatches, RipgrepTimeoutError, RipgrepNotFoundError, type RipgrepResult } from './ripgrep';

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
      const cwd = await resolveSearchRoot(context, params);
      try {
        const result = await runRipgrep(this.buildArgs(params), { cwd });
        if (result.exitCode === 2 && result.stderr.trim()) {
          return `Search error: ${result.stderr.trim().split('\n').slice(0, 5).join('\n')}`;
        }
        if (isNoMatches(result)) {
          return this.formatResult(result, params); // subclass renders the empty case
        }
        return this.formatResult(result, params);
      } catch (e) {
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
 * Resolve where the search runs. Priority: explicit `path` param → the
 * tool context's cwd → platform project root → process cwd.
 */
async function resolveSearchRoot(
  context: ToolContext,
  params: Record<string, any>
): Promise<string | undefined> {
  const explicit = typeof params.path === 'string' && params.path.trim() ? params.path : undefined;
  if (explicit) return explicit;

  const ctxCwd = context.metadata?.cwd;
  if (typeof ctxCwd === 'string' && ctxCwd.trim()) return ctxCwd;

  const mode = typeof __BUILD_MODE__ !== 'undefined' ? __BUILD_MODE__ : 'extension';
  if (mode === 'desktop') {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<string>('get_project_root');
    } catch {
      return undefined;
    }
  }
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
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
