import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTool, type ExecuteResult } from '../TerminalTool';
import type { ToolContext } from '../../../../tools/BaseTool';

const success: ExecuteResult = {
  success: true,
  exitCode: 0,
  stdout: 'ok',
  stderr: '',
  executionTimeMs: 1,
  sandboxed: false,
};

function context(workingDirectory?: string): ToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'terminal',
    executionContext: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      mode: 'general',
      ...(workingDirectory ? { workspace: { workingDirectory } } : {}),
    },
  };
}

describe('TerminalTool session working directory', () => {
  let tool: TerminalTool;
  let execute: any;

  beforeEach(() => {
    tool = new TerminalTool();
    vi.spyOn(tool.getSandboxManager(), 'reloadConfig').mockResolvedValue(undefined);
    execute = vi.spyOn(tool, 'execute').mockResolvedValue(success);
  });

  it('starts in the session working folder when workdir is omitted', async () => {
    await tool.handleInvocation({ command: 'pwd' }, context('/home/rich'));
    expect(execute).toHaveBeenCalledWith('pwd', expect.objectContaining({ cwd: '/home/rich' }));
  });

  it('requires a selected working folder before executing a command', async () => {
    const result = await tool.handleInvocation({ command: 'pwd' }, context());

    expect(result).toContain('no working folder is available');
    expect(execute).not.toHaveBeenCalled();
  });

  it('resolves a relative workdir from the session working folder', async () => {
    await tool.handleInvocation(
      { command: 'npm test', workdir: 'projects/workx' },
      context('/home/rich'),
    );
    expect(execute).toHaveBeenCalledWith(
      'npm test',
      expect.objectContaining({ cwd: '/home/rich/projects/workx' }),
    );
  });

  it('rejects an absolute per-command workdir', async () => {
    const ctx = context('/home/rich');
    const result = await tool.handleInvocation({ command: 'git status', workdir: '/tmp/other' }, ctx);
    expect(result).toContain('workdir must be relative');
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.executionContext?.workspace?.workingDirectory).toBe('/home/rich');
  });

  it('rejects a relative workdir that escapes the session folder', async () => {
    const result = await tool.handleInvocation(
      { command: 'git status', workdir: '../../tmp/other' },
      context('/home/rich/projects/workx'),
    );
    expect(result).toContain('workdir must stay within');
    expect(execute).not.toHaveBeenCalled();
  });

  it('exposes workdir rather than cwd to the model', () => {
    const definition = tool.getToolDefinition('linux', {
      status: 'unavailable',
      runtime: 'runtime-sidecar',
      os: 'linux',
    });
    const properties = definition.inputSchema.properties;
    expect(properties).toHaveProperty('workdir');
    expect(properties).not.toHaveProperty('cwd');
    expect(definition.description).toContain('not a filesystem security boundary');
  });
});
