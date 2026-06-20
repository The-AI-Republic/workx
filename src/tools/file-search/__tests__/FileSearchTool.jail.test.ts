/**
 * grep/glob workspace-jail tests (PR #228 review — CRITICAL fix).
 *
 * Before the fix, resolveSearchRoot returned the model-supplied `path`
 * verbatim and fell back to process.cwd(), so the model could grep/glob
 * anywhere on disk. These pin: code-mode gate, R8 (no workspace ⇒ disabled,
 * never app cwd), and that an out-of-workspace `path` is refused before
 * ripgrep ever runs.
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
  return {
    sessionId: 's', turnId: 't', toolName: 'grep',
    metadata: { workspaceRoot: WS, agentMode: 'code', ...over },
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
    const out = await make().createHandler()(base, ctx({ workspaceRoot: undefined }));
    expect(out).toMatch(/project folder/i);
    expect(runRipgrep).not.toHaveBeenCalled();
  });

  it('refuses outside code mode', async () => {
    const out = await make().createHandler()(base, ctx({ agentMode: 'general' }));
    expect(out).toMatch(/Code mode only/i);
    expect(runRipgrep).not.toHaveBeenCalled();
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

  it('session-less (undefined mode) is not mode-blocked but still needs a workspace', async () => {
    await make().createHandler()(base, ctx({ agentMode: undefined }));
    expect(runRipgrep).toHaveBeenCalledTimes(1);
    expect(runRipgrep.mock.calls[0][1]).toMatchObject({ cwd: WS, workspaceRoot: WS });
  });
});
