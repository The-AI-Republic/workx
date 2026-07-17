import { describe, expect, it, vi } from 'vitest';
import { createPromptLoader, loadUserInstructions } from '@/core/PromptLoader';
import { PromptComposer } from '@/prompts/PromptComposer';

describe('AgentPromptLoader', () => {
  it('composes platform-specific prompts from an immutable context snapshot', async () => {
    const context = {
      os: 'linux',
      arch: 'x86_64',
      shell: 'bash',
      homeDir: '/home/testuser',
      browserConnection: 'mcp' as const,
    };
    const loader = createPromptLoader({
      agentType: 'workx-desktop',
      staticPlatformContext: context,
    });
    context.homeDir = '/mutated';

    const prompt = await loader.load('general');

    expect(prompt).toContain('WorkX');
    expect(prompt).toContain('desktop automation agent');
    expect(prompt).toContain('/home/testuser');
    expect(prompt).not.toContain('/mutated');
    expect(prompt).not.toContain('DOMTool');
  });

  it('keeps extensions and dynamic context isolated between simultaneous agents', async () => {
    const loaderA = createPromptLoader({
      agentType: 'workx',
      staticPlatformContext: { browserConnection: 'extension' },
      dynamicContext: () => ({ planReviewActive: true }),
    });
    const loaderB = createPromptLoader({
      agentType: 'workx-server',
      staticPlatformContext: { cwd: '/srv/workx', browserConnection: 'mcp' },
      dynamicContext: () => ({ planReviewActive: false }),
    });
    loaderA.registerExtension('memory', ({ sessionId }) => `MEMORY:${sessionId}`);

    const [promptA, promptB] = await Promise.all([
      loaderA.load('code', { sessionId: 'session-a' }),
      loaderB.load('general', { sessionId: 'session-b' }),
    ]);

    expect(promptA).toContain('MEMORY:session-a');
    expect(promptB).toContain('WorkX Server');
    expect(promptB).toContain('/srv/workx');
    expect(promptB).not.toContain('MEMORY:session-a');
  });

  it('unregisters only the exact extension registration', async () => {
    const loader = createPromptLoader({ agentType: 'workx' });
    const first = () => 'FIRST';
    const unregisterFirst = loader.registerExtension('memory', first);
    loader.registerExtension('memory', () => 'SECOND');

    unregisterFirst();

    const prompt = await loader.load('general');
    expect(prompt).not.toContain('FIRST');
    expect(prompt).toContain('SECOND');
  });

  it('omits a rejecting async extension without affecting later extensions', async () => {
    const loader = createPromptLoader({ agentType: 'workx' });
    loader.registerExtension('broken', async () => {
      throw new Error('extension failed');
    });
    loader.registerExtension('healthy', async () => 'HEALTHY_EXTENSION');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const prompt = await loader.load('general');

    expect(prompt).toContain('HEALTHY_EXTENSION');
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("extension 'broken' failed"),
      expect.any(Error),
    );
  });

  it('runs extensions concurrently while preserving registration order in the prompt', async () => {
    const loader = createPromptLoader({ agentType: 'workx' });
    const started: string[] = [];
    let releaseFirst!: () => void;
    loader.registerExtension('first', async () => {
      started.push('first');
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return 'FIRST_EXTENSION';
    });
    loader.registerExtension('second', async () => {
      started.push('second');
      return 'SECOND_EXTENSION';
    });

    const load = loader.load('general');
    await vi.waitFor(() => expect(started).toEqual(['first', 'second']));
    releaseFirst();
    const prompt = await load;

    expect(prompt.indexOf('FIRST_EXTENSION')).toBeLessThan(prompt.indexOf('SECOND_EXTENSION'));
  });

  it('falls back to the correct bundled prompt if composition fails', async () => {
    vi.spyOn(PromptComposer.prototype, 'composeMainInstruction').mockImplementation(() => {
      throw new Error('fragment import failed');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loader = createPromptLoader({ agentType: 'workx' });

    const prompt = await loader.load('general');

    expect(prompt).toContain('WorkX');
    expect(prompt).toContain('Core Directive');
    expect(warning).toHaveBeenCalled();
  });

  it('rejects use after disposal and disposal is idempotent', async () => {
    const loader = createPromptLoader({ agentType: 'workx' });
    loader.registerExtension('memory', () => 'MEMORY');

    loader.dispose();
    loader.dispose();

    await expect(loader.load('general')).rejects.toThrow('disposed');
    expect(() => loader.registerExtension('late', () => 'LATE')).toThrow('disposed');
  });

  it('reports supported modes and loads bundled user instructions', async () => {
    const loader = createPromptLoader({ agentType: 'workx' });

    expect(loader.supportsMode('general')).toBe(true);
    expect(loader.supportsMode('code')).toBe(true);
    expect(loader.supportsMode('not-a-mode' as never)).toBe(false);
    await expect(loadUserInstructions()).resolves.toEqual(expect.any(String));
  });
});
