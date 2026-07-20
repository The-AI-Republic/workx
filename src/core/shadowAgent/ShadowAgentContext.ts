import type { ResponseItem } from '@/core/protocol/types';
import type { InitialHistory } from '@/core/session/state/types';
import { pairingTrim } from '@/core/session/rewind';
import type { RolloutItem } from '@/storage/rollout';
import { ShadowContextPolicy, type ShadowAgentResolvedRequest, type ShadowInitialHistoryResult } from './types';
import { v4 as uuidv4 } from 'uuid';

export function responseItemsToRolloutItems(items: ResponseItem[]): RolloutItem[] {
  return items.map((payload) => ({ type: 'response_item', payload }) as RolloutItem);
}

export function buildShadowInitialHistory(
  request: ShadowAgentResolvedRequest,
): ShadowInitialHistoryResult {
  const sourceConversationId =
    request.parentEngine.getSession()?.getSessionId?.() ?? request.parentEngine.engineId;
  const workingDirectory = request.parentEngine.getSession()?.getWorkingDirectory?.();
  const selected = selectHistoryForPolicy(request);

  if (selected.length === 0) {
    return { parentItemCount: 0 };
  }

  const rolloutItems = pairingTrim(responseItemsToRolloutItems(selected));
  if (rolloutItems.length === 0) {
    return { parentItemCount: selected.length };
  }

  const initialHistory: InitialHistory = {
    mode: 'forked',
    sessionId: uuidv4(),
    rolloutItems,
    sourceConversationId,
    ...(workingDirectory
      ? { workspace: { workingDirectory } }
      : {}),
    historyAlreadyPersisted: false,
  };

  return { initialHistory, parentItemCount: selected.length };
}

function selectHistoryForPolicy(request: ShadowAgentResolvedRequest): ResponseItem[] {
  switch (request.contextPolicy) {
    case ShadowContextPolicy.None:
    case ShadowContextPolicy.PromptOnly:
      return [];
    case ShadowContextPolicy.ParentHistory:
      return request.context?.parentHistory ?? currentParentHistory(request);
    case ShadowContextPolicy.ParentHistoryWithSummary:
      return withSummaryHint(
        request.context?.parentHistory ?? currentParentHistory(request),
        request.context?.sessionSummary,
      );
    case ShadowContextPolicy.CompactCandidate:
      return request.context?.compactCandidateHistory
        ?? request.context?.parentHistory
        ?? currentParentHistory(request);
    default:
      return [];
  }
}

function currentParentHistory(request: ShadowAgentResolvedRequest): ResponseItem[] {
  return request.parentEngine.getSession()?.getConversationHistory?.().items ?? [];
}

function withSummaryHint(items: ResponseItem[], summary: string | undefined): ResponseItem[] {
  if (!summary?.trim()) return items;
  return [
    ...items,
    {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: `Current session summary:\n${summary}` }],
    } as ResponseItem,
  ];
}
