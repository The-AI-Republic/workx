/**
 * Chat history compaction module
 *
 * Provides LLM-based summarization to compress conversation history
 * when approaching context window limits.
 *
 * @module compact
 */

// Types
export type {
  CompactionConfig,
  CompactionResult,
  CompactedHistory,
  CompactionTrigger,
  UserMessageSelection,
  SummaryRequest,
  SummaryResponse,
} from './types';

// Constants
export {
  SUMMARIZATION_PROMPT,
  SUMMARY_PREFIX,
  NO_SUMMARY_PLACEHOLDER,
  TRUNCATION_MARKER,
  DEFAULT_COMPACTION_CONFIG,
} from './constants';

// Utilities
export {
  approxTokenCount,
  truncateText,
  isSummaryMessage,
  calculateBackoff,
  sleep,
  extractTextFromContent,
} from './utils';

// Services
export { CompactService } from './CompactService';
export { SummaryGenerator } from './SummaryGenerator';
export { HistoryReconstructor } from './HistoryReconstructor';
