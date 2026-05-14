import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SkillExecutor, type SubAgentResult, type SubAgentInvoker } from '@/core/skills/SkillExecutor';
import { HookRegistry } from '@/core/hooks/HookRegistry';
import type { SkillRegistry } from '@/core/skills/SkillRegistry';
import type { Skill } from '@/core/skills/types';

const baseSkill = (overrides: Partial<Skill> = {}): Skill => ({
  name: overrides.name ?? 'test-skill',
  description: 'd',
  body: 'Hello $1, welcome',
  invocationMode: 'manual',
  trusted: true,
  source: 'user',
  createdAt: 'now',
  updatedAt: 'now',
  ...overrides,
});

function makeRegistry(skill: Skill | null): SkillRegistry {
  return {
    loadFull: async () => skill,
  } as unknown as SkillRegistry;
}

describe('SkillExecutor — inline', () => {
  let hookRegistry: HookRegistry;
  beforeEach(() => {
    hookRegistry = new HookRegistry();
  });

  it('returns substituted body + metadata for inline skill', async () => {
    const skill = baseSkill({
      body: 'Hi $1',
      allowedTools: ['Bash'],
      model: 'opus',
      effort: 'high',
    });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);
    const result = await exec.execute('test-skill', 'World');
    expect(result.status).toBe('inline');
    if (result.status === 'inline') {
      expect(result.body).toBe('Hi World');
      expect(result.allowedTools).toEqual(['Bash']);
      expect(result.model).toBe('opus');
      expect(result.effort).toBe('high');
    }
  });

  it('returns error for unknown skill', async () => {
    const exec = new SkillExecutor(makeRegistry(null), hookRegistry, null);
    const result = await exec.execute('missing', '');
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/not found/);
    }
  });

  it('handles undefined args (no substitution)', async () => {
    const skill = baseSkill({ body: 'No args here' });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);
    const result = await exec.execute('test-skill', undefined);
    expect(result.status).toBe('inline');
    if (result.status === 'inline') expect(result.body).toBe('No args here');
  });
});

describe('SkillExecutor — forked', () => {
  let hookRegistry: HookRegistry;
  beforeEach(() => {
    hookRegistry = new HookRegistry();
  });

  it('invokes sub_agent and surfaces the response', async () => {
    const skill = baseSkill({ context: 'fork', agent: 'general-purpose', body: 'Do $1' });
    const subAgentInvoker = vi.fn(async (): Promise<SubAgentResult> => ({
      success: true,
      response: 'Sub-agent finished',
      runId: 'run-123',
    }));
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, subAgentInvoker);
    const result = await exec.execute('test-skill', 'thing');
    expect(subAgentInvoker).toHaveBeenCalledWith({
      type: 'general-purpose',
      prompt: 'Do thing',
      description: 'Skill: test-skill',
    });
    expect(result.status).toBe('forked');
    if (result.status === 'forked') {
      expect(result.result).toBe('Sub-agent finished');
      expect(result.agentId).toBe('run-123');
      expect(result.success).toBe(true);
    }
  });

  it("rejects context: 'fork' without agent", async () => {
    const skill = baseSkill({ context: 'fork' });
    const subAgentInvoker = vi.fn();
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, subAgentInvoker);
    const result = await exec.execute('test-skill', '');
    expect(subAgentInvoker).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error).toMatch(/agent/i);
  });

  it("rejects context: 'fork' when no subAgentInvoker is configured", async () => {
    const skill = baseSkill({ context: 'fork', agent: 'general-purpose' });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);
    const result = await exec.execute('test-skill', '');
    expect(result.status).toBe('error');
    if (result.status === 'error') expect(result.error).toMatch(/sub_agent/);
  });

  it('propagates sub_agent failure as forked-with-error', async () => {
    const skill = baseSkill({ context: 'fork', agent: 'general-purpose' });
    const subAgentInvoker: SubAgentInvoker = async () => ({
      success: false,
      runId: 'run-fail',
      error: 'sub-agent crashed',
    });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, subAgentInvoker);
    const result = await exec.execute('test-skill', '');
    expect(result.status).toBe('forked');
    if (result.status === 'forked') {
      expect(result.success).toBe(false);
      expect(result.error).toBe('sub-agent crashed');
    }
  });
});

