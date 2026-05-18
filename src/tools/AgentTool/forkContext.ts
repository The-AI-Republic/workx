// File: src/tools/AgentTool/forkContext.ts

import type { RepublicAgentEngine } from '@/core/engine/RepublicAgentEngine';
import type { InitialHistory } from '@/core/session/state/types';
import { pairingTrim } from '@/core/session/rewind';
import type { ResponseItem } from '@/core/protocol/types';
import type { RolloutItem } from '@/storage/rollout/types';
import type { AgentType, SubAgentContextMode } from './agentTypes';

export interface ForkContextMetadata {
  runId: string;
  typeId: string;
  agentType: AgentType;
  contextMode: SubAgentContextMode;
}

export const FORK_DIRECTIVE_OPEN_TAG = '<forked-subagent-task>';
export const FORK_DIRECTIVE_CLOSE_TAG = '</forked-subagent-task>';

export function buildForkedSubAgentInitialHistory(
  parentEngine: RepublicAgentEngine,
  prompt: string,
  metadata: ForkContextMetadata,
): InitialHistory {
  const parentSession = parentEngine.getSession();
  if (!parentSession) {
    throw new Error('Cannot build forked sub-agent context before parent session is initialized');
  }

  const sourceItems = parentSession.getConversationHistory().items as ResponseItem[];
  if (containsForkDirective(sourceItems)) {
    throw new Error(
      'Cannot create a forked sub-agent from history that already contains forked sub-agent context',
    );
  }

  const rolloutItems = responseItemsToRolloutItems(sourceItems);
  const trimmed = pairingTrim(rolloutItems);

  return {
    mode: 'forked',
    sourceConversationId: parentSession.getSessionId(),
    rolloutItems: [
      ...trimmed,
      {
        type: 'response_item',
        payload: buildForkDirectiveMessage(prompt, metadata),
      },
    ],
  };
}

export function responseItemsToRolloutItems(items: ResponseItem[]): RolloutItem[] {
  return items.map((item) => ({
    type: 'response_item',
    payload: item,
  }));
}

export function containsForkDirective(items: ResponseItem[]): boolean {
  return items.some((item) => {
    const serialized = JSON.stringify(item);
    return (
      serialized.includes(FORK_DIRECTIVE_OPEN_TAG) ||
      serialized.includes(FORK_DIRECTIVE_CLOSE_TAG)
    );
  });
}

function buildForkDirectiveMessage(
  prompt: string,
  metadata: ForkContextMetadata,
): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: [
          FORK_DIRECTIVE_OPEN_TAG,
          `You are a delegated forked subagent for type '${metadata.typeId}' (${metadata.agentType}).`,
          'Use the inherited conversation only to complete the delegated task below.',
          'Do not assume control of the main conversation. Return one final result to the parent.',
          '',
          prompt,
          FORK_DIRECTIVE_CLOSE_TAG,
        ].join('\n'),
      },
    ],
  } as ResponseItem;
}
