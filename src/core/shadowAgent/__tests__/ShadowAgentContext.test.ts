import { describe, expect, it } from 'vitest';
import { ShadowAgentKind, ShadowContextPolicy, ShadowFailurePolicy, ShadowAgentPriority } from '../types';
import { buildShadowInitialHistory, responseItemsToRolloutItems } from '../ShadowAgentContext';
import type { ShadowAgentResolvedRequest } from '../types';
import type { ResponseItem } from '@/core/protocol/types';

const user = (text: string): ResponseItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }],
});

describe('ShadowAgentContext', () => {
  it('wraps selected response items as forked initial history', () => {
    const request = makeRequest({
      contextPolicy: ShadowContextPolicy.ParentHistory,
      context: { parentHistory: [user('hello')] },
    });

    const result = buildShadowInitialHistory(request);

    expect(result.parentItemCount).toBe(1);
    expect(result.initialHistory).toMatchObject({
      mode: 'forked',
      sourceConversationId: 'session-1',
    });
    expect(result.initialHistory?.mode).toBe('forked');
    if (result.initialHistory?.mode === 'forked') {
      expect(result.initialHistory.rolloutItems).toEqual(responseItemsToRolloutItems([user('hello')]));
    }
  });

  it('returns no initial history for prompt-only requests', () => {
    const request = makeRequest({
      contextPolicy: ShadowContextPolicy.PromptOnly,
      context: { parentHistory: [user('ignored')] },
    });

    expect(buildShadowInitialHistory(request)).toEqual({ parentItemCount: 0 });
  });
});

function makeRequest(
  overrides: Partial<ShadowAgentResolvedRequest>,
): ShadowAgentResolvedRequest {
  return {
    kind: ShadowAgentKind.Diagnostics,
    prompt: 'prompt',
    systemPrompt: 'system',
    parentEngine: {
      engineId: 'engine-1',
      getSession: () => ({ getSessionId: () => 'session-1', getConversationHistory: () => ({ items: [] }) }),
    } as any,
    contextPolicy: ShadowContextPolicy.ParentHistory,
    toolPolicy: {},
    maxTurns: 1,
    priority: ShadowAgentPriority.Normal,
    queuePolicy: 'queue',
    failurePolicy: ShadowFailurePolicy.ReturnError,
    timeoutMs: 1000,
    profile: {} as any,
    runId: 'run-1',
    ...overrides,
  };
}
