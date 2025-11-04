/**
 * SSE Event Fixtures
 *
 * These fixtures are used to validate that TypeScript SSE parsing
 * handles all event types correctly.
 */

/**
 * SSE Event: response.created
 * Indicates that a new response has been created
 */
export const SSE_RESPONSE_CREATED = `data: {"type":"response.created","response":{"id":"resp_test_123"}}

`;

/**
 * SSE Event: response.output_item.done
 * Indicates that an output item has been completed
 */
export const SSE_OUTPUT_ITEM_DONE = `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}

`;

export const SSE_OUTPUT_ITEM_DONE_2 = `data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"World"}]}}

`;

/**
 * SSE Event: response.output_text.delta
 * Text delta for streaming output
 */
export const SSE_OUTPUT_TEXT_DELTA = `data: {"type":"response.output_text.delta","delta":"Hello"}

`;

export const SSE_OUTPUT_TEXT_DELTA_CONTINUED = `data: {"type":"response.output_text.delta","delta":" World"}

`;

/**
 * SSE Event: response.reasoning_summary_text.delta
 * Reasoning summary delta for o1/o3 models
 */
export const SSE_REASONING_SUMMARY_DELTA = `data: {"type":"response.reasoning_summary_text.delta","delta":"Analyzing the problem..."}

`;

/**
 * SSE Event: response.reasoning_text.delta
 * Reasoning content delta for o1/o3 models
 */
export const SSE_REASONING_CONTENT_DELTA = `data: {"type":"response.reasoning_text.delta","delta":"Step 1: Consider the constraints"}

`;

/**
 * SSE Event: response.reasoning_summary_part.added
 * Indicates a reasoning summary part was added
 */
export const SSE_REASONING_SUMMARY_PART_ADDED = `data: {"type":"response.reasoning_summary_part.added"}

`;

/**
 * SSE Event: response.output_item.added (web_search)
 * Indicates a web search tool call began
 */
export const SSE_WEB_SEARCH_CALL_BEGIN = `data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"call_abc123"}}

`;

/**
 * SSE Event: response.completed
 * Indicates the response is complete with token usage
 */
export const SSE_RESPONSE_COMPLETED = `data: {"type":"response.completed","response":{"id":"resp_test_123","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":0},"output_tokens":20,"output_tokens_details":{"reasoning_tokens":0},"total_tokens":30}}}

`;

export const SSE_RESPONSE_COMPLETED_NO_USAGE = `data: {"type":"response.completed","response":{"id":"resp_test_456"}}

`;

/**
 * SSE Event: response.failed
 * Indicates the response failed with an error
 */
export const SSE_RESPONSE_FAILED = `data: {"type":"response.failed","response":{"error":{"message":"Test error message","type":"server_error"}}}

`;

/**
 * SSE Event: response.in_progress
 * Progress indicator (ignored in processing)
 */
export const SSE_RESPONSE_IN_PROGRESS = `data: {"type":"response.in_progress"}

`;

/**
 * SSE Event: response.output_text.done
 * Output text complete indicator (ignored in processing)
 */
export const SSE_OUTPUT_TEXT_DONE = `data: {"type":"response.output_text.done"}

`;

/**
 * SSE Event: [DONE] signal
 * Indicates end of SSE stream
 */
export const SSE_DONE_SIGNAL = `data: [DONE]

`;

/**
 * Complete SSE stream example
 */
export const SSE_COMPLETE_STREAM = `data: {"type":"response.created","response":{"id":"resp_001"}}

data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}

data: {"type":"response.output_item.done","item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"World"}]}}

data: {"type":"response.completed","response":{"id":"resp_001","usage":{"input_tokens":15,"output_tokens":10,"total_tokens":25}}}

`;

/**
 * SSE stream with text deltas
 */
export const SSE_TEXT_DELTA_STREAM = `data: {"type":"response.created","response":{"id":"resp_002"}}

data: {"type":"response.output_text.delta","delta":"Hello"}

data: {"type":"response.output_text.delta","delta":" "}

data: {"type":"response.output_text.delta","delta":"from"}

data: {"type":"response.output_text.delta","delta":" "}

data: {"type":"response.output_text.delta","delta":"quickstart"}

data: {"type":"response.output_text.delta","delta":" test"}

data: {"type":"response.completed","response":{"id":"resp_002","usage":{"input_tokens":15,"output_tokens":6,"total_tokens":21}}}

`;

/**
 * SSE stream with reasoning (o1/o3 model)
 */
export const SSE_REASONING_STREAM = `data: {"type":"response.created","response":{"id":"resp_003"}}

data: {"type":"response.reasoning_summary_part.added"}

data: {"type":"response.reasoning_summary_text.delta","delta":"Analyzing"}

data: {"type":"response.reasoning_summary_text.delta","delta":" the"}

data: {"type":"response.reasoning_summary_text.delta","delta":" problem"}

data: {"type":"response.reasoning_text.delta","delta":"Step 1: Break down requirements"}

data: {"type":"response.output_text.delta","delta":"Based on my analysis, "}

data: {"type":"response.output_text.delta","delta":"the answer is 42."}

data: {"type":"response.completed","response":{"id":"resp_003","usage":{"input_tokens":20,"output_tokens":30,"output_tokens_details":{"reasoning_tokens":15},"total_tokens":50}}}

`;

/**
 * SSE stream with web search
 */
export const SSE_WEB_SEARCH_STREAM = `data: {"type":"response.created","response":{"id":"resp_004"}}

data: {"type":"response.output_item.added","item":{"type":"web_search_call","id":"call_search_123"}}

data: {"type":"response.output_text.delta","delta":"I'll search for that information."}

data: {"type":"response.completed","response":{"id":"resp_004","usage":{"input_tokens":25,"output_tokens":8,"total_tokens":33}}}

`;

/**
 * SSE stream that fails
 */
export const SSE_FAILED_STREAM = `data: {"type":"response.created","response":{"id":"resp_005"}}

data: {"type":"response.output_text.delta","delta":"Starting to respond..."}

data: {"type":"response.failed","response":{"error":{"message":"Internal server error occurred","type":"server_error","code":"internal_error"}}}

`;

/**
 * Invalid SSE event (malformed JSON)
 */
export const SSE_INVALID_JSON = `data: {"type":"response.created","response":{"id":INVALID_JSON}}

`;

/**
 * SSE stream with ignored events
 */
export const SSE_WITH_IGNORED_EVENTS = `data: {"type":"response.created","response":{"id":"resp_006"}}

data: {"type":"response.in_progress"}

data: {"type":"response.output_text.delta","delta":"Test"}

data: {"type":"response.output_text.done"}

data: {"type":"response.content_part.done"}

data: {"type":"response.function_call_arguments.delta","delta":"{}"}

data: {"type":"response.completed","response":{"id":"resp_006","usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}

`;

/**
 * Parse SSE event data lines
 * Helper for tests
 */
export function parseSSELine(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('data: ')) {
    return trimmed.slice(6); // Remove 'data: ' prefix
  }
  return null;
}

/**
 * Expected ResponseEvent types for validation
 */
export const EXPECTED_EVENT_TYPES = [
  'Created',
  'OutputItemDone',
  'Completed',
  'OutputTextDelta',
  'ReasoningSummaryDelta',
  'ReasoningContentDelta',
  'ReasoningSummaryPartAdded',
  'WebSearchCallBegin',
  'RateLimits',
] as const;

export type ExpectedEventType = typeof EXPECTED_EVENT_TYPES[number];