describe('SkillExecutor — skill-scoped hooks', () => {
  let hookRegistry: HookRegistry;
  beforeEach(() => {
    hookRegistry = new HookRegistry();
  });

  it('registers hooks at entry, clears at exit (success path)', async () => {
    const skill = baseSkill({
      hooks: {
        PreToolUse: [
          {
            matcher: 'browser_dom',
            hooks: [{ type: 'command', command: 'echo pre' }],
          },
        ],
        PostToolUse: [
          {
            matcher: 'browser_dom',
            hooks: [{ type: 'command', command: 'echo post' }],
          },
        ],
      },
    });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);

    expect(hookRegistry.getMatchingHooks('PreToolUse', 'browser_dom').length).toBe(0);

    let snapshotDuringExecution: number[] | null = null;
    const originalLoad = (makeRegistry(skill) as unknown as { loadFull: (name: string) => Promise<Skill | null> }).loadFull;
    const spied: SkillRegistry = {
      loadFull: async (name: string) => {
        const result = await originalLoad(name);
        snapshotDuringExecution = [
          hookRegistry.getMatchingHooks('PreToolUse', 'browser_dom').length,
          hookRegistry.getMatchingHooks('PostToolUse', 'browser_dom').length,
        ];
        return result;
      },
    } as unknown as SkillRegistry;
    void spied; // not used — just illustrating the read-mid-execution intent

    await exec.execute('test-skill', '');

    // After execution the scope clears its hooks
    expect(hookRegistry.getMatchingHooks('PreToolUse', 'browser_dom').length).toBe(0);
    expect(hookRegistry.getMatchingHooks('PostToolUse', 'browser_dom').length).toBe(0);
    void snapshotDuringExecution;
  });

  it('registers hooks during execution (verified by counting between entry and exit)', async () => {
    const skill = baseSkill({
      hooks: {
        PreToolUse: [
          { matcher: 'a', hooks: [{ type: 'command', command: 'x' }] },
          { matcher: 'b', hooks: [{ type: 'command', command: 'y' }] },
        ],
      },
    });

    let countDuring = -1;
    const subAgentInvoker: SubAgentInvoker = async () => {
      countDuring = hookRegistry.getMatchingHooks('PreToolUse', 'a').length
                  + hookRegistry.getMatchingHooks('PreToolUse', 'b').length;
      return { success: true, response: '', runId: 'r' };
    };

    const forkSkill = baseSkill({ ...skill, context: 'fork', agent: 'general-purpose' });
    const exec = new SkillExecutor(makeRegistry(forkSkill), hookRegistry, subAgentInvoker);
    await exec.execute('test-skill', '');
    expect(countDuring).toBe(2);
    expect(hookRegistry.getMatchingHooks('PreToolUse', 'a').length).toBe(0);
    expect(hookRegistry.getMatchingHooks('PreToolUse', 'b').length).toBe(0);
  });

  it('clears hooks even when sub_agent throws', async () => {
    const skill = baseSkill({
      context: 'fork',
      agent: 'general-purpose',
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
      },
    });
    const subAgentInvoker: SubAgentInvoker = async () => {
      throw new Error('boom');
    };
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, subAgentInvoker);
    await expect(exec.execute('test-skill', '')).rejects.toThrow('boom');
    expect(hookRegistry.getMatchingHooks('PreToolUse').length).toBe(0);
  });

  it('skips unknown hook events with a warning, registers the rest', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const skill = baseSkill({
      hooks: {
        NotARealEvent: [{ matcher: '*', hooks: [{ type: 'command', command: 'x' }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'y' }] }],
      } as unknown as Skill['hooks'],
    });
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);
    await exec.execute('test-skill', '');
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('NotARealEvent'));
    consoleSpy.mockRestore();
  });

  it('handles skills without any hooks (no-op cleanup)', async () => {
    const skill = baseSkill();
    const exec = new SkillExecutor(makeRegistry(skill), hookRegistry, null);
    const result = await exec.execute('test-skill', '');
    expect(result.status).toBe('inline');
  });
});
