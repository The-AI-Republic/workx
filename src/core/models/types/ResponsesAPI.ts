// Import types from their respective modules
import type { ResponseItem } from '../../protocol/types';

// Re-export types for consumers
export type { ResponseEvent } from './ResponseEvent';
export type { ResponseItem } from '../../protocol/types';


/**
 * API request payload for Responses API
 */
export interface ResponsesApiRequest {
  model: string;
  instructions: string;
  input: ResponseItem[];
  tools: any[];
  /** Tool selection mode - always "auto" (literal type enforced) */
  tool_choice: "auto";
  /** Whether to allow parallel tool calls - always false (literal type enforced) */
  parallel_tool_calls: false;
  reasoning?: Reasoning;
  store: boolean;
  /** Whether to stream the response - always true (literal type enforced) */
  stream: true;
  include: string[];
  prompt_cache_key?: string;
  text?: TextControls;
}

/**
 * Prompt structure for model requests
 *
 * Contains input messages, tool definitions, and optional configuration overrides.
 *
 * @example
 * ```typescript
 * const prompt: Prompt = {
 *   input: [{ type: 'message', role: 'user', content: 'Hello' }],
 *   tools: [],
 * };
 * const stream = await client.stream(prompt);
 * ```
 */
export interface Prompt {
  /** Conversation context input items */
  input: ResponseItem[];
  /** Tools available to the model */
  tools: ToolSpec[];
  /** Optional override for base instructions */
  base_instructions_override?: string;
  /** Optional user instructions (development guidelines) */
  user_instructions?: string;
  /** Optional output schema for the model's response */
  output_schema?: any;
}

/**
 * Reasoning configuration
 */
export interface Reasoning {
  effort?: ReasoningEffortConfig;
  summary?: ReasoningSummaryConfig;
}

/**
 * Text controls for GPT-5 family models
 */
export interface TextControls {
  verbosity?: OpenAiVerbosity;
  format?: TextFormat;
}

/**
 * Text format configuration
 */
export interface TextFormat {
  type: TextFormatType;
  strict: boolean;
  schema: any;
  name: string;
}

/**
 * Text format types
 */
export type TextFormatType = 'json_schema';

/**
 * OpenAI verbosity levels
 */
export type OpenAiVerbosity = 'low' | 'medium' | 'high';

/**
 * Reasoning effort configuration
 * Placeholder type - should match config types
 */
export type ReasoningEffortConfig = 'low' | 'medium' | 'high';

/**
 * Reasoning summary configuration
 * Placeholder type - should match config types
 */
export type ReasoningSummaryConfig = boolean | { enabled: boolean };

/**
 * Model family information
 */
export interface ModelFamily {
  family: string;
  base_instructions: string;
  supports_reasoning: boolean;
  supports_reasoning_summaries: boolean;
  needs_special_apply_patch_instructions: boolean;
}

/**
 * Model provider information
 */
export interface ModelProviderInfo {
  name: string;
  base_url?: string;
  env_key?: string;
  env_key_instructions?: string;
  wire_api: WireApi;
  query_params?: Record<string, string>;
  http_headers?: Record<string, string>;
  env_http_headers?: Record<string, string>;
  request_max_retries?: number;
  stream_max_retries?: number;
  stream_idle_timeout_ms?: number;
  requires_openai_auth: boolean;
}

/**
 * Wire API types
 */
export type WireApi = 'Responses' | 'Chat';

/**
 * Tool specification discriminated union
 */
export type ToolSpec =
  | { type: 'function'; function: ResponsesApiTool }
  | { type: 'local_shell' }
  | { type: 'web_search' }
  | { type: 'custom'; custom: FreeformTool };

/**
 * Function tool definition for Responses API
 */
export interface ResponsesApiTool {
  name: string;
  description: string;
  strict: boolean;
  parameters: any; // JSON Schema
}

/**
 * Freeform tool definition for custom tools
 */
export interface FreeformTool {
  name: string;
  description: string;
  format: FreeformToolFormat;
}

/**
 * Format specification for freeform tools
 */
export interface FreeformToolFormat {
  type: string;
  syntax: string;
  definition: string;
}

// Type guards are defined in ResponseEvent.ts — do not duplicate here