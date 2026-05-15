/**
 * GlobTool — file discovery by name/path pattern.
 *
 * Like claudy's GlobTool, this is `rg --files --glob PATTERN --sort=modified`
 * (ripgrep's file traversal, not a glob library). It lists FILE PATHS; it
 * does not look inside files (use grep for contents). Unlike grep it runs
 * `--no-ignore` so build output / gitignored files are still discoverable.
 */

import type { ParameterProperty } from '../BaseTool';
import { FileSearchTool, paginate } from './FileSearchTool';
import type { RipgrepResult } from './ripgrep';

const DEFAULT_LIMIT = 100;
const HARD_EXCLUDES = ['.git', 'node_modules'];

export class GlobTool extends FileSearchTool {
  readonly name = 'glob';
  readonly description =
    'Find FILES by name/path pattern (e.g. "**/*.ts", "src/**/*.test.tsx"). Returns matching file paths sorted ' +
    'by modification time. Use this for file discovery; use grep to search file contents. Prefer this over ' +
    'running find/ls in the terminal.';

  readonly parameters: Record<string, ParameterProperty> = {
    pattern: { type: 'string', description: 'File glob, e.g. "**/*.ts" or "src/**/*.svelte".' },
    path: { type: 'string', description: 'Directory to search in. Defaults to the project root.' },
    limit: { type: 'number', description: `Max files to return. Default ${DEFAULT_LIMIT}.`, default: DEFAULT_LIMIT },
    offset: { type: 'number', description: 'Skip this many results (pagination).', default: 0 },
  };

  readonly required = ['pattern'];

  protected buildArgs(p: Record<string, any>): string[] {
    const args: string[] = ['--files', '--hidden', '--no-ignore', '--sort=modified'];
    for (const d of HARD_EXCLUDES) args.push('--glob', `!${d}`);
    const pattern = String(p.pattern ?? '').trim();
    if (pattern) args.push('--glob', pattern);
    return args;
  }

  protected formatResult(result: RipgrepResult, p: Record<string, any>): string {
    const files = result.stdout.split('\n').filter((l) => l.length > 0);
    if (files.length === 0) return 'No files found.';

    const limit = p.limit === undefined ? DEFAULT_LIMIT : Number(p.limit);
    const offset = Number(p.offset) || 0;
    const { page, truncated } = paginate(files, limit, offset);

    let out = `Found ${files.length} file(s):\n${page.join('\n')}`;
    if (truncated) {
      out += `\n\n[Truncated to ${limit} of ${files.length}. Re-run with offset=${offset + limit} or a more specific pattern.]`;
    }
    return out;
  }
}
