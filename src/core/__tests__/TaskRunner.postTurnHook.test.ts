import { describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../TaskRunner';
import type { ResponseItem } from '../protocol/types';

describe('TaskRunner post-turn hooks', () => {
  it('fires post-turn hooks after the turn delta is committed', async () => {
    const history: ResponseItem[] = [];
    const assistantMessage = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    } as ResponseItem;

    const session = {
      recordConversationItemsDual: vi.fn(async (items: ResponseItem[]) => {
        history.push(...items);
      }),
      firePostTurnHooks: vi.fn(async () => undefined),
      getSessionId: () => 'session-1',
      getConversationHistory: () => ({ items: history }),
    };
    const turnContext = {
      getModelContextWindow: () => 100_000,
      getAutoCompactTokenLimit: () => undefined,
    };
    const turnManager = { cancel: vi.fn() };

    const runner = new TaskRunner(
      session as never,
      turnContext as never,
      turnManager as never,
      'submission-1',
      [],
    );

    await (runner as unknown as {
      processTurnResult: (result: unknown) => Promise<unknown>;
    }).processTurnResult({
      processedItems: [{ item: assistantMessage }],
      totalTokenUsage: { total_tokens: 10, input_tokens: 5, output_tokens: 5 },
      lastTurnHadToolCalls: false,
    });

    expect(session.recordConversationItemsDual).toHaveBeenCalledWith([assistantMessage]);
    expect(session.firePostTurnHooks).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      history: [assistantMessage],
      committedDelta: [assistantMessage],
      lastTurnHadToolCalls: false,
    }));
    expect(
      session.recordConversationItemsDual.mock.invocationCallOrder[0],
    ).toBeLessThan(session.firePostTurnHooks.mock.invocationCallOrder[0]!);
  });
});
