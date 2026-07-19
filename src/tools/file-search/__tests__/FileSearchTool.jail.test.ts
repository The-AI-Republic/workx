/**
 * grep/glob workspace-jail tests (PR #228 review — CRITICAL fix).
 *
 * Before the fix, resolveSearchRoot returned the model-supplied `path`
 * verbatim and fell back to process.cwd(), so the model could grep/glob
 * anywhere on disk. These pin: mode-independent access, no workspace ⇒
 * disabled (never app cwd), and refusal of out-of-workspace paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runRipgrep } = vi.hoisted(() => ({ runRipgrep: vi.fn() }));
vi.mock('../ripgrep', async (importActual) => {
  const actual = await importActual<typeof import('../ripgrep')>();
  return { ...actual, runRipgrep };
});

import { GrepTool } from '../GrepTool';
import { GlobTool } from '../GlobTool';
import type { ToolContext } from '../../BaseTool';

const WS = '/ws/project';

function ctx(over: Record<string, any> = {}): ToolContext {
  const hasWorkingDirectory = Object.prototype.hasOwnProperty.call(over, 'workingDirectory');
  const workingDirectory = hasWorkingDirectory ? over.workingDirectory : WS;
  const { workingDirectory: _workingDirectory, mode = 'code', ...metadata } = over;
  return {
    sessionId: 's', turnId: 't', toolName: 'grep',
    executionContext: {
      sessionId: 's', turnId: 't', mode,
      ...(workingDirectory ? { workspace: { workingDirectory } } : {}),
    },
    metadata,
  } as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  runRipgrep.mockResolvedValue({ stdout: '', stderr: '', exitCode: 1, timedOut: false, source: 'system' });
});

describe.each([
  ['grep', () => new GrepTool(), { pattern: 'x' }],
  ['glob', () => new GlobTool(), { pattern: '**/*' }],
])('%s is jailed to the workspace', (_name, make, base) => {
  it('refuses when no workspace is selected (R8 — never app cwd)', async () => {
    const out = await make().createHandler()(base, ctx({ workingDirectory: undefined }));
    expect(out).toMatch(/working folder/i);
    expect(runRipgrep).not.toHaveBeenCalled();
  });

  it('runs in general mode', async () => {
    await make().createHandler()(base, ctx({ mode: 'general' }));
    expect(runRipgrep).toHaveBeenCalledTimes(1);
  });

  it('refuses an out-of-workspace path before ripgrep runs', async () => {
    const out = await make().createHandler()({ ...base, path: '/home/user/.ssh' }, ctx());
    expect(out).toMatch(/rejected|outside/i);
    expect(runRipgrep).not.toHaveBeenCalled();
  });

  it('refuses a ../ traversal path', async () => {
    const out = await make().createHandler()({ ...base, path: '../../etc' }, ctx());
    expect(out).toMatch(/rejected|outside/i);
    expect(runRipgrep).not.toHaveBeenCalled();
  });

  it('refuses a blocklisted path (.git)', async () => {
    const out = await make().createHandler()({ ...base, path: '.git' }, ctx());
    expect(out).toMatch(/rejected|blocked/i);
    expect(runRipgrep).not.toHaveBeenCalled();
  });

  it('runs jailed to the workspace root when no path is given', async () => {
    await make().createHandler()(base, ctx());
    expect(runRipgrep).toHaveBeenCalledTimes(1);
    expect(runRipgrep.mock.calls[0][1]).toMatchObject({ cwd: WS, workspaceRoot: WS });
  });

  it('runs jailed to an in-workspace subdir path', async () => {
    await make().createHandler()({ ...base, path: 'src/app' }, ctx());
    expect(runRipgrep).toHaveBeenCalledTimes(1);
    expect(runRipgrep.mock.calls[0][1]).toMatchObject({ cwd: `${WS}/src/app`, workspaceRoot: WS });
  });

  it('mode is not a workspace permission gate', async () => {
    await make().createHandler()(base, ctx({ mode: 'general' }));
    expect(runRipgrep).toHaveBeenCalledTimes(1);
    expect(runRipgrep.mock.calls[0][1]).toMatchObject({ cwd: WS, workspaceRoot: WS });
  });
});
