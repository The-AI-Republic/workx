/**
 * `SubAgentTypeConfig` for the internal session-summary extractor.
 *
 * Registered with a dedicated `SubAgentRegistry` owned by `SessionSummaryHook`
 * (not the shared user-facing registry). This way the extractor never steals
 * a concurrency slot from a user-spawned sub-agent.
 */

import type { SubAgentTypeConfig } from '@/tools/AgentTool/types';
import { SESSION_SUMMARY_EXTRACTION_PROMPT } from './prompts';

export const SESSION_SUMMARY_EXTRACTOR_TYPE_ID = 'session_summary_extractor';

export const SESSION_SUMMARY_EXTRACTOR_TYPE: SubAgentTypeConfig = {
  id: SESSION_SUMMARY_EXTRACTOR_TYPE_ID,
  name: 'Session Summary Extractor',
  description:
    'Internal extractor that distills the current session into summary.md. Not user-callable.',
  systemPrompt: SESSION_SUMMARY_EXTRACTION_PROMPT,
  tools: { allow: ['file_edit'] },
  approvalPolicy: 'never',
  maxTurns: 4,
  // Suppress noisy streaming events; the hook never surfaces extractor output.
  suppressedEvents: [
    'AgentMessageDelta',
    'AgentReasoningDelta',
    'AgentReasoningRawContentDelta',
    'AgentMessage',
    'AgentReasoning',
    'AgentReasoningRawContent',
  ],
};
