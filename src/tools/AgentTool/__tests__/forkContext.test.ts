import { describe, expect, it } from 'vitest';
import { AgentType, SubAgentContextMode } from '../agentTypes';
import {
  buildForkedSubAgentInitialHistory,
  containsForkDirective,
} from '../forkContext';

describe('buildForkedSubAgentInitialHistory', () => {
  it('wraps parent history and delegated prompt into forked initial history', () => {
    const parentSession = {
      getSessionId: () => 'parent-session',
      getConversationHistory: () => ({
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Original request' }],
          },
        ],
      }),
    };
    const parentEngine = {
      getSession: () => parentSession,
    } as any;

    const initialHistory = buildForkedSubAgentInitialHistory(
      parentEngine,
      'Investigate this',
      {
        runId: 'run-1',
        typeId: 'worker',
        agentType: AgentType.Worker,
        contextMode: SubAgentContextMode.Fork,
      },
    );

    expect(initialHistory.mode).toBe('forked');
    if (initialHistory.mode !== 'forked') throw new Error('expected forked history');
    expect(initialHistory.sourceConversationId).toBe('parent-session');
    expect(initialHistory.rolloutItems).toHaveLength(2);
    expect(initialHistory.rolloutItems[0]).toMatchObject({
      type: 'response_item',
      payload: { role: 'user' },
    });
    expect(JSON.stringify(initialHistory.rolloutItems[1])).toContain('Investigate this');
  });

  it('drops unpaired tool-call output from forked history', () => {
    const parentSession = {
      getSessionId: () => 'parent-session',
      getConversationHistory: () => ({
        items: [
          {
            type: 'function_call_output',
            call_id: 'orphan',
            output: 'orphan result',
          },
        ],
      }),
    };
    const parentEngine = {
      getSession: () => parentSession,
    } as any;

    const initialHistory = buildForkedSubAgentInitialHistory(parentEngine, 'Do task', {
      runId: 'run-1',
      typeId: 'worker',
      agentType: AgentType.Worker,
      contextMode: SubAgentContextMode.Fork,
    });

    if (initialHistory.mode !== 'forked') throw new Error('expected forked history');
    expect(initialHistory.rolloutItems).toHaveLength(1);
    expect(JSON.stringify(initialHistory.rolloutItems[0])).toContain('Do task');
  });

  it('does not reject based on model-visible fork directive text', () => {
    const parentSession = {
      getSessionId: () => 'parent-session',
      getConversationHistory: () => ({
        items: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<forked-subagent-task>\nNested' }],
          },
        ],
      }),
    };
    const parentEngine = {
      getSession: () => parentSession,
    } as any;

    const initialHistory = buildForkedSubAgentInitialHistory(parentEngine, 'Do task', {
      runId: 'run-1',
      typeId: 'worker',
      agentType: AgentType.Worker,
      contextMode: SubAgentContextMode.Fork,
    });

    expect(initialHistory.mode).toBe('forked');
  });

  it('detects fork directive tags in response items', () => {
    expect(
      containsForkDirective([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '</forked-subagent-task>' }],
        } as any,
      ]),
    ).toBe(true);
    expect(
      containsForkDirective([
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'regular parent history' }],
        } as any,
      ]),
    ).toBe(false);
  });
});
