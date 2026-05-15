/**
 * GrepTool — ripgrep content search (the `rg PATTERN` mode).
 *
 * Mirrors claudy's GrepTool semantics: three output modes, context lines,
 * glob/type filters, the always-on context-flood guards (`--max-columns`,
 * VCS-dir excludes), and head_limit/offset pagination.
 */

import type { ParameterProperty } from '../BaseTool';
import { FileSearchTool, paginate } from './FileSearchTool';
import type { RipgrepResult } from './ripgrep';

const VCS_EXCLUDES = ['.git', '.hg', '.svn'];
const DEFAULT_HEAD_LIMIT = 250;
const MAX_COLUMNS = '500';

export class GrepTool extends FileSearchTool {
  readonly name = 'grep';
  readonly description =
    'Search file CONTENTS with a regular expression (ripgrep). Use this to find where text/symbols appear. ' +
    'output_mode: "files_with_matches" (default) lists matching files, "content" shows matching lines, "count" tallies per file. ' +
    'Scope with `path` (a directory) and/or `glob`/`type` filters. Prefer this over running grep in the terminal.';

  readonly parameters: Record<string, ParameterProperty> = {
    pattern: { type: 'string', description: 'Regular expression to search for (ripgrep regex syntax).' },
    path: { type: 'string', description: 'Directory to search in. Defaults to the project root.' },
    glob: { type: 'string', description: 'Glob filter, e.g. "*.ts" or "src/**/*.tsx". Comma-separate multiple.' },
    type: { type: 'string', description: 'ripgrep file type filter, e.g. "ts", "rust", "py".' },
    output_mode: {
      type: 'string',
      enum: ['content', 'files_with_matches', 'count'],
      description: 'Result shape. Default: files_with_matches.',
      default: 'files_with_matches',
    },
    case_insensitive: { type: 'boolean', description: 'Case-insensitive match (-i).', default: false },
    line_numbers: { type: 'boolean', description: 'Show line numbers in content mode (-n).', default: true },
    context: { type: 'number', description: 'Lines of context around each match (content mode, -C).', default: 0 },
    multiline: { type: 'boolean', description: 'Allow patterns to span lines (-U --multiline-dotall).', default: false },
    head_limit: { type: 'number', description: 'Max result lines/files; 0 = unlimited. Default 250.', default: DEFAULT_HEAD_LIMIT },
    offset: { type: 'number', description: 'Skip this many results (pagination with head_limit).', default: 0 },
  };

  readonly required = ['pattern'];

  protected buildArgs(p: Record<string, any>): string[] {
    const mode: string = p.output_mode ?? 'files_with_matches';
    const args: string[] = ['--hidden', '--max-columns', MAX_COLUMNS];
    for (const d of VCS_EXCLUDES) args.push('--glob', `!${d}`);

    if (p.case_insensitive) args.push('-i');
    if (p.multiline) args.push('-U', '--multiline-dotall');
    if (typeof p.type === 'string' && p.type.trim()) args.push('--type', p.type.trim());
    if (typeof p.glob === 'string' && p.glob.trim()) {
      for (const g of p.glob.split(',').map((s: string) => s.trim()).filter(Boolean)) {
        args.push('--glob', g);
      }
    }

    if (mode === 'files_with_matches') {
      args.push('-l');
    } else if (mode === 'count') {
      args.push('--count');
    } else {
      if (p.line_numbers !== false) args.push('-n');
      const ctx = Number(p.context) || 0;
      if (ctx > 0) args.push('--context', String(ctx));
    }

    // Pattern last; `-e` guards patterns that start with '-'.
    const pattern = String(p.pattern ?? '');
    if (pattern.startsWith('-')) args.push('-e', pattern);
    else args.push(pattern);
    return args;
  }

  protected formatResult(result: RipgrepResult, p: Record<string, any>): string {
    const mode: string = p.output_mode ?? 'files_with_matches';
    const raw = result.stdout.split('\n').filter((l) => l.length > 0);
    if (raw.length === 0) return 'No matches found.';

    const headLimit = p.head_limit === undefined ? DEFAULT_HEAD_LIMIT : Number(p.head_limit);
    const offset = Number(p.offset) || 0;
    const { page, truncated } = paginate(raw, headLimit, offset);

    let header: string;
    if (mode === 'files_with_matches') header = `Found ${raw.length} file(s) with matches:`;
    else if (mode === 'count') header = 'Match counts per file:';
    else header = `Matches (${raw.length} line(s)):`;

    let out = `${header}\n${page.join('\n')}`;
    if (truncated) {
      out += `\n\n[Truncated to ${headLimit} of ${raw.length}. Re-run with offset=${offset + headLimit} for more, or narrow the pattern.]`;
    }
    return out;
  }
}
