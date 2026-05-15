import { describe, it, expect } from 'vitest';
import { GrepTool } from '../GrepTool';
import type { RipgrepResult } from '../ripgrep';

function rg(stdout: string, exitCode = 0): RipgrepResult {
  return { stdout, stderr: '', exitCode, timedOut: false, source: 'system' };
}

describe('GrepTool', () => {
  const tool = new GrepTool() as any;

  describe('buildArgs', () => {
    it('defaults to files_with_matches (-l) with flood guards', () => {
      const args = tool.buildArgs({ pattern: 'foo' });
      expect(args).toContain('-l');
      expect(args).toContain('--max-columns');
      expect(args).toContain('500');
      expect(args).toContain('--hidden');
      expect(args).toEqual(expect.arrayContaining(['--glob', '!.git']));
      expect(args[args.length - 1]).toBe('foo');
    });

    it('content mode adds -n and context', () => {
      const args = tool.buildArgs({ pattern: 'x', output_mode: 'content', context: 3 });
      expect(args).toContain('-n');
      expect(args).toEqual(expect.arrayContaining(['--context', '3']));
      expect(args).not.toContain('-l');
    });

    it('count mode uses --count', () => {
      expect(tool.buildArgs({ pattern: 'x', output_mode: 'count' })).toContain('--count');
    });

    it('maps case_insensitive, multiline, type, comma globs', () => {
      const args = tool.buildArgs({
        pattern: 'p', case_insensitive: true, multiline: true,
        type: 'ts', glob: '*.ts, src/**/*.tsx',
      });
      expect(args).toContain('-i');
      expect(args).toEqual(expect.arrayContaining(['-U', '--multiline-dotall']));
      expect(args).toEqual(expect.arrayContaining(['--type', 'ts']));
      expect(args).toEqual(expect.arrayContaining(['--glob', '*.ts']));
      expect(args).toEqual(expect.arrayContaining(['--glob', 'src/**/*.tsx']));
    });

    it('guards a pattern starting with dash via -e', () => {
      const args = tool.buildArgs({ pattern: '-foo' });
      expect(args).toEqual(expect.arrayContaining(['-e', '-foo']));
    });
  });

  describe('formatResult', () => {
    it('renders the empty case', () => {
      expect(tool.formatResult(rg('', 1), { pattern: 'x' })).toBe('No matches found.');
    });

    it('headers by mode', () => {
      expect(tool.formatResult(rg('a.ts\nb.ts'), { pattern: 'x' })).toContain('Found 2 file(s)');
      expect(tool.formatResult(rg('1\n2\n3'), { pattern: 'x', output_mode: 'content' })).toContain('3 line(s)');
    });

    it('paginates and reports truncation', () => {
      const lines = Array.from({ length: 300 }, (_, i) => `f${i}.ts`).join('\n');
      const out = tool.formatResult(rg(lines), { pattern: 'x', head_limit: 250, offset: 0 });
      expect(out).toContain('[Truncated to 250 of 300');
      expect(out).toContain('offset=250');
    });

    it('head_limit=0 means unlimited', () => {
      const lines = Array.from({ length: 300 }, (_, i) => `f${i}.ts`).join('\n');
      const out = tool.formatResult(rg(lines), { pattern: 'x', head_limit: 0 });
      expect(out).not.toContain('Truncated');
    });
  });

  it('exposes a tool definition with platforms + read-only risk', () => {
    const def = new GrepTool().toToolDefinition(['desktop']);
    expect(def.type).toBe('function');
    if (def.type === 'function') {
      expect(def.function.name).toBe('grep');
      expect(def.metadata?.platforms).toEqual(['desktop']);
    }
    expect(new GrepTool().riskAssessor.assess('grep', {}).action).toBe('auto_approve');
  });
});
