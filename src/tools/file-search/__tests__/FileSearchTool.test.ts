import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock only runRipgrep. Keep the real error classes — FileSearchTool maps
// errors with `instanceof`, so those references must stay identical.
vi.mock('../ripgrep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ripgrep')>();
  return { ...actual, runRipgrep: vi.fn() };
});

import { FileSearchTool, paginate } from '../FileSearchTool';
import {
  runRipgrep,
  RipgrepTimeoutError,
  RipgrepNotFoundError,
  type RipgrepResult,
} from '../ripgrep';
import type { ParameterProperty } from '../../BaseTool';

const mockedRun = vi.mocked(runRipgrep);
const params: Record<string, ParameterProperty> = { pattern: { type: 'string', description: 'p' } };
const ctx = (): any => ({ sessionId: 's', turnId: 't', toolName: 'probe' });

/** Drives the resolved-value branches via the mocked runRipgrep. */
class ProbeTool extends FileSearchTool {
  readonly name = 'probe';
  readonly description = 'probe';
  readonly parameters = params;
  readonly required = ['pattern'];
  protected buildArgs(): string[] {
    return ['x'];
  }
  protected formatResult(r: RipgrepResult): string {
    return `OK:${r.stdout}`;
  }
}

/**
 * `buildArgs` is evaluated inside createHandler's try block (it's an
 * argument to runRipgrep), so a tool whose buildArgs throws exercises the
 * exact same error-mapping catch — without an async mock (and the spurious
 * unhandled-rejection a rejecting mock triggers in vitest).
 */
class ThrowingTool extends FileSearchTool {
  constructor(private readonly err: Error) {
    super();
  }
  readonly name = 'throwing';
  readonly description = 'throwing';
  readonly parameters = params;
  readonly required = ['pattern'];
  protected buildArgs(): string[] {
    throw this.err;
  }
  protected formatResult(): string {
    return 'unused';
  }
}

describe('FileSearchTool.createHandler error mapping', () => {
  beforeEach(() => mockedRun.mockReset());

  it('maps exit 2 + stderr to a Search error (capped at 5 lines)', async () => {
    mockedRun.mockResolvedValue({
      stdout: '', stderr: 'regex parse error\nl2\nl3\nl4\nl5\nl6', exitCode: 2, timedOut: false, truncated: false, source: 'system',
    });
    const out = await new ProbeTool().createHandler()({ pattern: 'x' }, ctx());
    expect(out).toMatch(/^Search error: regex parse error/);
    expect(out).not.toContain('l6');
  });

  it('maps a timeout to a narrow-scope hint', async () => {
    const out = await new ThrowingTool(new RipgrepTimeoutError(20_000)).createHandler()({ pattern: 'x' }, ctx());
    expect(out).toMatch(/timed out/i);
  });

  it('maps not-found to its install message', async () => {
    const out = await new ThrowingTool(new RipgrepNotFoundError()).createHandler()({ pattern: 'x' }, ctx());
    expect(out).toMatch(/ripgrep \(rg\) was not found/);
  });

  it('rethrows unexpected errors', async () => {
    const handler = new ThrowingTool(new Error('boom')).createHandler();
    await expect(handler({ pattern: 'x' }, ctx())).rejects.toThrow('boom');
  });

  it('formats a normal result via the subclass', async () => {
    mockedRun.mockResolvedValue({ stdout: 'hit', stderr: '', exitCode: 0, timedOut: false, truncated: false, source: 'system' });
    expect(await new ProbeTool().createHandler()({ pattern: 'x' }, ctx())).toBe('OK:hit');
  });

  it('exit 2 with blank stderr falls through to formatResult (not an error)', async () => {
    mockedRun.mockResolvedValue({ stdout: '', stderr: '   ', exitCode: 2, timedOut: false, truncated: false, source: 'system' });
    expect(await new ProbeTool().createHandler()({ pattern: 'x' }, ctx())).toBe('OK:');
  });

  it('no-matches (exit 1, empty stdout) renders the subclass empty case', async () => {
    mockedRun.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1, timedOut: false, truncated: false, source: 'system' });
    expect(await new ProbeTool().createHandler()({ pattern: 'x' }, ctx())).toBe('OK:');
  });
});

describe('paginate', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `l${i}`);

  it('headLimit<=0 returns everything from offset, never truncated', () => {
    expect(paginate(lines, 0, 0)).toEqual({ page: lines, truncated: false });
    expect(paginate(lines, 0, 3).page).toEqual(lines.slice(3));
  });

  it('paginates a window and flags truncation', () => {
    expect(paginate(lines, 4, 0)).toEqual({ page: ['l0', 'l1', 'l2', 'l3'], truncated: true });
  });

  it('the last exact page is not flagged truncated', () => {
    expect(paginate(lines, 5, 5)).toEqual({
      page: ['l5', 'l6', 'l7', 'l8', 'l9'],
      truncated: false,
    });
  });

  it('offset past the end yields an empty page, not truncated', () => {
    expect(paginate(lines, 5, 50)).toEqual({ page: [], truncated: false });
  });
});
