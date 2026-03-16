/**
 * Token Usage Storage Types
 */

export interface TokenUsageRecord {
  id: string;
  sessionId: string;
  taskId: string;
  model: string;
  timestamp: string; // ISO 8601
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  turn_count: number;
}

export interface SessionUsageSummary {
  sessionId: string;
  firstTimestamp: string;
  lastTimestamp: string;
  models: string[];
  taskCount: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  turn_count: number;
}

export interface DailyUsageSummary {
  date: string; // YYYY-MM-DD
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  byModel: Record<string, number>;
}
