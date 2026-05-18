/**
 * Token Usage Storage Types
 */

export interface TokenUsageRecord {
  id: string;
  sessionId: string;
  taskId: string;
  /** Raw model id (back-compat). Provider-ambiguous — see provider_model. */
  model: string;
  /**
   * Track 18: provider-qualified "providerId:modelId" key, the cost-table
   * key. Optional for back-compat with rows written before Track 18.
   */
  provider_model?: string;
  timestamp: string; // ISO 8601
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
  /** Track 18: USD cost for this record. Optional on pre-Track-18 rows. */
  costUSD?: number;
  /** Track 18: true if priced via the fallback rate (unknown model). */
  costEstimated?: boolean;
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
  /** Track 18: summed USD cost across the session's records. */
  costUSD: number;
  /** Track 18: true if any contributing record was estimated. */
  costEstimated: boolean;
  turn_count: number;
}

export interface DailyUsageSummary {
  date: string; // YYYY-MM-DD
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  /** Track 18: summed USD cost for the day. */
  costUSD: number;
  byModel: Record<string, number>;
}
