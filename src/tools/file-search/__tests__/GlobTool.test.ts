import { describe, it, expect } from 'vitest';
import { GlobTool } from '../GlobTool';
import { isNoMatches, type RipgrepResult } from '../ripgrep';

function rg(stdout: string, exitCode = 0, truncated = false): RipgrepResult {
  return { stdout, stderr: '', exitCode, timedOut: false, truncated, source: 'system' };
}

describe('GlobTool', () => {
  const tool = new GlobTool() as any;

  it('buildArgs is rg --files with no-ignore + sort + pattern glob', () => {
    const args = tool.buildArgs({ pattern: '**/*.ts' });
    expect(args).toContain('--files');
    expect(args).toContain('--no-ignore');
    expect(args).toContain('--sort=modified');
    expect(args).toEqual(expect.arrayContaining(['--glob', '**/*.ts']));
    expect(args).toEqual(expect.arrayContaining(['--glob', '!node_modules']));
  });

  it('formatResult: empty, list, truncation', () => {
    expect(tool.formatResult(rg(''), { pattern: 'x' })).toBe('No files found.');
    expect(tool.formatResult(rg('a.ts\nb.ts'), { pattern: 'x' })).toContain('Found 2 file(s)');

    const many = Array.from({ length: 150 }, (_, i) => `f${i}.ts`).join('\n');
    const out = tool.formatResult(rg(many), { pattern: 'x', limit: 100, offset: 0 });
    expect(out).toContain('[Truncated to 100 of 150');
    expect(out).toContain('offset=100');

    expect(tool.formatResult(rg('a.ts\nb.ts'), { pattern: 'x', offset: 50 })).toBe(
      'No files at offset=50 (total 2). Lower the offset.'
    );

    const capped = tool.formatResult(rg('a.ts\nb.ts', 0, true), { pattern: 'x' });
    expect(capped).toContain('Found 2 file(s)');
    expect(capped).toContain('size cap and is incomplete');
    expect(capped).not.toContain('[output truncated at');
  });

  it('tool definition registers for server with read-only auto-approve', () => {
    const def = new GlobTool().toToolDefinition(['server']);
    if (def.type === 'function') {
      expect(def.function.name).toBe('glob');
      expect(def.metadata?.platforms).toEqual(['server']);
    }
    expect(new GlobTool().riskAssessor.assess('glob', {}).action).toBe('auto_approve');
  });
});

describe('ripgrep helpers', () => {
  it('isNoMatches: exit 1 + empty stdout', () => {
    expect(isNoMatches(rg('', 1))).toBe(true);
    expect(isNoMatches(rg('hit', 1))).toBe(false);
    expect(isNoMatches(rg('', 0))).toBe(false);
    expect(isNoMatches(rg('', 2))).toBe(false);
  });
});
